/* ── Creator: College Management ────────────────────────────────────────────── */
const API_COLLEGES      = '/api/creator/colleges';
const API_COLLEGE_PATCH = code => `/api/creator/colleges/${encodeURIComponent(code)}`;

let allColleges = [];

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('onboardBtn').addEventListener('click', onboardCollege);
  document.getElementById('clearOnboardBtn').addEventListener('click', clearForm);
  document.getElementById('collegeSearch').addEventListener('input', renderTable);
  document.getElementById('dismissCredBtn').addEventListener('click', () => {
    document.getElementById('credentialBox').classList.add('hidden');
  });

  // Password visibility toggle for SA password field
  document.getElementById('toggleSaPassword').addEventListener('click', () => {
    const input  = document.getElementById('newSaPassword');
    const icon   = document.getElementById('saEyeIcon');
    const show   = input.type === 'password';
    input.type   = show ? 'text' : 'password';
    icon.innerHTML = show
      ? `<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
         <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
         <line x1="1" y1="1" x2="23" y2="23"/>`
      : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
         <circle cx="12" cy="12" r="3"/>`;
  });

  loadColleges();
});

async function loadColleges() {
  try {
    const res  = await fetch(API_COLLEGES);
    const data = await res.json();
    if (data.success) { allColleges = data.colleges; renderTable(); }
    else showMsg('onboardMsg', data.error || 'Failed to load.', 'err');
  } catch (e) {
    showMsg('onboardMsg', `Network error: ${e.message}`, 'err');
  }
}

async function onboardCollege() {
  const code       = document.getElementById('newCollegeCode').value.trim().toLowerCase();
  const name       = document.getElementById('newCollegeName').value.trim();
  const saUsername = document.getElementById('newSaUsername').value.trim();
  const saPassword = document.getElementById('newSaPassword').value;
  const btn        = document.getElementById('onboardBtn');

  // Validate
  if (!code || !name) {
    showMsg('onboardMsg', 'College code and name are required.', 'err');
    return;
  }
  if (!/^[a-z0-9]{2,12}$/.test(code)) {
    showMsg('onboardMsg', 'College code must be 2–12 lowercase letters/digits.', 'err');
    return;
  }
  if (!saUsername) {
    showMsg('onboardMsg', 'SuperAdmin username is required.', 'err');
    return;
  }
  if (!saPassword || saPassword.length < 6) {
    showMsg('onboardMsg', 'SuperAdmin password must be at least 6 characters.', 'err');
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Creating…';

  try {
    const res  = await fetch(API_COLLEGES, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        collegeCode: code,
        collegeName: name,
        saUsername,
        saPassword,
      }),
    });
    const data = await res.json();

    if (data.success) {
      showMsg('onboardMsg', `✓ ${data.message}`, 'ok');

      // Show confirmation (no password — Creator already knows it)
      document.getElementById('cred-code').textContent     = data.collegeCode;
      document.getElementById('cred-username').textContent = data.superAdmin.username;
      document.getElementById('credentialBox').classList.remove('hidden');

      clearForm();
      loadColleges();
    } else {
      showMsg('onboardMsg', data.error || 'Failed to onboard.', 'err');
    }
  } catch (e) {
    showMsg('onboardMsg', `Network error: ${e.message}`, 'err');
  } finally {
    btn.disabled    = false;
    btn.innerHTML   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 5v14M5 12h14"/>
    </svg> Onboard College`;
  }
}

async function toggleStatus(code, currentStatus) {
  const newStatus = currentStatus === 'Active' ? 'Suspended' : 'Active';
  const verb      = newStatus === 'Suspended' ? 'Suspend' : 'Reactivate';
  if (!confirm(`${verb} college "${code}"?`)) return;

  try {
    const res  = await fetch(API_COLLEGE_PATCH(code), {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: newStatus }),
    });
    const data = await res.json();
    if (data.success) { showMsg('onboardMsg', `✓ ${data.message}`, 'ok'); loadColleges(); }
    else showMsg('onboardMsg', data.error, 'err');
  } catch (e) {
    showMsg('onboardMsg', `Error: ${e.message}`, 'err');
  }
}

function clearForm() {
  document.getElementById('newCollegeCode').value = '';
  document.getElementById('newCollegeName').value = '';
  document.getElementById('newSaUsername').value  = '';
  document.getElementById('newSaPassword').value  = '';
}

function renderTable() {
  const q       = document.getElementById('collegeSearch').value.trim().toLowerCase();
  const tbody   = document.querySelector('#collegesTable tbody');
  const countEl = document.getElementById('collegeCount');

  const filtered = allColleges.filter(c =>
    (c.code || '').toLowerCase().includes(q) ||
    (c.name || '').toLowerCase().includes(q)
  );

  countEl.textContent = `${filtered.length} college${filtered.length !== 1 ? 's' : ''}`;
  tbody.innerHTML = '';

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty">
      ${q ? 'No colleges match your search.' : 'No colleges onboarded yet.'}</td></tr>`;
    return;
  }

  filtered.forEach((c, i) => {
    const isActive    = c.status === 'Active';
    const statusBadge = isActive
      ? '<span class="badge badge--pass">Active</span>'
      : '<span class="badge badge--absent">Suspended</span>';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-num">${i + 1}</td>
      <td><span class="code-pill">${c.code}</span></td>
      <td style="text-align:left;font-weight:500;">${c.name}</td>
      <td>${statusBadge}</td>
      <td>
        <button class="btn ${isActive ? 'btn--danger' : 'btn--secondary'} btn--sm"
          data-code="${c.code}" data-status="${c.status}">
          ${isActive ? 'Suspend' : 'Reactivate'}
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-code]').forEach(btn =>
    btn.addEventListener('click', () => toggleStatus(btn.dataset.code, btn.dataset.status))
  );
}

function showMsg(id, text, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = `message message--${type}`;
}
