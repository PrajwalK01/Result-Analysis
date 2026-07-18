/* ── Admin: Subject Teachers ─────────────────────────────────────────────── */
const API_TEACHERS     = '/api/admin/teachers';
const API_TEACHER_DEL  = key => `/api/admin/teachers/${encodeURIComponent(key)}`;
const API_ADMIN_LOOKUPS = '/api/admin/lookups';

let allTeachers = [];

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('saveTeacherBtn').addEventListener('click', saveTeacher);
  document.getElementById('clearTeacherBtn').addEventListener('click', clearForm);
  document.getElementById('teacherSearch').addEventListener('input', renderTable);

  loadLookups();   // populate Branch + Semester selects first
  loadTeachers();
});

/* ── Lookups: populate Branch & Semester selects from DB ── */
async function loadLookups() {
  try {
    const res = await fetch(API_ADMIN_LOOKUPS);

    // Guard: if the response is not JSON (e.g. got an HTML redirect), surface it
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      showMsg('teacherMsg', 'Session expired — please log in again.', 'err');
      return;
    }

    const data = await res.json();
    if (!data.success) {
      showMsg('teacherMsg', `Could not load dropdowns: ${data.error}`, 'err');
      return;
    }

    fillSelect('tchBranch',   data.branches,  'Select Branch');
    fillSelect('tchSemester', data.semesters, 'Select Semester');

  } catch (e) {
    showMsg('teacherMsg', `Network error loading dropdowns: ${e.message}`, 'err');
  }
}

function fillSelect(id, values, placeholder) {
  const el = document.getElementById(id);
  if (!el) return;
  const current = el.value;
  el.innerHTML = `<option value="">${placeholder}</option>` +
    (values || []).map(v => `<option value="${v}">${v}</option>`).join('');
  // restore selection if still valid
  if (current && values.includes(current)) el.value = current;
}

async function loadTeachers() {
  try {
    const res  = await fetch(API_TEACHERS);
    const data = await res.json();
    if (data.success) { allTeachers = data.teachers; renderTable(); }
    else showMsg('teacherMsg', data.error || 'Failed to load.', 'err');
  } catch (e) {
    showMsg('teacherMsg', `Network error: ${e.message}`, 'err');
  }
}

async function saveTeacher() {
  const branch   = document.getElementById('tchBranch').value.trim();
  const semester = document.getElementById('tchSemester').value.trim();
  const code     = document.getElementById('tchCode').value.trim().toUpperCase();
  const teacher  = document.getElementById('tchName').value.trim();

  if (!branch || !semester || !code || !teacher) {
    showMsg('teacherMsg', 'Branch, Semester, Subject Code and Teacher Name are all required.', 'err');
    return;
  }
  const btn = document.getElementById('saveTeacherBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const res  = await fetch(API_TEACHERS, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ branch, semester, code, teacher }),
    });
    const data = await res.json();
    if (data.success) {
      showMsg('teacherMsg', `✓ ${data.message}`, 'ok');
      clearForm();
      loadTeachers();
    } else {
      showMsg('teacherMsg', data.error, 'err');
    }
  } catch (e) {
    showMsg('teacherMsg', `Network error: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
      <polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
    </svg> Save Teacher`;
  }
}

async function removeTeacher(branch, semester, code) {
  const key = `${branch.toUpperCase()}||${semester.toUpperCase()}||${code.toUpperCase()}`;
  if (!confirm(`Remove teacher assignment for ${code} (${branch} / ${semester})?`)) return;
  try {
    const res  = await fetch(API_TEACHER_DEL(key), { method: 'DELETE' });
    const data = await res.json();
    if (data.success) { showMsg('teacherMsg', `✓ ${data.message}`, 'ok'); loadTeachers(); }
    else showMsg('teacherMsg', data.error, 'err');
  } catch (e) {
    showMsg('teacherMsg', `Error: ${e.message}`, 'err');
  }
}

function clearForm() {
  document.getElementById('tchBranch').value   = '';
  document.getElementById('tchSemester').value = '';
  document.getElementById('tchCode').value     = '';
  document.getElementById('tchName').value     = '';
}

function renderTable() {
  const q       = document.getElementById('teacherSearch').value.trim().toLowerCase();
  const tbody   = document.querySelector('#teachersTable tbody');
  const countEl = document.getElementById('teacherCount');

  const filtered = allTeachers.filter(t =>
    (t.branch   || '').toLowerCase().includes(q) ||
    (t.semester || '').toLowerCase().includes(q) ||
    (t.code     || '').toLowerCase().includes(q) ||
    (t.teacher  || '').toLowerCase().includes(q)
  );

  countEl.textContent = `${filtered.length} assignment${filtered.length !== 1 ? 's' : ''}`;
  tbody.innerHTML = '';

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">
      ${q ? 'No assignments match your search.' : 'No teacher assignments added yet.'}</td></tr>`;
    return;
  }

  filtered.forEach((t, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-num">${i + 1}</td>
      <td><span class="branch-pill">${t.branch}</span></td>
      <td><span class="sem-pill">${t.semester}</span></td>
      <td><span class="code-pill">${t.code}</span></td>
      <td class="teacher-name">${t.teacher}</td>
      <td>
        <button class="btn btn--danger btn--sm"
          data-branch="${t.branch}" data-sem="${t.semester}" data-code="${t.code}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
          Remove
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-branch]').forEach(btn =>
    btn.addEventListener('click', () =>
      removeTeacher(btn.dataset.branch, btn.dataset.sem, btn.dataset.code)
    )
  );
}

function showMsg(id, text, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = `message message--${type}`;
}
