from flask import Blueprint, render_template, jsonify, request, session, redirect, url_for
from firebase_admin import firestore
import os, re, io, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from firebase_init  import get_db
from constants      import (
    COL_LOOKUPS, COL_CONFIG,
    DOC_BRANCHES, DOC_SEMESTERS, DOC_ACADEMIC_YEARS,
    FIELD_BRANCH, FIELD_SEMESTER, FIELD_ACADEMIC_YEAR,
    FIELD_USN, FIELD_STUDENT_NAME,
    VTU_USN_LETTER_POSITIONS, VTU_USN_BRANCH_SLICE,
    OCR_DIGIT_TO_LETTER, VTU_EXAM_MONTH_PATTERN,
)
from config_loader  import (
    get_grade_scale, get_class_award, get_scheme,
    get_branch_map, get_app_settings,
    calc_grade, calc_class_awarded,
    get_subject_credits, upsert_subject_credit,
    get_teacher_map,
)

user_bp = Blueprint('user', __name__)


def _results_collection(semester: str) -> str:
    """One Firestore collection per semester — e.g. 'results_sem6'. Computed
    from whatever semester string is submitted (no hardcoded list), so this
    never needs touching when new semesters/schemes appear. Academic year is
    NOT part of the collection name — different years reuse the same
    semester's collection, distinguished by the academicYear field/doc ID,
    so nothing needs to be created or renamed each new academic year."""
    slug = re.sub(r'[^A-Za-z0-9]+', '', str(semester)).lower()
    return f"results_{slug}" if slug else "results_unknown"


def login_required(view):
    from functools import wraps
    @wraps(view)
    def wrapped(*args, **kwargs):
        if 'UserId' not in session:
            return redirect(url_for('home'))
        return view(*args, **kwargs)
    return wrapped


# ── Grading helpers (delegate to config_loader) ───────────────────────────────

def grade_point(total: int) -> int:
    gp, _ = calc_grade(total)
    return gp


def letter_grade(total: int) -> str:
    _, letter = calc_grade(total)
    return letter


def class_awarded(has_fail: bool, pct: float) -> str:
    return calc_class_awarded(has_fail, pct)


# ── USN → Branch (from DB map) ────────────────────────────────────────────────

def usn_to_branch(usn: str) -> str:
    usn = usn.strip().upper()
    if len(usn) >= 8:
        code = usn[VTU_USN_BRANCH_SLICE]
        return get_branch_map().get(code, code)
    return ''


# ── VTU PDF Parser ────────────────────────────────────────────────────────────

# Labels that precede the student's name across different VTU sheet formats
_NAME_LABEL_PATTERNS = [
    r'Student\s*Name\s*[:\-]?\s*\n?\s*([A-Z][A-Z .\'\-]{2,50}?)(?:\n|Semester|USN|$)',
    r'Candidate\s*Name\s*[:\-]?\s*\n?\s*([A-Z][A-Z .\'\-]{2,50}?)(?:\n|Semester|USN|$)',
    r'\bName\s+of\s+the\s+Student\s*[:\-]?\s*\n?\s*([A-Z][A-Z .\'\-]{2,50}?)(?:\n|Semester|USN|$)',
    r'\bName\b\s*[:\-]?\s*\n?\s*([A-Z][A-Z .\'\-]{3,50}?)(?:\n|Semester|USN|$)',
]

# Words that mean "this isn't actually a name, it's a table header/label"
_NAME_REJECT_WORDS = re.compile(
    r'Internal|External|Total|Subject|Marks|Semester|Result|Grade|Credit|Branch',
    re.IGNORECASE
)


def _extract_student_name_from_text(full_text: str, usn: str) -> str:
    """Fallback text-based name extraction, used only for OCR/scanned PDFs
    where no real table structure could be parsed."""
    for pat in _NAME_LABEL_PATTERNS:
        m = re.search(pat, full_text, re.IGNORECASE)
        if m:
            n = re.sub(r'[^\x00-\x7F]+', '', m.group(1)).strip()
            n = re.sub(r'\s{2,}', ' ', n).strip(' :-')
            if len(n) > 2 and not _NAME_REJECT_WORDS.search(n):
                return n.title()

    if usn:
        lines = full_text.split('\n')
        for i, line in enumerate(lines):
            if usn in line.upper():
                for candidate_line in [line] + lines[i + 1: i + 3]:
                    stripped = candidate_line.upper().replace(usn, '').strip(' :-\t')
                    if (2 < len(stripped) <= 50
                            and re.fullmatch(r"[A-Z .'\-]+", stripped)
                            and not _NAME_REJECT_WORDS.search(stripped)
                            and not re.search(r'SEM|VTU|BRANCH|EXAM', stripped)):
                        return stripped.title()
    return ''


def _parse_header_kv(pdf) -> dict:
    """Extracts 'University Seat Number' / 'Student Name' key-value rows,
    which VTU always prints as a 2-column table on page 1."""
    header = {'usn': '', 'studentName': ''}
    try:
        page = pdf.pages[0]
        for table in page.extract_tables():
            for row in table:
                if not row or len(row) < 2:
                    continue
                key = (row[0] or '').strip().lower()
                val = (row[1] or '').strip()
                if not val:
                    continue
                if 'seat number' in key or key == 'usn':
                    header['usn'] = re.sub(r'\s+', '', val).upper()
                elif 'student name' in key or key == 'name':
                    header['studentName'] = re.sub(r'\s{2,}', ' ', val).strip().title()
    except Exception:
        pass
    return header


def _cell_state(raw):
    """Returns (value, was_blank) — distinguishes an empty cell from a cell
    that legitimately prints 0 (e.g. External marks for a lab/project subject)."""
    raw = (raw or '').strip()
    if raw == '':
        return 0, True
    digits = re.sub(r'[^\d]', '', raw)
    if digits == '':
        return 0, True
    return int(digits), False


def _parse_subject_table(pdf) -> list:
    """Extracts the marks table using pdfplumber's table detection — reliable
    against the real VTU results.vtu.ac.in layout, and against college sheets
    that follow the same Code/Name/Internal/External/Total/Result columns."""
    subjects = []
    credit_map = get_subject_credits()

    for page in pdf.pages:
        for table in page.extract_tables():
            for row in table:
                if not row:
                    continue
                cells = [(c or '').strip().replace('\n', ' ') for c in row]

                if any('subject code' in c.lower() for c in cells):
                    continue  # header row

                code_cell = cells[0] if cells else ''
                if not re.match(r'^[A-Z]{2,6}\d{3}[A-Z0-9]{0,3}$', code_cell.upper()):
                    continue  # not a subject row

                code = code_cell.upper()
                name = cells[1] if len(cells) > 1 else ''

                internal, internal_blank = _cell_state(cells[2] if len(cells) > 2 else '')
                external, external_blank = _cell_state(cells[3] if len(cells) > 3 else '')
                total,    total_blank    = _cell_state(cells[4] if len(cells) > 4 else '')
                result_flag = (cells[5].strip().upper()[:1] if len(cells) > 5 and cells[5].strip() else None)

                needs_review = False
                reasons = []

                if internal_blank:
                    needs_review = True
                    reasons.append('Internal marks cell was blank.')
                if external_blank:
                    needs_review = True
                    reasons.append('External marks cell was blank.')

                if total_blank:
                    total = internal + external
                    needs_review = True
                    reasons.append('Total cell was blank — computed from internal+external.')
                elif abs((internal + external) - total) > 2:
                    needs_review = True
                    reasons.append('Internal+External does not match printed Total.')

                res = ('P' if result_flag == 'P' else
                       'F' if result_flag == 'F' else
                       ('P' if calc_grade(total)[0] > 0 else 'F'))

                credit = credit_map.get(code, 0)
                if credit == 0:
                    needs_review = True
                    reasons.append('Credit not yet defined for this subject — add it in Admin \u2192 Subjects.')

                subjects.append({
                    'code': code, 'name': name.title(),
                    'credit': credit,
                    'internal': internal, 'external': external,
                    'total': total, 'result': res,
                    'needsReview': needs_review,
                    'reviewReason': ' '.join(reasons) or None,
                })

    return subjects


def parse_vtu_pdf(file_bytes: bytes) -> dict:
    """Parse a VTU result PDF. Table-based extraction is the primary path
    (works for the official results.vtu.ac.in PDF and similarly structured
    college sheets); OCR is only a fallback for scanned/photographed copies."""
    result = {'usn': '', 'studentName': '', 'semester': '',
              'branch': '', 'academicYear': '', 'subjects': []}

    full_text = ''
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            full_text = '\n'.join(p.extract_text() or '' for p in pdf.pages).strip()

            header = _parse_header_kv(pdf)
            result['usn'] = header['usn']
            result['studentName'] = header['studentName']

            subjects = _parse_subject_table(pdf)
            if subjects:
                result['subjects'] = subjects
    except Exception:
        full_text = full_text or ''

    # OCR fallback only if the table-based path found nothing usable
    if not result['usn'] and not result['subjects']:
        if not full_text.strip():
            try:
                import fitz
                import pytesseract
                from PIL import Image
                import numpy as np

                for p in [r'C:\Program Files\Tesseract-OCR\tesseract.exe',
                          r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe',
                          '/usr/bin/tesseract', '/usr/local/bin/tesseract']:
                    if os.path.exists(p):
                        pytesseract.pytesseract.tesseract_cmd = p
                        break

                doc = fitz.open(stream=file_bytes, filetype='pdf')
                pages_text = []
                for page in doc:
                    pix     = page.get_pixmap(matrix=fitz.Matrix(4.0, 4.0), colorspace=fitz.csGRAY)
                    img     = Image.frombytes('L', [pix.width, pix.height], pix.samples)
                    arr     = np.array(img)
                    arr     = ((arr < 175) * 255).astype('uint8')
                    img_bin = Image.fromarray(arr)
                    pages_text.append(pytesseract.image_to_string(img_bin, config='--psm 6 --oem 3'))
                full_text = '\n'.join(pages_text)
            except ImportError:
                raise RuntimeError('OCR libraries missing (pymupdf, pytesseract, numpy, Pillow).')
            except Exception as e:
                raise RuntimeError(f'OCR failed: {e}')

        if not full_text.strip():
            raise RuntimeError('Could not extract any text from this PDF.')

        usn_m = re.search(r'University\s+Seat\s+Number\s*\n?\s*([1-9][A-Z0-9]{6,12})',
                          full_text, re.IGNORECASE)
        if usn_m:
            chars = list(usn_m.group(1).strip().upper())
            for idx in VTU_USN_LETTER_POSITIONS:
                if idx < len(chars) and chars[idx].isdigit():
                    chars[idx] = OCR_DIGIT_TO_LETTER.get(chars[idx], chars[idx])
            result['usn'] = ''.join(chars)

        result['studentName'] = _extract_student_name_from_text(full_text, result['usn'])

        credit_map = get_subject_credits()
        seen, lines = set(), full_text.split('\n')
        i = 0
        while i < len(lines):
            cm = re.match(r'^([A-Z]{2,6}\d{3}[A-Z0-9]{0,3})\b\s*(.*)', lines[i].strip())
            if cm:
                code = cm.group(1).upper()
                rest = cm.group(2).strip()
                j = i + 1
                while j < len(lines):
                    nl = lines[j].strip()
                    if not nl or re.match(r'^[A-Z]{2,6}\d{3}', nl): break
                    if re.search(r'PASS|FAIL|ABSENT|Nomenclature|https://', nl, re.IGNORECASE): break
                    rest += ' ' + nl
                    j += 1
                i = j - 1

                if code not in seen:
                    rc = re.sub(r'\d{4}-\d{2}-\d{2}', '', rest)
                    rc = re.sub(r'\b20\d{2}\b', '', rc)
                    rc = re.sub(r'[|\[\]{}\\]', ' ', rc)
                    rc = re.sub(r'\s{2,}', ' ', rc).strip()

                    nums = [int(n) for n in re.findall(r'\b(\d{1,3})\b', rc) if int(n) <= 100]

                    internal = external = total = 0
                    needs_review = False
                    reasons = []

                    if len(nums) >= 3:
                        found = False
                        for x in range(len(nums) - 2):
                            a, b, c = nums[x], nums[x + 1], nums[x + 2]
                            if abs(a + b - c) <= 2:
                                internal, external, total = a, b, c
                                found = True
                                break
                        if not found:
                            needs_review = True
                            reasons.append('Marks columns unclear (numbers found but did not add up).')
                    elif len(nums) == 2:
                        needs_review = True
                        reasons.append('Only 2 numbers found — internal/external split unclear.')
                        internal, external = nums[0], nums[1]
                        total = internal + external
                    elif len(nums) == 1:
                        needs_review = True
                        reasons.append('Only 1 mark found — internal or external missing.')
                        internal = total = nums[0]
                    else:
                        needs_review = True
                        reasons.append('No marks detected for this subject.')

                    if internal > 100 or external > 100 or total > 200:
                        needs_review = True
                        reasons.append('Extracted values out of expected range — please verify.')

                    credit = credit_map.get(code, 0)
                    if credit == 0:
                        needs_review = True
                        reasons.append('Credit not yet defined for this subject — add it in Admin \u2192 Subjects.')

                    name_part = re.split(r'\s+\d', rc)[0]
                    name_part = re.sub(r'[^A-Za-z0-9 &()/\-]', '', name_part).strip()
                    name_part = re.sub(r'\s{2,}', ' ', name_part).strip()
                    res_flag  = 'F' if (re.search(r'\s+F\s*(?:$|\s)', rest)
                                         and not re.search(r'F\s*->', rest)) else 'P'

                    seen.add(code)
                    result['subjects'].append({
                        'code': code, 'name': name_part,
                        'credit': credit,
                        'internal': internal, 'external': external,
                        'total': total, 'result': res_flag,
                        'needsReview': needs_review,
                        'reviewReason': ' '.join(reasons) or None,
                    })
            i += 1

    # Semester + academic year — same regardless of which path was used
    sm = re.search(r'Semester\s*[:\-]?\s*(\d+)', full_text, re.IGNORECASE)
    if sm:
        result['semester'] = f"SEM {sm.group(1)}"

    if result['usn']:
        result['branch'] = usn_to_branch(result['usn'])

    ym = re.search(VTU_EXAM_MONTH_PATTERN, full_text, re.IGNORECASE)
    if ym:
        yr = int(ym.group(1))
        result['academicYear'] = f"{yr - 1}-{str(yr)[2:]}"
    else:
        py = re.search(r'20(\d{2})', full_text)
        if py:
            yr = int('20' + py.group(1))
            result['academicYear'] = f"{yr - 1}-{str(yr)[2:]}"

    return result


# ── API: config (grade scale + scheme) served to frontend ────────────────────

@user_bp.route('/api/config', methods=['GET'])
@login_required
def get_config():
    """Serve grading config to the frontend so JS has zero hardcoding."""
    try:
        scheme      = get_scheme()
        grade_s     = get_grade_scale()
        class_s     = get_class_award()
        app_s       = get_app_settings()
        branch_map  = get_branch_map()   # USN code → branch name, DB-driven
        return jsonify({
            'success':    True,
            'gradeScale': grade_s,
            'classAward': class_s,
            'scheme':     scheme,
            'appSettings':app_s,
            'branchMap':  branch_map,
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ── API: lookups ──────────────────────────────────────────────────────────────

@user_bp.route('/api/lookups', methods=['GET'])
@login_required
def get_lookups():
    try:
        db = get_db()
        branches  = db.collection(COL_LOOKUPS).document(DOC_BRANCHES).get()
        semesters = db.collection(COL_LOOKUPS).document(DOC_SEMESTERS).get()
        years     = db.collection(COL_LOOKUPS).document(DOC_ACADEMIC_YEARS).get()
        return jsonify({
            'success':       True,
            'branches':      sorted(branches.to_dict().get('values', []))  if branches.exists  else [],
            'semesters':     sorted(semesters.to_dict().get('values', [])) if semesters.exists else [],
            'academicYears': sorted(years.to_dict().get('values', []))     if years.exists     else [],
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ── API: analysis ─────────────────────────────────────────────────────────────

@user_bp.route('/api/analysis', methods=['GET'])
@login_required
def get_analysis():
    branch        = request.args.get(FIELD_BRANCH,        '').strip()
    semester      = request.args.get(FIELD_SEMESTER,      '').strip()
    academic_year = request.args.get(FIELD_ACADEMIC_YEAR, '').strip()

    if not branch or not semester or not academic_year:
        return jsonify({'success': False,
                        'error': 'branch, semester and academicYear are required'}), 400
    try:
        collection_name = _results_collection(semester)
        docs = list(
            get_db().collection(collection_name)
            .where(FIELD_BRANCH,        '==', branch)
            .where(FIELD_ACADEMIC_YEAR, '==', academic_year)
            .stream()
        )
        if not docs:
            return jsonify({'success': True, 'students': [], 'message': 'No results found'})
        # Attach teacher map so frontend can show teacher per subject
        teacher_map = get_teacher_map(branch, semester)
        return jsonify({'success': True, 'students': [d.to_dict() for d in docs],
                        'teacherMap': teacher_map})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ── API: save result ──────────────────────────────────────────────────────────

@user_bp.route('/api/save-result', methods=['POST'])
@login_required
def save_result():
    data = request.get_json(silent=True)
    required = [FIELD_BRANCH, FIELD_SEMESTER, FIELD_ACADEMIC_YEAR,
                FIELD_USN, FIELD_STUDENT_NAME, 'subjects']
    if not data or any(not data.get(f) for f in required):
        return jsonify({'success': False, 'error': 'Missing required fields'}), 400

    subjects = data['subjects']
    if not isinstance(subjects, list) or len(subjects) == 0:
        return jsonify({'success': False, 'error': 'At least one subject is required'}), 400

    try:
        scheme = get_scheme()
        max_per_subject = scheme['maxMarksPerSubject']

        enriched = []
        for s in subjects:
            internal   = max(0, int(s.get('internal', 0)))
            external   = max(0, int(s.get('external', 0)))
            credit     = max(0, int(s.get('credit',   0)))
            total      = internal + external
            gp, letter = calc_grade(total)
            res        = 'P' if gp > 0 else 'F'
            credit_pts = gp * credit
            code_val   = str(s.get('code', '')).strip().upper()
            name_val   = str(s.get('name', '')).strip()

            # Remember any credit a human confirms while saving, so the next
            # PDF upload of this same subject auto-fills it and skips review.
            if credit > 0 and code_val:
                upsert_subject_credit(code_val, name_val, credit)

            enriched.append({
                'code':         code_val,
                'name':         name_val,
                'credit':       credit,
                'internal':     internal,
                'external':     external,
                'total':        total,
                'grade':        gp,
                'letterGrade':  letter,
                'result':       res,
                'creditPoints': credit_pts,
            })

        num_subjects        = len(enriched)
        sum_total           = sum(s['total']        for s in enriched)
        max_marks           = num_subjects * max_per_subject
        total_credits       = sum(s['credit']       for s in enriched)
        total_credit_points = sum(s['creditPoints'] for s in enriched)
        sgpa       = round(total_credit_points / total_credits, 2) if total_credits > 0 else 0.0
        # VTU formula: Percentage = (SGPA - 0.75) × 10
        percentage = round(max(0.0, (sgpa - 0.75) * 10), 2) if sgpa > 0 else 0.0
        has_fail   = any(s['result'] == 'F' for s in enriched)
        cls        = calc_class_awarded(has_fail, percentage)

        # Deterministic document ID within the semester's own collection:
        # USN + branch + academic year (semester is already implied by which
        # collection this is, so it's not repeated in the ID). Re-uploading
        # the same student's same-year result for this semester UPDATES the
        # existing document instead of creating a duplicate.
        def _slug(s):
            return re.sub(r'[^A-Za-z0-9]+', '', str(s)).upper()

        collection_name = _results_collection(data[FIELD_SEMESTER])
        doc_id  = f"{_slug(data[FIELD_USN])}_{_slug(data[FIELD_BRANCH])}_{_slug(data[FIELD_ACADEMIC_YEAR])}"
        doc_ref = get_db().collection(collection_name).document(doc_id)
        is_update = doc_ref.get().exists

        record = {
            FIELD_BRANCH:        data[FIELD_BRANCH].strip(),
            FIELD_SEMESTER:      data[FIELD_SEMESTER].strip(),
            FIELD_ACADEMIC_YEAR: data[FIELD_ACADEMIC_YEAR].strip(),
            FIELD_USN:           data[FIELD_USN].strip().upper(),
            FIELD_STUDENT_NAME:  data[FIELD_STUDENT_NAME].strip(),
            'subjects':           enriched,
            'numSubjects':        num_subjects,
            'sumTotal':           sum_total,
            'maxMarks':           max_marks,
            'totalCredits':       total_credits,
            'totalCreditPoints':  total_credit_points,
            'sgpa':               sgpa,
            'percentage':         percentage,
            'classAwarded':       cls,
            'savedBy':            session.get('UserId', ''),
            'updatedAt':          firestore.SERVER_TIMESTAMP,
        }
        if not is_update:
            record['createdAt'] = firestore.SERVER_TIMESTAMP

        doc_ref.set(record, merge=True)

        for doc_name, val in [
            (DOC_BRANCHES,      data[FIELD_BRANCH]),
            (DOC_SEMESTERS,     data[FIELD_SEMESTER]),
            (DOC_ACADEMIC_YEARS,data[FIELD_ACADEMIC_YEAR]),
        ]:
            get_db().collection(COL_LOOKUPS).document(doc_name).set(
                {'values': firestore.ArrayUnion([val.strip()])}, merge=True
            )

        return jsonify({'success': True,
                        'message': ('Result updated successfully.' if is_update
                                    else 'Result saved successfully.'),
                        'isUpdate': is_update,
                        'sgpa': sgpa, 'percentage': percentage, 'classAwarded': cls})

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ── API: parse PDF ────────────────────────────────────────────────────────────

@user_bp.route('/api/parse-pdf', methods=['POST'])
@login_required
def parse_pdf():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No file uploaded'}), 400
    f = request.files['file']
    if not f.filename.lower().endswith('.pdf'):
        return jsonify({'success': False, 'error': 'Only PDF files are supported'}), 400
    try:
        parsed = parse_vtu_pdf(f.read())
        if not parsed['usn'] and not parsed['subjects']:
            return jsonify({'success': False,
                            'error': 'Could not extract data. PDF may be heavily watermarked or scanned.'}), 422

        warnings = []
        if not parsed['studentName']:
            warnings.append('Student name not readable — fill manually.')

        flagged = [s for s in parsed['subjects'] if s.get('needsReview')]
        if not parsed['subjects']:
            warnings.append('No subject rows detected — fill manually.')
        elif flagged:
            codes = ', '.join(s['code'] for s in flagged)
            warnings.append(f"{len(flagged)} of {len(parsed['subjects'])} subject(s) need review: {codes}.")

        warning = ' '.join(warnings) or None
        return jsonify({'success': True, 'data': parsed, 'warning': warning})
    except Exception as e:
        return jsonify({'success': False, 'error': f'PDF parse error: {str(e)}'}), 500


@user_bp.route('/api/resolve-import', methods=['POST'])
@login_required
def resolve_import():
    """Enriches data scraped by the bookmarklet/browser extension with
    server-known info: branch (from USN) and credit (from the admin-managed
    subject table) — the same enrichment PDF uploads already get."""
    data = request.get_json(silent=True) or {}
    usn = (data.get('usn') or '').strip().upper()
    subjects = data.get('subjects') or []

    try:
        branch = usn_to_branch(usn) if usn else ''
        credit_map = get_subject_credits()

        enriched_subjects = []
        for s in subjects:
            code = str(s.get('code', '')).strip().upper()
            credit = credit_map.get(code, 0)
            enriched_subjects.append({
                **s,
                'code': code,
                'credit': credit,
                'needsReview': credit == 0,
                'reviewReason': None if credit else
                    'Credit not yet defined for this subject — add it in Admin \u2192 Subjects.',
            })

        return jsonify({'success': True, 'branch': branch, 'subjects': enriched_subjects})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500