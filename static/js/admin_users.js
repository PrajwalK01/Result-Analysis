const API = {
  listUsers: '/api/admin/users',
  addUser: '/api/admin/users',
  deleteUser: '/api/admin/users/delete',
};

document.addEventListener('DOMContentLoaded', () => {
  loadUsers();

  document.getElementById('saveUserBtn').addEventListener('click', saveUser);
  document.getElementById('clearUserBtn').addEventListener('click', clearForm);
  
  // Search filter
  document.getElementById('userSearch').addEventListener('input', filterUsers);
});

async function loadUsers() {
  const tbody = document.querySelector('#usersTable tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading users…</td></tr>';

  try {
    const res = await fetch(API.listUsers);
    const data = await res.json();

    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="5" class="table-empty" style="color:var(--danger)">Error: ${data.error}</td></tr>`;
      return;
    }

    renderUsers(data.users);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="table-empty" style="color:var(--danger)">Network error: ${err.message}</td></tr>`;
  }
}

function renderUsers(users) {
  // Store globally for search filtering
  window.allUsers = users;
  
  const tbody = document.querySelector('#usersTable tbody');
  const countSpan = document.getElementById('userCount');
  
  countSpan.textContent = `${users.length} user${users.length !== 1 ? 's' : ''}`;

  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No active users found.</td></tr>';
    return;
  }

  tbody.innerHTML = users.map((u, i) => {
    const roleBadge = u.UserRole === 'Admin' 
      ? '<span class="badge badge--pass">Admin</span>' 
      : '<span class="badge badge--na">Standard</span>';
      
    const statusBadge = u.IsActive 
      ? '<span style="color:var(--accent-2); font-size:12px; font-weight:600;">Active</span>'
      : '<span style="color:var(--muted); font-size:12px; font-weight:600;">Inactive</span>';

    return `
      <tr class="user-row" data-search="${u.UserName.toLowerCase()} ${u.UserRole.toLowerCase()}">
        <td class="col-num">${i + 1}</td>
        <td style="font-weight:600; color:var(--text);">${u.UserName}</td>
        <td>${roleBadge}</td>
        <td>${statusBadge}</td>
        <td>
          <button class="btn btn--danger btn--sm" onclick="removeUser('${u.UserId}', '${u.UserName}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
            Remove
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function filterUsers() {
  const query = document.getElementById('userSearch').value.toLowerCase().trim();
  const rows = document.querySelectorAll('.user-row');
  let visibleCount = 0;

  rows.forEach(row => {
    if (row.dataset.search.includes(query)) {
      row.classList.remove('hidden');
      visibleCount++;
    } else {
      row.classList.add('hidden');
    }
  });

  const countSpan = document.getElementById('userCount');
  const total = window.allUsers ? window.allUsers.length : 0;
  countSpan.textContent = query 
    ? `Showing ${visibleCount} of ${total} users` 
    : `${total} user${total !== 1 ? 's' : ''}`;
}

async function saveUser() {
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const role     = document.getElementById('newUserRole').value;
  const msgEl    = document.getElementById('userMsg');
  const btn      = document.getElementById('saveUserBtn');

  if (!username || !password) {
    showMsg(msgEl, 'Username and password are required.', 'err');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const res = await fetch(API.addUser, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role })
    });
    
    const data = await res.json();

    if (data.success) {
      showMsg(msgEl, `✓ ${data.message}`, 'ok');
      clearForm();
      loadUsers();
    } else {
      showMsg(msgEl, data.error || 'Failed to add user.', 'err');
    }
  } catch (err) {
    showMsg(msgEl, `Network error: ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
        <circle cx="8.5" cy="7" r="4"/>
        <line x1="20" y1="8" x2="20" y2="14"/>
        <line x1="23" y1="11" x2="17" y2="11"/>
      </svg>
      Add User
    `;
  }
}

function clearForm() {
  document.getElementById('newUsername').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('newUserRole').value = 'ResultAnalysis';
  document.getElementById('userMsg').className = 'message hidden';
}

async function removeUser(userId, username) {
  if (!confirm(`Are you sure you want to remove user "${username}"?\nThey will no longer be able to log in.`)) {
    return;
  }

  try {
    const res = await fetch(`${API.deleteUser}?userId=${encodeURIComponent(userId)}`, {
      method: 'DELETE'
    });
    const data = await res.json();

    if (data.success) {
      loadUsers();
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (err) {
    alert(`Network error: ${err.message}`);
  }
}

function showMsg(el, text, type) {
  el.textContent = text;
  el.className = `message message--${type}`;
}
