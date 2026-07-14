from flask import Blueprint, request, jsonify, render_template, session, redirect, url_for
import time, os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from firebase_init       import get_db
from firebase_admin.firestore import FieldFilter
from constants           import (
    COL_USER_LOGIN,
    FIELD_USERNAME, FIELD_PASSWORD, FIELD_USER_ID,
    FIELD_USER_ROLE, FIELD_IS_ACTIVE, FIELD_IS_DELETED,
    ROLE_ADMIN,
)
from config_loader import get_app_settings

login_bp = Blueprint("login", __name__)

# ── Brute-force throttle (settings from DB / env) ────────────────────────────
_failed_attempts: dict = {}

def _settings():
    """Load lockout settings from DB config (cached)."""
    s = get_app_settings()
    return (
        int(os.environ.get("LOGIN_MAX_ATTEMPTS", s.get("maxAttempts",  5))),
        int(os.environ.get("LOGIN_LOCKOUT_SECS", s.get("lockoutSecs", 300))),
        s.get("allowedRole", "ResultAnalysis"),
    )

def _is_locked_out(username: str):
    max_attempts, lockout_secs, _ = _settings()
    now   = time.time()
    times = [t for t in _failed_attempts.get(username, []) if now - t < lockout_secs]
    _failed_attempts[username] = times
    if len(times) >= max_attempts:
        remaining = int(lockout_secs - (now - min(times)))
        return True, max(remaining, 1)
    return False, 0

def _record_failure(username: str):
    _failed_attempts.setdefault(username, []).append(time.time())

def _clear_failures(username: str):
    _failed_attempts.pop(username, None)


# ─────────────────────────────────────────────────────────────────────────────

@login_bp.route("/login", methods=["POST"])
def login():
    data     = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not username or not password:
        return jsonify({"success": False, "message": "Username and password are required."}), 400
    if len(username) > 64 or len(password) > 128:
        return jsonify({"success": False, "message": "Invalid input length."}), 400

    locked, secs = _is_locked_out(username)
    if locked:
        mins = (secs + 59) // 60
        return jsonify({"success": False,
                        "message": f"Too many failed attempts. Account locked for {mins} minute(s)."}), 429

    max_attempts, _, allowed_role = _settings()

    try:
        db    = get_db()
        query = (
            db.collection(COL_USER_LOGIN)
            .where(filter=FieldFilter(FIELD_USERNAME, "==", username))
            .where(filter=FieldFilter(FIELD_IS_ACTIVE, "==", True))
            .stream()
        )

        user = None
        for doc in query:
            candidate = doc.to_dict()
            if candidate.get(FIELD_IS_DELETED) is False:
                user = candidate
                break

        if not user or user.get(FIELD_PASSWORD) != password:
            _record_failure(username)
            left = max_attempts - len(_failed_attempts.get(username, []))
            msg  = "Invalid username or password."
            if left <= 2:
                msg += f" {max(left, 0)} attempt(s) remaining before lockout."
            return jsonify({"success": False, "message": msg}), 401

        user_role = user.get(FIELD_USER_ROLE)
        if user_role != allowed_role and user_role != ROLE_ADMIN:
            return jsonify({"success": False,
                            "message": "Access denied. Insufficient privileges."}), 403

        _clear_failures(username)
        session.permanent      = True
        session["UserId"]      = user[FIELD_USER_ID]
        session["UserName"]    = user[FIELD_USERNAME]
        session["UserRole"]    = user.get(FIELD_USER_ROLE, "")

        return jsonify({"success": True, "message": "Login successful.",
                        "UserId": user[FIELD_USER_ID], "UserName": user[FIELD_USERNAME]})

    except Exception as e:
        return jsonify({"success": False, "message": "A server error occurred."}), 500


@login_bp.route("/user")
def user_page():
    if "UserId" not in session:
        return redirect(url_for("home"))
    return render_template("user.html",
                            user_name=session.get("UserName", ""),
                            is_admin=(session.get("UserRole") == "Admin"))


@login_bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("home"))
