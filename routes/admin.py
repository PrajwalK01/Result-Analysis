from flask import Blueprint, render_template, jsonify, request, session, redirect, url_for
from functools import wraps
import os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from constants import ROLE_ADMIN, COL_LOOKUPS, DOC_BRANCHES, DOC_SEMESTERS
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
        rows = [{'code': code, 'name': rec.get('name', ''), 'credit': rec.get('credit', 0)}
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
    credit = data.get('credit')

    if not code or not name or not credit:
        return jsonify({'success': False, 'error': 'code, name and credit are all required'}), 400
    try:
        credit = int(credit)
        if credit <= 0 or credit > 10:
            return jsonify({'success': False, 'error': 'Credit must be between 1 and 10'}), 400
    except ValueError:
        return jsonify({'success': False, 'error': 'Credit must be a number'}), 400

    try:
        upsert_subject_credit(code, name, credit)
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


@admin_bp.route('/api/admin/teachers/<path:key>', methods=['DELETE'])
@admin_required
def remove_teacher(key):
    # key is "BRANCH||SEM||CODE"
    try:
        parts = key.split('||')
        if len(parts) != 3:
            return jsonify({'success': False, 'error': 'Invalid key format'}), 400
        branch, semester, code = parts
        delete_subject_teacher(branch, semester, code)
        return jsonify({'success': True, 'message': f'{code} teacher removed.'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
