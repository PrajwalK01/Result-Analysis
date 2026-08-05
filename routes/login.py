from flask import Blueprint, request, jsonify, render_template, session, redirect, url_for
import time, os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from firebase_init       import get_db
from firebase_admin.firestore import FieldFilter
from constants           import (
    COL_USER_LOGIN,
    FIELD_USERNAME, FIELD_PASSWORD, FIELD_USER_ID,
    FIELD_USER_ROLE, FIELD_IS_ACTIVE, FIELD_IS_DELETED,
    FIELD_COLLEGE,
    ROLE_ADMIN, ROLE_SUPER_ADMIN, ROLE_CREATOR,
)
from config_loader import get_app_settings

login_bp = Blueprint("login", __name__)

# ── Brute-force throttle (settings from DB / env) ────────────────────────────
# Key format:  "{college}:{username}"  — prevents cross-college lockout bleed.
# Creator (no college) uses ":creator:{username}".
_failed_attempts: dict = {}


def _settings():
    """Load lockout settings from DB config (cached)."""
    s = get_app_settings()
    return (
        int(os.environ.get("LOGIN_MAX_ATTEMPTS", s.get("maxAttempts",  5))),
        int(os.environ.get("LOGIN_LOCKOUT_SECS", s.get("lockoutSecs", 300))),
        s.get("allowedRole", "ResultAnalysis"),
    )


def _lockout_key(college: str, username: str) -> str:
    """Unique per-college:username key to prevent cross-college bleed."""
    prefix = college.lower() if college else ":creator"
    return f"{prefix}:{username.lower()}"


def _is_locked_out(college: str, username: str):
    max_attempts, lockout_secs, _ = _settings()
    now   = time.time()
    key   = _lockout_key(college, username)
    times = [t for t in _failed_attempts.get(key, []) if now - t < lockout_secs]
    _failed_attempts[key] = times
    if len(times) >= max_attempts:
        remaining = int(lockout_secs - (now - min(times)))
        return True, max(remaining, 1)
    return False, 0


def _record_failure(college: str, username: str):
    key = _lockout_key(college, username)
    _failed_attempts.setdefault(key, []).append(time.time())


def _clear_failures(college: str, username: str):
    key = _lockout_key(college, username)
    _failed_attempts.pop(key, None)


# ─────────────────────────────────────────────────────────────────────────────

@login_bp.route("/login", methods=["POST"])
def login():
    data     = request.get_json(silent=True) or {}
    college  = (data.get("college")  or "").strip().lower()
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not username or not password:
        return jsonify({"success": False, "message": "Username and password are required."}), 400
    if len(username) > 64 or len(password) > 128:
        return jsonify({"success": False, "message": "Invalid input length."}), 400

    locked, secs = _is_locked_out(college, username)
    if locked:
        mins = (secs + 59) // 60
        return jsonify({"success": False,
                        "message": f"Too many failed attempts. Account locked for {mins} minute(s)."}), 429

    max_attempts, _, allowed_role = _settings()

    try:
        db = get_db()

        # Creator has no college — special-case query (no College filter)
        # We first check without college filter if no college submitted,
        # then verify the role is Creator.
        if not college:
            # Attempt Creator login (no college in payload)
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

            # Only allow Creator role when no college is submitted
            if user and user.get(FIELD_USER_ROLE) == ROLE_CREATOR:
                if user.get(FIELD_PASSWORD) != password:
                    _record_failure(college, username)
                    left = max_attempts - len(_failed_attempts.get(_lockout_key(college, username), []))
                    msg  = "Invalid username or password."
                    if left <= 2:
                        msg += f" {max(left, 0)} attempt(s) remaining before lockout."
                    return jsonify({"success": False, "message": msg}), 401

                _clear_failures(college, username)
                session.permanent   = True
                session["UserId"]   = user[FIELD_USER_ID]
                session["UserName"] = user[FIELD_USERNAME]
                session["UserRole"] = ROLE_CREATOR
                # Creator has no College in session
                return jsonify({"success": True, "message": "Login successful.",
                                "UserId": user[FIELD_USER_ID], "UserName": user[FIELD_USERNAME],
                                "UserRole": ROLE_CREATOR})

            # If no college given and no Creator found, require college field
            return jsonify({"success": False,
                            "message": "College code is required for this account."}), 400

        # Normal college-scoped login
        query = (
            db.collection(COL_USER_LOGIN)
            .where(filter=FieldFilter(FIELD_COLLEGE,   "==", college))
            .where(filter=FieldFilter(FIELD_USERNAME,  "==", username))
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
            _record_failure(college, username)
            left = max_attempts - len(_failed_attempts.get(_lockout_key(college, username), []))
            msg  = "Invalid college code, username, or password."
            if left <= 2:
                msg += f" {max(left, 0)} attempt(s) remaining before lockout."
            return jsonify({"success": False, "message": msg}), 401

        user_role = user.get(FIELD_USER_ROLE)
        # Creator must never log in via the college path
        if user_role == ROLE_CREATOR:
            return jsonify({"success": False,
                            "message": "Invalid college code, username, or password."}), 401
        if user_role != allowed_role and user_role not in {ROLE_ADMIN, ROLE_SUPER_ADMIN}:
            return jsonify({"success": False,
                            "message": "Access denied. Insufficient privileges."}), 403

        _clear_failures(college, username)
        session.permanent      = True
        session["UserId"]      = user[FIELD_USER_ID]
        session["UserName"]    = user[FIELD_USERNAME]
        session["UserRole"]    = user.get(FIELD_USER_ROLE, "")
        session["College"]     = user.get(FIELD_COLLEGE, college)

        return jsonify({"success": True, "message": "Login successful.",
                        "UserId": user[FIELD_USER_ID], "UserName": user[FIELD_USERNAME]})

    except Exception as e:
        return jsonify({"success": False, "message": "A server error occurred."}), 500


@login_bp.route("/user")
def user_page():
    if "UserId" not in session:
        return redirect(url_for("home"))
    # Creator → creator dashboard
    if session.get("UserRole") == ROLE_CREATOR:
        return redirect(url_for("creator.creator_page"))
    # SuperAdmin → dedicated SuperAdmin dashboard
    if session.get("UserRole") == ROLE_SUPER_ADMIN:
        return redirect(url_for("admin.superadmin_dashboard"))
    return render_template("user.html",
                            user_name=session.get("UserName", ""),
                            is_admin=(session.get("UserRole") in {"Admin", "SuperAdmin"}))


@login_bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("home"))
