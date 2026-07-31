from flask import Blueprint, render_template, jsonify, request, session, redirect, url_for
from functools import wraps
import os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from constants import (
    ROLE_ADMIN, COL_LOOKUPS, DOC_BRANCHES, DOC_SEMESTERS,
    COL_USER_LOGIN, FIELD_USERNAME, FIELD_PASSWORD, FIELD_USER_ID,
    FIELD_USER_ROLE, FIELD_IS_ACTIVE, FIELD_IS_DELETED
)
import uuid
from firebase_init import get_db
from config_loader import (
    get_subject_credits_detailed, upsert_subject_credit, delete_subject_credit,
    get_subject_teachers_all, upsert_subject_teacher, delete_subject_teacher,
)

admin_bp = Blueprint('admin', __name__)


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if 'UserId' not in session:
            # API routes must return JSON, not an HTML redirect
            if request.path.startswith('/api/'):
                return jsonify({'success': False, 'error': 'Not authenticated'}), 401
            return redirect(url_for('home'))
        if session.get('UserRole') != ROLE_ADMIN:
            return jsonify({'success': False, 'error': 'Admin access required'}), 403
        return view(*args, **kwargs)
    return wrapped


@admin_bp.route('/admin/subjects')
@admin_required
def admin_subjects_page():
    return render_template('admin_subjects.html', user_name=session.get('UserName', ''))


@admin_bp.route('/admin/teachers')
@admin_required
def admin_teachers_page():
    return render_template('admin_teachers.html', user_name=session.get('UserName', ''))


@admin_bp.route('/admin/users')
@admin_required
def admin_users_page():
    return render_template('admin_users.html', user_name=session.get('UserName', ''))



@admin_bp.route('/api/admin/lookups', methods=['GET'])
@admin_required
def admin_lookups():
    """Returns branches and semesters from the lookups collection for admin dropdowns.
    Falls back to the branch map seeds so dropdowns are never empty."""
    from config_loader import get_branch_map
    try:
        branches_doc  = get_db().collection(COL_LOOKUPS).document(DOC_BRANCHES).get()
        semesters_doc = get_db().collection(COL_LOOKUPS).document(DOC_SEMESTERS).get()

        # Use stored lookups if they exist; otherwise seed from the branch map
        branches = sorted(branches_doc.to_dict().get('values', [])) if branches_doc.exists else []
        semesters = sorted(semesters_doc.to_dict().get('values', [])) if semesters_doc.exists else []

        # If no results saved yet, provide sensible defaults from branch map
        if not branches:
            branches = sorted(set(get_branch_map().values()))
        if not semesters:
            semesters = ['SEM1', 'SEM2', 'SEM3', 'SEM4', 'SEM5', 'SEM6', 'SEM7', 'SEM8']

        return jsonify({
            'success':   True,
            'branches':  branches,
            'semesters': semesters,
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@admin_bp.route('/api/admin/subjects', methods=['GET'])
@admin_required
def list_subjects():
    try:
        detailed = get_subject_credits_detailed()
        rows = [{'code': code, 'credit': rec.get('credit', 0),
                 'externalRequired': rec.get('externalRequired', True)}
                for code, rec in detailed.items()]
        rows.sort(key=lambda r: r['code'])
        return jsonify({'success': True, 'subjects': rows})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@admin_bp.route('/api/admin/subjects', methods=['POST'])
@admin_required
def upsert_subject():
    data = request.get_json(silent=True) or {}
    code = (data.get('code') or '').strip()
    name = (data.get('name') or '').strip()
    credit_raw = data.get('credit')
    # Admin form always sends this explicitly (checked/unchecked), so we
    # pass it through as a real bool rather than None — None is reserved
    # for the auto-upsert-on-save call, which should never touch this flag.
    external_required = bool(data.get('externalRequired', True))

    # credit=0 is a valid value (e.g. a non-credit/audit subject) — check
    # for missing/blank input explicitly rather than `not credit_raw`,
    # since that would also reject a legitimate "0".
    if not code or credit_raw is None or str(credit_raw).strip() == '':
        return jsonify({'success': False, 'error': 'code and credit are both required'}), 400
    try:
        credit = int(credit_raw)
        if credit < 0 or credit > 4:
            return jsonify({'success': False, 'error': 'Credit must be between 0 and 4'}), 400
    except ValueError:
        return jsonify({'success': False, 'error': 'Credit must be a number'}), 400

    try:
        upsert_subject_credit(code, name, credit, external_required)
        return jsonify({'success': True, 'message': f'{code.upper()} saved.'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@admin_bp.route('/api/admin/subjects/<code>', methods=['DELETE'])
@admin_required
def remove_subject(code):
    try:
        delete_subject_credit(code)
        return jsonify({'success': True, 'message': f'{code.upper()} removed.'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ── Teacher assignments ───────────────────────────────────────────────────────

@admin_bp.route('/api/admin/teachers', methods=['GET'])
@admin_required
def list_teachers():
    try:
        all_t = get_subject_teachers_all()
        rows = list(all_t.values())
        rows.sort(key=lambda r: (r.get('branch', ''), r.get('semester', ''), r.get('code', '')))
        return jsonify({'success': True, 'teachers': rows})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@admin_bp.route('/api/admin/teachers', methods=['POST'])
@admin_required
def upsert_teacher():
    data = request.get_json(silent=True) or {}
    branch   = (data.get('branch')   or '').strip()
    semester = (data.get('semester') or '').strip()
    code     = (data.get('code')     or '').strip().upper()
    teacher  = (data.get('teacher')  or '').strip()

    if not branch or not semester or not code or not teacher:
        return jsonify({'success': False,
                        'error': 'branch, semester, subject code and teacher name are all required'}), 400
    try:
        upsert_subject_teacher(branch, semester, code, teacher)
        return jsonify({'success': True, 'message': f'{code} teacher saved.'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@admin_bp.route('/api/admin/teachers/delete', methods=['DELETE'])
@admin_required
def remove_teacher():
    """Delete a teacher assignment using query params to avoid URL encoding issues."""
    branch   = request.args.get('branch',   '').strip()
    semester = request.args.get('semester', '').strip()
    code     = request.args.get('code',     '').strip().upper()

    if not branch or not semester or not code:
        return jsonify({'success': False,
                        'error': 'branch, semester and code are required'}), 400
    try:
        delete_subject_teacher(branch, semester, code)
        return jsonify({'success': True, 'message': f'{code} teacher removed.'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ── User Management ───────────────────────────────────────────────────────────

@admin_bp.route('/api/admin/users', methods=['GET'])
@admin_required
def list_users():
    try:
        db = get_db()
        users_ref = db.collection(COL_USER_LOGIN)
        query = users_ref.where('IsDeleted', '==', False).stream()
        
        users = []
        for doc in query:
            data = doc.to_dict()
            users.append({
                'UserId': data.get(FIELD_USER_ID, ''),
                'UserName': data.get(FIELD_USERNAME, ''),
                'UserRole': data.get(FIELD_USER_ROLE, ''),
                'IsActive': data.get(FIELD_IS_ACTIVE, False)
            })
            
        # Sort users alphabetically by username
        users.sort(key=lambda x: x['UserName'].lower())
        
        return jsonify({'success': True, 'users': users})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@admin_bp.route('/api/admin/users', methods=['POST'])
@admin_required
def add_user():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    role = (data.get('role') or 'ResultAnalysis').strip()
    
    if not username or not password:
        return jsonify({'success': False, 'error': 'Username and password are required.'}), 400
        
    try:
        db = get_db()
        # Check if username already exists (active or inactive, but not deleted)
        existing_users = db.collection(COL_USER_LOGIN)\
            .where(FIELD_USERNAME, '==', username)\
            .where('IsDeleted', '==', False)\
            .stream()
            
        for _ in existing_users:
            return jsonify({'success': False, 'error': 'Username already exists.'}), 409
            
        user_id = str(uuid.uuid4())
        
        user_data = {
            FIELD_USER_ID: user_id,
            FIELD_USERNAME: username,
            FIELD_PASSWORD: password,
            FIELD_USER_ROLE: role,
            FIELD_IS_ACTIVE: True,
            FIELD_IS_DELETED: False
        }
        
        # Use user_id as the document ID for cleaner structure
        db.collection(COL_USER_LOGIN).document(user_id).set(user_data)
        
        return jsonify({'success': True, 'message': f'User {username} added successfully.'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@admin_bp.route('/api/admin/users/delete', methods=['DELETE'])
@admin_required
def delete_user():
    user_id = request.args.get('userId', '').strip()
    
    if not user_id:
        return jsonify({'success': False, 'error': 'User ID is required.'}), 400
        
    # Prevent self-deletion
    if user_id == session.get('UserId'):
        return jsonify({'success': False, 'error': 'You cannot delete your own account.'}), 403
        
    try:
        db = get_db()
        # Find user by ID
        user_ref = db.collection(COL_USER_LOGIN).document(user_id)
        doc = user_ref.get()
        
        if not doc.exists:
            # Maybe it wasn't saved with user_id as doc ID, so query by field
            query = db.collection(COL_USER_LOGIN).where(FIELD_USER_ID, '==', user_id).stream()
            docs = list(query)
            if not docs:
                return jsonify({'success': False, 'error': 'User not found.'}), 404
            user_ref = docs[0].reference
            
        # Soft delete
        user_ref.update({
            FIELD_IS_DELETED: True,
            FIELD_IS_ACTIVE: False
        })
        
        return jsonify({'success': True, 'message': 'User removed successfully.'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500