from flask import Blueprint, render_template, jsonify, request, session, redirect, url_for
from functools import wraps
import os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from constants import (
    ROLE_ADMIN, ROLE_SUPER_ADMIN, ROLE_RESULT_ANALYSIS,
    COL_LOOKUPS, DOC_BRANCHES, DOC_SEMESTERS,
    COL_USER_LOGIN, COL_AUDIT_LOGS,
    FIELD_USERNAME, FIELD_PASSWORD, FIELD_USER_ID,
    FIELD_USER_ROLE, FIELD_IS_ACTIVE, FIELD_IS_DELETED,
    FIELD_ACTION, FIELD_TARGET_TYPE, FIELD_TARGET_ID, FIELD_DETAILS,
    FIELD_CREATED_AT, FIELD_DELETED_AT, FIELD_DELETED_BY,
    FIELD_SAVED_BY
)
import uuid
from firebase_init import get_db
from config_loader import (
    get_subject_credits_detailed, upsert_subject_credit, delete_subject_credit,
    get_subject_teachers_all, upsert_subject_teacher, delete_subject_teacher,
)

admin_bp = Blueprint('admin', __name__)


def _is_admin_session():
    return session.get('UserRole') in {ROLE_ADMIN, ROLE_SUPER_ADMIN}


def _generate_user_id(db, role):
    prefix = 'SA' if role == ROLE_SUPER_ADMIN else 'U'
    docs = list(db.collection(COL_USER_LOGIN).stream())
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


def _log_audit(db, action, target_type, target_id, details, actor_user_id=None, actor_user_name=None, actor_role=None):
    try:
        db.collection(COL_AUDIT_LOGS).add({
            FIELD_ACTION: action,
            FIELD_TARGET_TYPE: target_type,
            FIELD_TARGET_ID: target_id,
            FIELD_DETAILS: details,
            'ActorUserId': actor_user_id or '',
            'ActorUserName': actor_user_name or '',
            'ActorRole': actor_role or '',
            FIELD_CREATED_AT: __import__('firebase_admin').firestore.SERVER_TIMESTAMP,
        })
    except Exception:
        pass


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if 'UserId' not in session:
            if request.path.startswith('/api/'):
                return jsonify({'success': False, 'error': 'Not authenticated'}), 401
            return redirect(url_for('home'))
        if not _is_admin_session():
            if request.path.startswith('/api/'):
                return jsonify({'success': False, 'error': 'Admin access required'}), 403
            return redirect(url_for('home'))
        return view(*args, **kwargs)
    return wrapped


def super_admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if 'UserId' not in session:
            if request.path.startswith('/api/'):
                return jsonify({'success': False, 'error': 'Not authenticated'}), 401
            return redirect(url_for('home'))
        if session.get('UserRole') != ROLE_SUPER_ADMIN:
            if request.path.startswith('/api/'):
                return jsonify({'success': False, 'error': 'Super Admin access required'}), 403
            return redirect(url_for('home'))
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
@super_admin_required
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
@super_admin_required
def list_users():
    try:
        db = get_db()
        users_ref = db.collection(COL_USER_LOGIN)
        query = users_ref.where('IsDeleted', '==', False).stream()

        users = []
        for doc in query:
            data = doc.to_dict()
            users.append({
                'UserId': data.get(FIELD_USER_ID, doc.id),
                'UserName': data.get(FIELD_USERNAME, ''),
                'UserRole': data.get(FIELD_USER_ROLE, ''),
                'IsActive': data.get(FIELD_IS_ACTIVE, False)
            })

        users.sort(key=lambda x: x['UserName'].lower())

        return jsonify({'success': True, 'users': users})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@admin_bp.route('/api/admin/users', methods=['POST'])
@super_admin_required
def add_user():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    role = (data.get('role') or ROLE_RESULT_ANALYSIS).strip()

    if not username or not password:
        return jsonify({'success': False, 'error': 'Username and password are required.'}), 400

    if role not in {ROLE_RESULT_ANALYSIS, ROLE_ADMIN, ROLE_SUPER_ADMIN}:
        return jsonify({'success': False, 'error': 'Invalid role.'}), 400

    try:
        db = get_db()
        existing_users = db.collection(COL_USER_LOGIN)\
            .where(FIELD_USERNAME, '==', username)\
            .where('IsDeleted', '==', False)\
            .stream()

        for _ in existing_users:
            return jsonify({'success': False, 'error': 'Username already exists.'}), 409

        user_id = _generate_user_id(db, role)
        user_data = {
            FIELD_USER_ID: user_id,
            FIELD_USERNAME: username,
            FIELD_PASSWORD: password,
            FIELD_USER_ROLE: role,
            FIELD_IS_ACTIVE: True,
            FIELD_IS_DELETED: False,
            FIELD_SAVED_BY: session.get('UserId', ''),
        }

        db.collection(COL_USER_LOGIN).document(user_id).set(user_data)
        _log_audit(
            db, 'CreateUser', 'UserLogin', user_id,
            {'username': username, 'role': role},
            actor_user_id=session.get('UserId', ''),
            actor_user_name=session.get('UserName', ''),
            actor_role=session.get('UserRole', '')
        )

        return jsonify({'success': True, 'message': f'User {username} added successfully with ID {user_id}.'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@admin_bp.route('/api/admin/users/delete', methods=['DELETE'])
@super_admin_required
def delete_user():
    user_id = request.args.get('userId', '').strip()

    if not user_id:
        return jsonify({'success': False, 'error': 'User ID is required.'}), 400

    if user_id == session.get('UserId'):
        return jsonify({'success': False, 'error': 'You cannot delete your own account.'}), 403

    try:
        db = get_db()
        user_ref = db.collection(COL_USER_LOGIN).document(user_id)
        doc = user_ref.get()

        if not doc.exists:
            query = db.collection(COL_USER_LOGIN).where(FIELD_USER_ID, '==', user_id).stream()
            docs = list(query)
            if not docs:
                return jsonify({'success': False, 'error': 'User not found.'}), 404
            user_ref = docs[0].reference

        user_ref.update({
            FIELD_IS_DELETED: True,
            FIELD_IS_ACTIVE: False,
            FIELD_DELETED_AT: __import__('firebase_admin').firestore.SERVER_TIMESTAMP,
            FIELD_DELETED_BY: session.get('UserId', ''),
        })

        return jsonify({'success': True, 'message': 'User removed successfully.'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@admin_bp.route('/api/admin/audit-logs', methods=['GET'])
@super_admin_required
def list_audit_logs():
    try:
        db = get_db()
        logs = []
        for doc in db.collection(COL_AUDIT_LOGS).stream():
            data = doc.to_dict()
            logs.append({
                'id': doc.id,
                'Action': data.get(FIELD_ACTION, ''),
                'TargetType': data.get(FIELD_TARGET_TYPE, ''),
                'TargetId': data.get(FIELD_TARGET_ID, ''),
                'Details': data.get(FIELD_DETAILS, {}),
                'ActorUserName': data.get('ActorUserName', ''),
                'ActorRole': data.get('ActorRole', ''),
                'createdAt': data.get(FIELD_CREATED_AT),
            })
        logs.sort(key=lambda x: str(x.get('createdAt') or ''), reverse=True)
        return jsonify({'success': True, 'logs': logs})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500