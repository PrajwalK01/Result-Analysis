"""
Creator blueprint — platform-owner routes for onboarding new colleges.

The Creator role:
  - Is NOT scoped to any college.
  - Can onboard a new college (validate slug, write Colleges/{code} doc,
    generate first SuperAdmin credential).
  - Can list and suspend/reactivate colleges.
  - MUST NEVER be able to read result data, subject configs, or per-college
    audit logs.
"""

import re
from functools import wraps

from flask import Blueprint, jsonify, render_template, request, session, redirect, url_for
from firebase_admin import firestore

import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from firebase_init import get_db
from constants import (
    ROLE_CREATOR, ROLE_SUPER_ADMIN,
    COL_USER_LOGIN, COL_COLLEGES, COL_AUDIT_LOGS,
    FIELD_USERNAME, FIELD_PASSWORD, FIELD_USER_ID,
    FIELD_USER_ROLE, FIELD_IS_ACTIVE, FIELD_IS_DELETED,
    FIELD_COLLEGE, FIELD_COLLEGE_NAME, FIELD_COLLEGE_STATUS,
    FIELD_CREATED_AT, FIELD_SAVED_BY,
)

creator_bp = Blueprint('creator', __name__)

# College code must be a lowercase alphanumeric slug, 2–12 characters.
_COLLEGE_CODE_RE = re.compile(r'^[a-z0-9]{2,12}$')

# ── Decorator ────────────────────────────────────────────────────────────────

def creator_required(view):
    """Restrict route to Creator role only."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if 'UserId' not in session:
            if request.path.startswith('/api/'):
                return jsonify({'success': False, 'error': 'Not authenticated'}), 401
            return redirect(url_for('home'))
        if session.get('UserRole') != ROLE_CREATOR:
            if request.path.startswith('/api/'):
                return jsonify({'success': False, 'error': 'Creator access required'}), 403
            return redirect(url_for('home'))
        return view(*args, **kwargs)
    return wrapped


# ── Helpers ───────────────────────────────────────────────────────────────────

def _generate_super_admin_id(db, college: str) -> str:
    """Generate college-scoped SuperAdmin user ID: {college}-SA-00001"""
    prefix = f'{college}-SA'
    docs = list(
        db.collection(COL_USER_LOGIN)
          .where(FIELD_COLLEGE, '==', college)
          .stream()
    )
    ids = []
    for doc in docs:
        doc_id = doc.id or ''
        if doc_id.startswith(f'{prefix}-'):
            try:
                ids.append(int(doc_id.split('-')[-1]))
            except ValueError:
                continue
    next_num = max(ids) + 1 if ids else 1
    return f'{prefix}-{next_num:05d}'


# ── Pages ─────────────────────────────────────────────────────────────────────

@creator_bp.route('/creator')
@creator_required
def creator_page():
    return render_template('creator.html', user_name=session.get('UserName', ''))


# ── API: List colleges ────────────────────────────────────────────────────────

@creator_bp.route('/api/creator/colleges', methods=['GET'])
@creator_required
def list_colleges():
    try:
        db = get_db()
        colleges = []
        for doc in db.collection(COL_COLLEGES).stream():
            data = doc.to_dict() or {}
            colleges.append({
                'code':        doc.id,
                'name':        data.get(FIELD_COLLEGE_NAME, ''),
                'status':      data.get(FIELD_COLLEGE_STATUS, 'Active'),
                'createdAt':   str(data.get(FIELD_CREATED_AT, '')),
                'createdBy':   data.get('createdBy', ''),
            })
        colleges.sort(key=lambda c: c['name'].lower())
        return jsonify({'success': True, 'colleges': colleges})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ── API: Onboard a new college ────────────────────────────────────────────────

@creator_bp.route('/api/creator/colleges', methods=['POST'])
@creator_required
def create_college():
    """
    Body: {
        "collegeCode": "rv",
        "collegeName": "RV College of Engineering",
        "saUsername":  "rv_superadmin",
        "saPassword":  "chosen_password"
    }

    1. Validates the slug pattern.
    2. Checks uniqueness against Colleges/.
    3. Creates Colleges/{code} doc.
    4. Creates first SuperAdmin UserLogin doc with the Creator-supplied password.
    5. Returns confirmation (password is NOT echoed back).
    """
    data         = request.get_json(silent=True) or {}
    raw_code     = (data.get('collegeCode')  or '').strip().lower()
    college_name = (data.get('collegeName')  or '').strip()
    sa_username  = (data.get('saUsername')   or '').strip()
    sa_password  = (data.get('saPassword')   or '')

    # Validate slug
    if not _COLLEGE_CODE_RE.match(raw_code):
        return jsonify({
            'success': False,
            'error':   'College code must be 2–12 lowercase letters/digits (e.g. "rv", "jvit").'
        }), 400

    if not college_name:
        return jsonify({'success': False, 'error': 'College name is required.'}), 400

    if not sa_username:
        return jsonify({'success': False, 'error': 'SuperAdmin username is required.'}), 400

    if not sa_password or len(sa_password) < 6:
        return jsonify({'success': False,
                        'error': 'SuperAdmin password must be at least 6 characters.'}), 400

    try:
        db = get_db()

        # Check college code uniqueness
        existing = db.collection(COL_COLLEGES).document(raw_code).get()
        if existing.exists:
            return jsonify({'success': False,
                            'error': f'College code "{raw_code}" is already taken.'}), 409

        # Write Colleges/{code}
        db.collection(COL_COLLEGES).document(raw_code).set({
            FIELD_COLLEGE_NAME:   college_name,
            FIELD_COLLEGE_STATUS: 'Active',
            FIELD_CREATED_AT:     firestore.SERVER_TIMESTAMP,
            'createdBy':          session.get('UserId', ''),
        })

        # Create first SuperAdmin with Creator-supplied credentials
        sa_id = _generate_super_admin_id(db, raw_code)

        db.collection(COL_USER_LOGIN).document(sa_id).set({
            FIELD_USER_ID:    sa_id,
            FIELD_USERNAME:   sa_username,
            FIELD_PASSWORD:   sa_password,
            FIELD_USER_ROLE:  ROLE_SUPER_ADMIN,
            FIELD_IS_ACTIVE:  True,
            FIELD_IS_DELETED: False,
            FIELD_COLLEGE:    raw_code,
            FIELD_SAVED_BY:   session.get('UserId', ''),
            FIELD_CREATED_AT: firestore.SERVER_TIMESTAMP,
        })

        # Audit entry (college-neutral, actor is Creator)
        db.collection(COL_AUDIT_LOGS).add({
            'Action':        'OnboardCollege',
            'TargetType':    'College',
            'TargetId':      raw_code,
            'Details':       {'collegeName': college_name, 'superAdminId': sa_id,
                              'superAdminUsername': sa_username},
            'ActorUserId':   session.get('UserId', ''),
            'ActorUserName': session.get('UserName', ''),
            'ActorRole':     ROLE_CREATOR,
            FIELD_COLLEGE:   '',
            FIELD_CREATED_AT: firestore.SERVER_TIMESTAMP,
        })

        return jsonify({
            'success':     True,
            'message':     f'College "{college_name}" onboarded.',
            'collegeCode': raw_code,
            'superAdmin': {
                'userId':   sa_id,
                'username': sa_username,
                # Password is NOT returned — Creator already knows it
            },
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ── API: Suspend / reactivate a college ──────────────────────────────────────

@creator_bp.route('/api/creator/colleges/<code>', methods=['PATCH'])
@creator_required
def update_college_status(code):
    """
    Body: { "status": "Suspended" }  or  { "status": "Active" }
    Only the Status field is mutable via this endpoint.
    College data is never deleted through the Creator API.
    """
    data   = request.get_json(silent=True) or {}
    status = (data.get('status') or '').strip()

    if status not in {'Active', 'Suspended'}:
        return jsonify({'success': False,
                        'error': 'status must be "Active" or "Suspended".'}), 400

    try:
        db  = get_db()
        ref = db.collection(COL_COLLEGES).document(code)
        if not ref.get().exists:
            return jsonify({'success': False, 'error': 'College not found.'}), 404

        ref.update({FIELD_COLLEGE_STATUS: status})

        db.collection(COL_AUDIT_LOGS).add({
            'Action':        'UpdateCollegeStatus',
            'TargetType':    'College',
            'TargetId':      code,
            'Details':       {'newStatus': status},
            'ActorUserId':   session.get('UserId', ''),
            'ActorUserName': session.get('UserName', ''),
            'ActorRole':     ROLE_CREATOR,
            FIELD_COLLEGE:   '',
            FIELD_CREATED_AT: firestore.SERVER_TIMESTAMP,
        })

        return jsonify({'success': True,
                        'message': f'College "{code}" set to {status}.'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
