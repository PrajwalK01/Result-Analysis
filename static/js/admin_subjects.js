/* ── Admin: Subject Credits ───────────────────────────────────────────────── */
const API_SUBJECTS      = '/api/admin/subjects';
const API_SUBJECT_DEL   = code => `/api/admin/subjects/${encodeURIComponent(code)}`;

let allSubjects = [];

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('saveSubjectBtn').addEventListener('click', saveSubject);
  document.getElementById('clearSubjectBtn').addEventListener('click', clearForm);
  document.getElementById('subjectSearch').addEventListener('input', renderTable);
  document.getElementById('filterExternalRequired').addEventListener('change', renderTable);
  document.getElementById('filterCredit').addEventListener('change', renderTable);
  loadSubjects();
});

async function loadSubjects() {
  try {
    const res  = await fetch(API_SUBJECTS);
    const data = await res.json();
    if (data.success) { allSubjects = data.subjects; populateCreditFilterOptions(); renderTable(); }
    else showMsg('adminMsg', data.error || 'Failed to load.', 'err');
  } catch (e) {
    showMsg('adminMsg', `Network error: ${e.message}`, 'err');
  }
}

// Keeps the Credit filter's options matching whatever credit values actually
// exist right now, instead of a fixed guessed range. Preserves the current
// selection if it's still one of the available values.
function populateCreditFilterOptions() {
  const sel = document.getElementById('filterCredit');
  const current = sel.value;
  const credits = [...new Set(allSubjects.map(s => s.credit))].sort((a, b) => a - b);

  sel.innerHTML = '<option value="">All Credits</option>' +
    credits.map(c => `<option value="${c}">${c} credit${c === 1 ? '' : 's'}</option>`).join('');

  if (credits.some(c => String(c) === current)) sel.value = current;
}

async function saveSubject() {
  const code   = document.getElementById('subjCode').value.trim().toUpperCase();
  const credit = document.getElementById('subjCredit').value.trim();
  const externalRequired = document.getElementById('subjExternalRequired').checked;

  if (!code || !credit) {
    showMsg('adminMsg', 'Subject Code and Credit are both required.', 'err'); return;
  }

  const btn = document.getElementById('saveSubjectBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const res  = await fetch(API_SUBJECTS, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code, credit, externalRequired }),
    });
    const data = await res.json();
    if (data.success) {
      showMsg('adminMsg', `✓ ${data.message}`, 'ok');
      clearForm();
      loadSubjects();
    } else {
      showMsg('adminMsg', data.error, 'err');
    }
  } catch (e) {
    showMsg('adminMsg', `Network error: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
      <polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
    </svg> Save Subject`;
  }
}

async function removeSubject(code) {
  if (!confirm(`Remove "${code}"?\nPDFs uploaded after this will need its credit re-entered.`)) return;
  try {
    const res  = await fetch(API_SUBJECT_DEL(code), { method: 'DELETE' });
    const data = await res.json();
    if (data.success) { showMsg('adminMsg', `✓ ${data.message}`, 'ok'); loadSubjects(); }
    else showMsg('adminMsg', data.error, 'err');
  } catch (e) {
    showMsg('adminMsg', `Error: ${e.message}`, 'err');
  }
}

function clearForm() {
  ['subjCode', 'subjCredit'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('subjExternalRequired').checked = true;
}

function renderTable() {
  const q            = document.getElementById('subjectSearch').value.trim().toLowerCase();
  const reqFilter     = document.getElementById('filterExternalRequired').value;   // '', 'required', 'notRequired'
  const creditFilter  = document.getElementById('filterCredit').value;             // '' or a credit number as string
  const tbody   = document.querySelector('#subjectsTable tbody');
  const countEl = document.getElementById('subjectCount');

  const filtered = allSubjects.filter(s => {
    if (!s.code.toLowerCase().includes(q)) return false;
    if (reqFilter === 'required'    && !s.externalRequired) return false;
    if (reqFilter === 'notRequired' &&  s.externalRequired) return false;
    if (creditFilter && String(s.credit) !== creditFilter) return false;
    return true;
  });

  countEl.textContent = `${filtered.length} subject${filtered.length !== 1 ? 's' : ''}`;
  tbody.innerHTML = '';

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty">
      ${q || reqFilter || creditFilter ? 'No subjects match your filters.' : 'No subjects added yet.'}</td></tr>`;
    return;
  }

  filtered.forEach((s, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-num">${i + 1}</td>
      <td><span class="code-pill">${s.code}</span></td>
      <td><span class="credit-badge">${s.credit}</span></td>
      <td>${s.externalRequired ? 'Required' : 'Not required'}</td>
      <td>
        <button class="btn btn--danger btn--sm" data-code="${s.code}">
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

  tbody.querySelectorAll('button[data-code]').forEach(btn =>
    btn.addEventListener('click', () => removeSubject(btn.dataset.code))
  );
}

function showMsg(id, text, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = `message message--${type}`;
}