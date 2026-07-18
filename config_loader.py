"""
Loads application configuration from Firestore config/ collection.
Falls back to constants.py defaults if a document is missing.
Results are cached in-process for the lifetime of the request worker.
Call invalidate_cache() to force a reload.
"""

import time
from constants import (
    COL_CONFIG,
    DOC_GRADE_SCALE, DOC_CLASS_AWARD, DOC_SCHEME,
    DOC_BRANCH_CODES, DOC_APP_SETTINGS, DOC_SUBJECT_CREDITS,
    DOC_SUBJECT_TEACHERS,
    DEFAULT_GRADE_SCALE, DEFAULT_CLASS_AWARD,
    DEFAULT_SCHEME, DEFAULT_BRANCH_MAP, DEFAULT_APP_SETTINGS,
)

# ── Simple TTL cache (5 minutes) ─────────────────────────────────────────────
_CACHE_TTL = 300   # seconds
_cache: dict = {}


def _get(doc_name: str, default):
    """Fetch a config document from Firestore, using cache."""
    now = time.time()
    if doc_name in _cache and now - _cache[doc_name]['ts'] < _CACHE_TTL:
        return _cache[doc_name]['data']

    try:
        from firebase_init import get_db
        db  = get_db()
        doc = db.collection(COL_CONFIG).document(doc_name).get()
        if doc.exists:
            data = doc.to_dict()
        else:
            # Seed the document with defaults on first run
            db.collection(COL_CONFIG).document(doc_name).set(
                default if isinstance(default, dict) else {"values": default}
            )
            data = default if isinstance(default, dict) else {"values": default}
    except Exception:
        data = default if isinstance(default, dict) else {"values": default}

    _cache[doc_name] = {'data': data, 'ts': now}
    return data


def invalidate_cache():
    _cache.clear()


# ── Public accessors ─────────────────────────────────────────────────────────

def get_grade_scale() -> list:
    """Returns list of {min, max, grade, letter} dicts sorted high→low."""
    data = _get(DOC_GRADE_SCALE, {"values": DEFAULT_GRADE_SCALE})
    scale = data.get("values", DEFAULT_GRADE_SCALE)
    return sorted(scale, key=lambda x: x["min"], reverse=True)


def get_class_award() -> list:
    """Returns list of {min, class} dicts sorted high→low."""
    data = _get(DOC_CLASS_AWARD, {"values": DEFAULT_CLASS_AWARD})
    scale = data.get("values", DEFAULT_CLASS_AWARD)
    return sorted(scale, key=lambda x: x["min"], reverse=True)


def get_scheme() -> dict:
    """Returns scheme config: maxMarksPerSubject, maxInternalMarks, etc."""
    data = _get(DOC_SCHEME, DEFAULT_SCHEME)
    return {**DEFAULT_SCHEME, **data}


def get_branch_map() -> dict:
    """Returns {USN_code: branch_name} mapping."""
    data = _get(DOC_BRANCH_CODES, DEFAULT_BRANCH_MAP)
    # Support both flat dict and {values: {...}} format
    if "values" in data:
        return {**DEFAULT_BRANCH_MAP, **data["values"]}
    return {**DEFAULT_BRANCH_MAP, **data}


def get_app_settings() -> dict:
    """Returns app settings: allowedRole, maxAttempts, lockoutSecs, toppersCount."""
    data = _get(DOC_APP_SETTINGS, DEFAULT_APP_SETTINGS)
    return {**DEFAULT_APP_SETTINGS, **data}


def get_subject_credits_detailed() -> dict:
    """Returns {code: {'name': str, 'credit': int}} — full records, for the
    admin UI. Use get_subject_credits() instead when you only need the credit."""
    data = _get(DOC_SUBJECT_CREDITS, {"values": {}})
    return data.get("values", {}) if "values" in data else data


def get_subject_credits() -> dict:
    """{code: credit} shortcut used by the PDF parser and save-result flow."""
    detailed = get_subject_credits_detailed()
    return {code: rec.get("credit", 0) for code, rec in detailed.items()}


def upsert_subject_credit(code: str, name: str, credit: int):
    """Admin adds/updates a subject's credit (also called automatically the
    first time a human confirms a credit while saving a result)."""
    code = (code or '').strip().upper()
    if not code or not credit:
        return
    from firebase_init import get_db
    db = get_db()
    detailed = get_subject_credits_detailed()
    existing_name = detailed.get(code, {}).get('name', '')
    detailed[code] = {"name": (name or existing_name).strip(), "credit": int(credit)}
    db.collection(COL_CONFIG).document(DOC_SUBJECT_CREDITS).set({"values": detailed})
    invalidate_cache()


def delete_subject_credit(code: str):
    code = (code or '').strip().upper()
    if not code:
        return
    from firebase_init import get_db
    db = get_db()
    detailed = get_subject_credits_detailed()
    detailed.pop(code, None)
    db.collection(COL_CONFIG).document(DOC_SUBJECT_CREDITS).set({"values": detailed})
    invalidate_cache()


# ── Subject Teachers ──────────────────────────────────────────────────────────
# Storage format: { "BRANCH||SEM||CODE": { "teacher": str, "branch": str,
#                                           "semester": str, "code": str } }

def _teacher_key(branch: str, semester: str, code: str) -> str:
    return f"{branch.strip().upper()}||{semester.strip().upper()}||{code.strip().upper()}"


def get_subject_teachers_all() -> dict:
    """Returns the raw {key: record} dict — for admin list UI."""
    data = _get(DOC_SUBJECT_TEACHERS, {"values": {}})
    return data.get("values", {}) if "values" in data else data


def get_teacher_map(branch: str, semester: str) -> dict:
    """Returns {subject_code: teacher_name} for a given branch+semester.
    Used by the analysis API to annotate each subject row."""
    all_teachers = get_subject_teachers_all()
    prefix = f"{branch.strip().upper()}||{semester.strip().upper()}||"
    result = {}
    for key, rec in all_teachers.items():
        if key.startswith(prefix):
            code = key.split('||')[-1]
            result[code] = rec.get('teacher', '')
    return result


def upsert_subject_teacher(branch: str, semester: str, code: str, teacher: str):
    """Admin adds/updates a subject teacher assignment."""
    key = _teacher_key(branch, semester, code)
    all_teachers = get_subject_teachers_all()
    all_teachers[key] = {
        'branch':   branch.strip(),
        'semester': semester.strip(),
        'code':     code.strip().upper(),
        'teacher':  teacher.strip(),
    }
    from firebase_init import get_db
    get_db().collection(COL_CONFIG).document(DOC_SUBJECT_TEACHERS).set({"values": all_teachers})
    invalidate_cache()


def delete_subject_teacher(branch: str, semester: str, code: str):
    """Admin removes a teacher assignment."""
    key = _teacher_key(branch, semester, code)
    all_teachers = get_subject_teachers_all()
    all_teachers.pop(key, None)
    from firebase_init import get_db
    get_db().collection(COL_CONFIG).document(DOC_SUBJECT_TEACHERS).set({"values": all_teachers})
    invalidate_cache()


# ── Computed helpers (use these everywhere instead of raw thresholds) ─────────

def calc_grade(total: int) -> tuple:
    """Returns (grade_point, letter_grade) for a given total marks."""
    for band in get_grade_scale():
        if total >= band["min"]:
            return band["grade"], band["letter"]
    return 0, "F"


def calc_class_awarded(has_fail: bool, percentage: float) -> str:
    """Returns class string: FCD / FC / SC / NC."""
    if has_fail:
        return "NC"
    for band in get_class_award():
        if percentage >= band["min"]:
            return band["class"]
    return "NC"
