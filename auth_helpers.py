"""
Shared authentication helpers for multi-tenant scoping.
Import current_college() in any route file that needs the active college slug.
"""

from flask import session, jsonify, request
from functools import wraps
from constants import ROLE_CREATOR


def current_college() -> str:
    """Return the college slug for the currently logged-in user.
    Creator accounts have no college — returns '' for them.
    For all other roles, raises HTTP 401 if College is missing from session.
    """
    role = session.get('UserRole', '')
    if role == ROLE_CREATOR:
        return ''
    college = session.get('College', '')
    if not college:
        # This is a programming error — should not reach here in normal flow.
        # Callers that don't want an exception should check session directly.
        from flask import abort
        abort(401)
    return college
