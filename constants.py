"""
All hardcoded strings centralised here.
Import from this module instead of using raw strings anywhere.
"""

# ── Firestore collection names ────────────────────────────────────────────────
COL_USER_LOGIN  = "UserLogin"
COL_RESULTS     = "results"
COL_LOOKUPS     = "lookups"
COL_CONFIG      = "config"

# ── Firestore document names inside COL_LOOKUPS ───────────────────────────────
DOC_BRANCHES        = "branches"
DOC_SEMESTERS       = "semesters"
DOC_ACADEMIC_YEARS  = "academicYears"

# ── Firestore document names inside COL_CONFIG ────────────────────────────────
DOC_GRADE_SCALE     = "gradeScale"      # VTU grade thresholds
DOC_CLASS_AWARD     = "classAward"      # FCD/FC/SC/NC thresholds
DOC_SCHEME          = "scheme"          # max marks, credits, etc.
DOC_BRANCH_CODES    = "branchCodes"     # USN code → branch name map
DOC_APP_SETTINGS    = "appSettings"     # role, lockout, toppers count
DOC_SUBJECT_CREDITS = "subjectCredits"  # subject code → {name, credit}, admin-managed
DOC_SUBJECT_TEACHERS = "subjectTeachers"  # branch+sem+code → teacher name, admin-managed

# ── UserLogin document field names ───────────────────────────────────────────
FIELD_USERNAME   = "UserName"
FIELD_PASSWORD   = "Password"
FIELD_USER_ID    = "UserId"
FIELD_IS_ACTIVE  = "IsActive"
FIELD_IS_DELETED = "IsDeleted"
FIELD_USER_ROLE  = "UserRole"

# ── Roles ─────────────────────────────────────────────────────────────────────
ROLE_ADMIN = "Admin"

# ── Results document field names ─────────────────────────────────────────────
FIELD_BRANCH        = "branch"
FIELD_SEMESTER      = "semester"
FIELD_ACADEMIC_YEAR = "academicYear"
FIELD_USN           = "usn"
FIELD_STUDENT_NAME  = "studentName"

# ── VTU USN format ───────────────────────────────────────────────────────────
# Positions in USN that should be letters (0-indexed)
# e.g. 1JV23IS022 → idx 1,2 = college code, idx 5,6 = branch code
VTU_USN_LETTER_POSITIONS = [1, 2, 5, 6]
VTU_USN_BRANCH_SLICE     = slice(5, 7)   # chars[5:7]

# OCR digit→letter fixes for positions that should be alphabetic
OCR_DIGIT_TO_LETTER = {'0': 'O', '1': 'I', '8': 'B', '5': 'S'}

# ── Exam month regex (VTU schedule) ──────────────────────────────────────────
VTU_EXAM_MONTH_PATTERN = (
    r'(?:May|November|August|March)\s*/\s*'
    r'(?:June|December|January|April)[^\d]*(\d{4})'
)

# ── Defaults (used if Firestore config doc is missing) ───────────────────────
DEFAULT_GRADE_SCALE = [
    {"min": 90, "max": 100, "grade": 10, "letter": "O"},
    {"min": 80, "max": 89,  "grade": 9,  "letter": "A+"},
    {"min": 70, "max": 79,  "grade": 8,  "letter": "A"},
    {"min": 60, "max": 69,  "grade": 7,  "letter": "B+"},
    {"min": 55, "max": 59,  "grade": 6,  "letter": "B"},
    {"min": 50, "max": 54,  "grade": 5,  "letter": "C"},
    {"min": 40, "max": 49,  "grade": 4,  "letter": "P"},
    {"min": 0,  "max": 39,  "grade": 0,  "letter": "F"},
]

DEFAULT_CLASS_AWARD = [
    {"min": 75,  "class": "FCD"},
    {"min": 60,  "class": "FC"},
    {"min": 45,  "class": "SC"},
    {"min": 0,   "class": "NC"},
]

DEFAULT_SCHEME = {
    "maxMarksPerSubject":  100,
    "maxInternalMarks":    50,
    "maxExternalMarks":    100,
    "maxCredit":           10,
    "toppersCount":        3,
}

DEFAULT_APP_SETTINGS = {
    "allowedRole":   "ResultAnalysis",
    "maxAttempts":   5,
    "lockoutSecs":   300,
    "toppersCount":  3,
}

DEFAULT_BRANCH_MAP = {
    "EC": "ECE",     "IS": "ISE",     "CS": "CSE",
    "ME": "ME",      "CV": "CIVIL",   "EE": "EEE",
    "ET": "ETE",     "IM": "IME",     "BT": "BT",
    "CH": "CHE",     "AI": "AI&ML",   "AD": "AI&DS",
    "CD": "CSD",     "CY": "CSE(CY)",
}
