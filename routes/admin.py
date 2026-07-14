from flask import Blueprint, render_template, jsonify, request, session, redirect, url_for
from functools import wraps
import os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from constants import ROLE_ADMIN
from config_loader import (
    get_subject_credits_detailed, upsert_subject_credit, delete_subject_credit,
)

admin_bp = Blueprint('admin', __name__)


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if 'UserId' not in session:
            return redirect(url_for('home'))
        if session.get('UserRole') != ROLE_ADMIN:
            return jsonify({'success': False, 'error': 'Admin access required'}), 403
        return view(*args, **kwargs)
    return wrapped


@admin_bp.route('/admin/subjects')
@admin_required
def admin_subjects_page():
    return render_template('admin_subjects.html', user_name=session.get('UserName', ''))


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
