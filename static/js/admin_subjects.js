const ADMIN_API = {
  list: '/api/admin/subjects',
  save: '/api/admin/subjects',
  remove: code => `/api/admin/subjects/${encodeURIComponent(code)}`
};

let allSubjects = [];

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('saveSubjectBtn').addEventListener('click', saveSubject);
  document.getElementById('subjectSearch').addEventListener('input', renderTable);
  loadSubjects();
});

async function loadSubjects() {
  try {
    const res = await fetch(ADMIN_API.list);
    const data = await res.json();
    if (data.success) {
      allSubjects = data.subjects;
      renderTable();
    }
  } catch (err) {
    console.error('Failed to load subjects:', err);
  }
}

async function saveSubject() {
  const code = document.getElementById('subjCode').value.trim();
  const name = document.getElementById('subjName').value.trim();
  const credit = document.getElementById('subjCredit').value.trim();
  const msgEl = document.getElementById('adminMsg');

  if (!code || !name || !credit) {
    showMessage(msgEl, 'Code, name and credit are all required.', 'err');
    return;
  }

  try {
    const res = await fetch(ADMIN_API.save, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, credit })
    });
    const data = await res.json();

    if (data.success) {
      showMessage(msgEl, data.message, 'ok');
      document.getElementById('subjCode').value = '';
      document.getElementById('subjName').value = '';
      document.getElementById('subjCredit').value = '';
      loadSubjects();
    } else {
      showMessage(msgEl, data.error, 'err');
    }
  } catch (err) {
    showMessage(msgEl, `Error: ${err.message}`, 'err');
  }
}

async function removeSubject(code) {
  if (!confirm(`Remove ${code}? PDFs uploaded after this will need its credit re-entered.`)) return;

  try {
    const res = await fetch(ADMIN_API.remove(code), { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      loadSubjects();
    } else {
      alert(data.error);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

function showMessage(el, text, type) {
  el.textContent = text;
  el.className = `message message--${type}`;
}

function renderTable() {
  const filter = document.getElementById('subjectSearch').value.trim().toLowerCase();
  const tbody = document.querySelector('#subjectsTable tbody');
  tbody.innerHTML = '';

  const filtered = allSubjects.filter(s =>
    s.code.toLowerCase().includes(filter) || s.name.toLowerCase().includes(filter)
  );

  filtered.forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.code}</td>
      <td>${s.name}</td>
      <td><span class="credit-badge">${s.credit}</span></td>
      <td><button class="btn btn--danger" data-code="${s.code}">Remove</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-code]').forEach(btn => {
    btn.addEventListener('click', () => removeSubject(btn.dataset.code));
  });
}
