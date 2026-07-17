const API = {
  lookups:    '/api/lookups',
  analysis:   '/api/analysis',
  saveResult: '/api/save-result',
  config:     '/api/config',
  parsePdf:   '/api/parse-pdf',
};

// ── Runtime config loaded from DB (zero hardcoding) ──────────────────────────
let CFG = {
  gradeScale:  [],   // [{min, max, grade, letter}] sorted high→low
  classAward:  [],   // [{min, class}] sorted high→low
  scheme:      { maxMarksPerSubject: 100, maxInternalMarks: 50, maxExternalMarks: 100, maxCredit: 10 },
  appSettings: { toppersCount: 3 },
};

async function loadConfig() {
  try {
    const res  = await fetch(API.config);
    const data = await res.json();
    if (data.success) {
      CFG.gradeScale  = data.gradeScale  || CFG.gradeScale;
      CFG.classAward  = data.classAward  || CFG.classAward;
      CFG.scheme      = data.scheme      || CFG.scheme;
      CFG.appSettings = data.appSettings || CFG.appSettings;
    }
  } catch (e) {
    console.warn('Config fetch failed, using defaults:', e);
  }
}

let subjectCount = 0;
let isEditMode   = false;

document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();   // load grading config FIRST
  initTabs();
  initImageUpload();
  loadLookups();

  document.getElementById('editToggleBtn').addEventListener('click', toggleEditMode);
  document.getElementById('addSubjectBtn').addEventListener('click', () => addSubjectRow());
  document.getElementById('saveResultBtn').addEventListener('click', saveResult);
  document.getElementById('resetFormBtn').addEventListener('click', resetUploadForm);
  document.getElementById('loadAnalysisBtn').addEventListener('click', loadAnalysis);
  document.getElementById('downloadCSVBtn').addEventListener('click', downloadCSV);

  // Auto-detect branch from USN as user types
  document.getElementById('usn').addEventListener('input', function() {
    const branch = detectBranchFromUSN(this.value);
    if (branch) {
      const branchInput = document.getElementById('branch');
      if (!branchInput.value.trim()) {
        branchInput.value = branch;
        // sync view
        const viewBranch = document.getElementById('view-branch');
        if (viewBranch) { viewBranch.textContent = branch; viewBranch.classList.remove('is-empty'); }
      }
    }
  });

  // Default: view mode (edit off). User must click Edit Details to enter edit mode.
  // isEditMode is already false, so addSubjectRow will add the row in view mode.
  addSubjectRow();

  loadImportedFromBookmarklet();
  setupBookmarklet();
  initDashboardCascade();
});

/* ==================== BOOKMARKLET SETUP ==================== */
function setupBookmarklet() {
  const el = document.getElementById('bookmarkletLink');
  if (!el) return;

  const appOrigin = window.location.origin;

  // Same logic as the standalone bookmarklet, but the target URL is
  // filled in automatically from wherever this app is actually running.
  const code = `(function(){
    function cellText(el){return (el.innerText||el.textContent||'').trim();}

    // VTU's page has NO real <table> tags — it's all styled divs:
    // .divTable > .divTableBody > .divTableRow > .divTableCell
    var divTables = Array.from(document.querySelectorAll('.divTable'));
    var usn='', studentName='', semester='', subjects=[];

    divTables.forEach(function(dt){
      var rows = Array.from(dt.querySelectorAll('.divTableRow'));

      rows.forEach(function(row){
        var cells = Array.from(row.querySelectorAll('.divTableCell')).map(cellText);
        if(cells.length===2){
          var key = cells[0].toLowerCase();
          if(key.indexOf('seat number')>-1 || key==='usn'){ usn = cells[1].replace(/\\s+/g,'').toUpperCase(); }
          if(key.indexOf('student name')>-1 || key==='name'){ studentName = cells[1].replace(/\\s{2,}/g,' ').trim(); }
        }
      });

      var headerIdx = rows.findIndex(function(r){
        return Array.from(r.querySelectorAll('.divTableCell')).some(function(c){
          return cellText(c).toLowerCase().indexOf('subject code') > -1;
        });
      });
      if(headerIdx === -1) return;

      for(var i=headerIdx+1; i<rows.length; i++){
        var cells = Array.from(rows[i].querySelectorAll('.divTableCell')).map(cellText);
        if(cells.length < 5) continue;
        var code = cells[0].toUpperCase();
        if(!/^[A-Z]{2,6}\\d{3}[A-Z0-9]{0,3}$/.test(code)) continue;

        var name = cells[1] || '';
        var internal = parseInt(cells[2],10); if(isNaN(internal)) internal = 0;
        var external = parseInt(cells[3],10); if(isNaN(external)) external = 0;
        var total    = parseInt(cells[4],10); if(isNaN(total)) total = internal+external;
        var result   = (cells[5]||'').trim().toUpperCase().charAt(0) || (total>0?'P':'F');

        subjects.push({code:code, name:name, internal:internal, external:external, total:total, result:result});
      }
    });

    var semMatch = document.body.innerText.match(/Semester\\s*:?\\s*(\\d+)/i);
    if(semMatch) semester = 'SEM ' + semMatch[1];

    if(!usn && subjects.length===0){
      alert('Could not find a VTU result table on this page. Make sure your result has fully loaded first.');
      return;
    }
    var payload = {usn:usn, studentName:studentName, semester:semester, subjects:subjects};
    var encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    window.open('${appOrigin}/user?imported=' + encoded, '_blank');
  })();`;

  const a = document.createElement('a');
  a.href = 'javascript:' + encodeURIComponent(code);
  a.className = 'bookmarklet-link';
  a.textContent = '📌 Send to Result Analysis';
  a.title = 'Drag this to your bookmarks bar';
  a.onclick = (e) => {
    e.preventDefault();
    alert('Drag this link to your bookmarks bar first — clicking it here does nothing.');
  };

  el.replaceWith(a);
}

/* ==================== BOOKMARKLET IMPORT ==================== */
function loadImportedFromBookmarklet() {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get('imported');
  if (!encoded) return;

  let d;
  try {
    d = JSON.parse(decodeURIComponent(escape(atob(encoded))));
  } catch (e) {
    console.error('Failed to parse imported data:', e);
    return;
  }

  if (!isEditMode) enterEditMode();

  if (d.usn)         document.getElementById('usn').value         = d.usn;
  if (d.studentName) document.getElementById('studentName').value = d.studentName;
  if (d.semester)    document.getElementById('semester').value    = d.semester;

  // Auto-detect branch from USN for bookmarklet imports
  if (d.usn) {
    const detectedBranch = detectBranchFromUSN(d.usn);
    if (detectedBranch) {
      const branchInput = document.getElementById('branch');
      if (!branchInput.value.trim()) branchInput.value = detectedBranch;
    }
  }

  ['usn', 'studentName', 'semester'].forEach(id => {
    const val = document.getElementById(id).value.trim();
    const el  = document.getElementById(`view-${id}`);
    if (el) { el.textContent = val || '—'; el.classList.toggle('is-empty', !val); }
  });

  if (d.subjects && d.subjects.length > 0) {
    document.getElementById('subjectRows').innerHTML = '';
    subjectCount = 0;

    d.subjects.forEach(s => {
      addSubjectRow({
        code: s.code, name: s.name, credit: s.credit || '',
        creditLocked: s.credit > 0,
        internal: s.internal, external: s.external,
      });
    });

    recalcSummary();
  }

  // Clean the URL so refreshing doesn't re-import
  window.history.replaceState({}, document.title, window.location.pathname);

  const msgEl = document.getElementById('uploadMsg');
  if (msgEl) {
    showMsg(msgEl,
      `✓ Imported ${d.subjects ? d.subjects.length : 0} subject(s) from VTU Results page. Fill in Credits and verify before saving.`,
      'ok');
  }
}

/* ==================== BRANCH AUTO-DETECT FROM USN ==================== */
function detectBranchFromUSN(usn) {
  // VTU USN format: 1JV24IS022  — chars[5:7] = branch code
  usn = (usn || '').trim().toUpperCase();
  if (usn.length < 7) return '';
  const code = usn.slice(5, 7);
  // Match the DEFAULT_BRANCH_MAP from constants.py + common extras
  const branchMap = {
    'EC': 'ECE',  'IS': 'ISE',  'CS': 'CSE',
    'ME': 'ME',   'CV': 'CIVIL','EE': 'EEE',
    'ET': 'ETE',  'IM': 'IME',  'BT': 'BT',
    'CH': 'CHE',  'AI': 'AI&ML','AD': 'AI&DS',
    'CD': 'CSD',  'CY': 'CSE(CY)',
  };
  return branchMap[code] || code;
}
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('tab--active'));
      tab.classList.add('tab--active');
      const name = tab.dataset.tab;
      document.getElementById('uploadPanel').classList.toggle('hidden', name !== 'upload');
      document.getElementById('dashboardPanel').classList.toggle('hidden', name !== 'dashboard');
    });
  });
}

/* ==================== FILE UPLOAD (Images + PDFs) ==================== */
let uploadedFiles = [];  // { name, type, dataUrl, size }

function initImageUpload() {
  const zone  = document.getElementById('uploadZone');
  const input = document.getElementById('fileInput');

  zone.addEventListener('click', (e) => {
    if (!e.target.closest('label')) input.click();
  });

  zone.addEventListener('dragover',  (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files).filter(f => isAllowed(f));
    if (files.length) addFiles(files);
  });

  input.addEventListener('change', () => {
    const files = Array.from(input.files).filter(f => isAllowed(f));
    if (files.length) addFiles(files);
    input.value = '';
  });
}

function isAllowed(file) {
  return file.type.startsWith('image/') || file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function formatBytes(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1024*1024)  return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

function addFiles(files) {
  files.forEach(file => {
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      uploadedFiles.push({ name: file.name, type: 'pdf', dataUrl: null, size: file.size, fileObj: file });
      renderFileGrid();
      // Auto-parse the PDF
      parsePDF(file);
    } else {
      // Images — read as dataURL for thumbnail
      const reader = new FileReader();
      reader.onload = (e) => {
        uploadedFiles.push({ name: file.name, type: 'image', dataUrl: e.target.result, size: file.size });
        renderFileGrid();
      };
      reader.readAsDataURL(file);
    }
  });
}

/* ==================== PDF AUTO-PARSE ==================== */
async function parsePDF(file) {
  const msgEl = document.getElementById('uploadMsg');
  showMsg(msgEl, `⏳ Extracting data from "${file.name}"…`, 'ok');

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res  = await fetch('/api/parse-pdf', { method: 'POST', body: formData });
    const data = await res.json();

    if (!data.success) {
      showMsg(msgEl, `⚠ ${data.error}`, 'err');
      return;
    }

    const d = data.data;

    // Switch to edit mode so all fields are writable
    if (!isEditMode) enterEditMode();

    // ── Fill student details ───────────────────────────────────────────
    if (d.usn)          document.getElementById('usn').value          = d.usn;
    if (d.studentName)  document.getElementById('studentName').value  = d.studentName;
    if (d.semester)     document.getElementById('semester').value     = d.semester;
    if (d.branch)       document.getElementById('branch').value       = d.branch;
    // If server didn't return branch, derive it from USN
    if (!d.branch && d.usn) {
      const detectedBranch = detectBranchFromUSN(d.usn);
      if (detectedBranch) document.getElementById('branch').value = detectedBranch;
    }
    if (d.academicYear) document.getElementById('academicYear').value = d.academicYear;

    // Sync view displays immediately
    ['usn','studentName','semester','branch','academicYear'].forEach(id => {
      const val = document.getElementById(id).value.trim();
      const el  = document.getElementById(`view-${id}`);
      if (el) { el.textContent = val || '—'; el.classList.toggle('is-empty', !val); }
    });

    // ── Fill subjects ──────────────────────────────────────────────────
    if (d.subjects && d.subjects.length > 0) {
      document.getElementById('subjectRows').innerHTML = '';
      subjectCount = 0;

      d.subjects.forEach(s => {
        addSubjectRow({
          code:        s.code,
          name:        s.name,
          credit:      s.credit || '',   // auto-filled if admin has defined this subject
          creditLocked: s.credit > 0,    // lock it if admin already set it
          internal:    s.internal,
          external:    s.external,
          needsReview: s.needsReview,
          reviewReason: s.reviewReason,
        });
      });

      recalcSummary();
    }

    const count = d.subjects ? d.subjects.length : 0;
    const filled = [
      d.usn          ? `USN: ${d.usn}` : '',
      d.studentName  ? `Name: ${d.studentName}` : '',
      d.branch       ? `Branch: ${d.branch}` : '',
      d.semester     ? d.semester : '',
      d.academicYear ? d.academicYear : '',
    ].filter(Boolean).join(' · ');

    const msg = data.warning
      ? `✓ Extracted — ${filled} · ${count} subject(s). ⚠ ${data.warning}`
      : `✓ Extracted — ${filled} · ${count} subject${count !== 1 ? 's' : ''}. ${count > 0 ? 'Fill in Credits and save.' : ''}`;

    showMsg(msgEl, msg, data.warning ? 'err' : 'ok');

  } catch (err) {
    showMsg(msgEl, `Network error while parsing PDF: ${err.message}`, 'err');
  }
}

function removeFile(index) {
  uploadedFiles.splice(index, 1);
  renderFileGrid();
}

function clearAllImages() {   // kept as alias used by resetUploadForm
  uploadedFiles = [];
  renderFileGrid();
}

function renderFileGrid() {
  const grid = document.getElementById('fileGrid');
  const zone = document.getElementById('uploadZone');

  if (uploadedFiles.length === 0) {
    grid.classList.add('hidden');
    grid.innerHTML = '';
    zone.classList.remove('hidden');
    return;
  }

  zone.classList.add('hidden');
  grid.classList.remove('hidden');

  const cards = uploadedFiles.map((f, i) => {
    if (f.type === 'pdf') {
      return `
        <div class="pdf-card">
          <button class="pdf-card__remove" onclick="removeFile(${i})" title="Remove">✕</button>
          <svg class="pdf-card__icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="9" y1="13" x2="15" y2="13"/>
            <line x1="9" y1="17" x2="15" y2="17"/>
            <polyline points="9 9 10 9"/>
          </svg>
          <span class="pdf-card__name">${f.name}</span>
          <span class="pdf-card__size">${formatBytes(f.size)}</span>
        </div>`;
    } else {
      return `
        <div class="img-thumb">
          <img src="${f.dataUrl}" alt="${f.name}">
          <span class="img-thumb__name">${f.name}</span>
          <button class="img-thumb__remove" onclick="removeFile(${i})" title="Remove">✕</button>
        </div>`;
    }
  }).join('');

  const total    = uploadedFiles.length;
  const imgCount = uploadedFiles.filter(f => f.type === 'image').length;
  const pdfCount = uploadedFiles.filter(f => f.type === 'pdf').length;
  const summary  = [
    total + ` file${total > 1 ? 's' : ''}`,
    imgCount ? imgCount + ` image${imgCount > 1 ? 's' : ''}` : '',
    pdfCount ? pdfCount + ` PDF${pdfCount > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' · ');

  grid.innerHTML = cards + `
    <div style="grid-column:1/-1;" class="img-grid-actions">
      <span class="img-grid-count">${summary}</span>
      <label for="fileInput" class="btn btn--secondary btn--sm" style="cursor:pointer;">+ Add more</label>
      <button class="btn btn--ghost btn--sm" onclick="clearAllImages()">✕ Clear all</button>
    </div>`;
}

// Legacy alias — renderThumbnails was called nowhere externally but keep safe
function renderThumbnails() { renderFileGrid(); }

/* ==================== EDIT / VIEW MODE ==================== */
function enterEditMode() {
  isEditMode = true;
  document.getElementById('detailsView').classList.add('hidden');
  document.getElementById('detailsEdit').classList.remove('hidden');
  document.getElementById('addSubjectBtn').classList.remove('hidden');

  // show delete buttons on all rows
  document.querySelectorAll('.btn-delete-row').forEach(b => b.classList.remove('hidden'));
  // show input cells, hide text cells
  document.querySelectorAll('.cell-input').forEach(el => el.classList.remove('hidden'));
  document.querySelectorAll('.cell-text').forEach(el => el.classList.add('hidden'));

  const btn = document.getElementById('editToggleBtn');
  btn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
    Done Editing
  `;
  btn.classList.remove('btn--secondary');
  btn.classList.add('btn--primary');
}

function exitEditMode() {
  isEditMode = false;

  // copy input values → view display
  const fields = ['branch', 'semester', 'academicYear', 'usn', 'studentName'];
  fields.forEach(id => {
    const val = document.getElementById(id).value.trim();
    const el  = document.getElementById(`view-${id}`);
    el.textContent = val || '—';
    el.classList.toggle('is-empty', !val);
  });

  document.getElementById('detailsView').classList.remove('hidden');
  document.getElementById('detailsEdit').classList.add('hidden');
  document.getElementById('addSubjectBtn').classList.add('hidden');

  // hide delete buttons
  document.querySelectorAll('.btn-delete-row').forEach(b => b.classList.add('hidden'));
  // hide input cells, show text cells
  document.querySelectorAll('.cell-input').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.cell-text').forEach(el => el.classList.remove('hidden'));

  const btn = document.getElementById('editToggleBtn');
  btn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
    Edit Details
  `;
  btn.classList.remove('btn--primary');
  btn.classList.add('btn--secondary');
}

function toggleEditMode() {
  isEditMode ? exitEditMode() : enterEditMode();
}

/* ==================== VTU GRADE LOGIC (2025/2022/2021 Scheme) ==================== */
// O=10 (90-100), A+=9 (80-89), A=8 (70-79), B+=7 (60-69),
// B=6 (55-59), C=5 (50-54), P=4 (40-49), F=0 (0-39)
/* ── Grade helpers — all driven by CFG loaded from DB ── */
function getGradePoint(total) {
  for (const band of CFG.gradeScale) {
    if (total >= band.min) return band.grade;
  }
  return 0;
}

function getLetterGrade(total) {
  for (const band of CFG.gradeScale) {
    if (total >= band.min) return band.letter;
  }
  return 'F';
}

function getClassAwarded(hasFail, pct) {
  if (hasFail) return 'NC';
  for (const band of CFG.classAward) {
    if (pct >= band.min) return band.class;
  }
  return 'NC';
}

/* ==================== SUBJECT ROWS ==================== */
function addSubjectRow(prefill = {}) {
  subjectCount += 1;
  const id    = subjectCount;
  const tbody = document.getElementById('subjectRows');

  const tr = document.createElement('tr');
  tr.id = `row-${id}`;
  if (prefill.needsReview) {
    tr.classList.add('row--needs-review');
    tr.title = prefill.reviewReason || 'This subject needs a manual check.';
  }

  tr.innerHTML = `
    <td style="color:var(--muted);font-size:12px;text-align:center;">
      ${id}${prefill.needsReview ? ' <span class="review-flag" title="' + (prefill.reviewReason || 'Needs review').replace(/"/g, '&quot;') + '">⚠</span>' : ''}
    </td>

    <!-- Subject Code column -->
    <td>
      <input class="td-input td-input--code cell-input" type="text" id="code-${id}" placeholder="1BMATE101" value="${prefill.code || ''}">
      <span class="cell-text hidden" id="txt-code-${id}">—</span>
    </td>

    <!-- Subject Name column -->
    <td>
      <input class="td-input td-input--name cell-input" type="text" id="name-${id}" placeholder="Subject Name" value="${prefill.name || ''}">
      <span class="cell-text hidden" id="txt-name-${id}">—</span>
    </td>

    <!-- Credit column -->
    <td>
      <input class="td-input td-input--num cell-input" type="number" id="credit-${id}" placeholder="4" min="0" max="10" value="${prefill.credit || ''}" ${prefill.creditLocked ? 'readonly title="Credit set by Admin — cannot be changed"' : ''}>
      <span class="cell-text hidden" id="txt-credit-${id}">—</span>
    </td>

    <!-- Internal column -->
    <td>
      <input class="td-input td-input--num cell-input" type="number" id="internal-${id}" placeholder="0" min="0" max="50" value="${prefill.internal || ''}">
      <span class="cell-text hidden" id="txt-internal-${id}">—</span>
    </td>

    <!-- External column -->
    <td>
      <input class="td-input td-input--num cell-input" type="number" id="external-${id}" placeholder="0" min="0" max="50" value="${prefill.external || ''}">
      <span class="cell-text hidden" id="txt-external-${id}">—</span>
    </td>

    <!-- Computed (always visible) -->
    <td id="total-${id}"  style="font-weight:600;text-align:center;">—</td>
    <td id="grade-${id}"  style="font-weight:600;color:var(--muted);text-align:center;">—</td>
    <td id="result-${id}" style="text-align:center;"><span class="badge badge--na">—</span></td>

    <!-- Delete (hidden in view mode) -->
    <td style="text-align:center;">
      <button class="btn btn--danger btn--sm btn-delete-row" data-remove="${id}">✕</button>
    </td>
  `;

  tbody.appendChild(tr);

  const internalEl = tr.querySelector(`#internal-${id}`);
  const externalEl = tr.querySelector(`#external-${id}`);
  const creditEl   = tr.querySelector(`#credit-${id}`);

  internalEl.addEventListener('input', () => recalcRow(id));
  externalEl.addEventListener('input', () => recalcRow(id));
  creditEl.addEventListener('input', recalcSummary);

  tr.querySelector(`[data-remove="${id}"]`).addEventListener('click', () => {
    tr.remove();
    recalcSummary();
  });

  // if not currently in edit mode, hide inputs / show text immediately
  if (!isEditMode) {
    tr.querySelectorAll('.cell-input').forEach(el => el.classList.add('hidden'));
    tr.querySelectorAll('.cell-text').forEach(el => el.classList.remove('hidden'));
    tr.querySelector('.btn-delete-row').classList.add('hidden');
  }

  if (prefill.internal !== undefined || prefill.external !== undefined) {
    recalcRow(id);
  }
}

function recalcRow(id) {
  const internal = parseFloat(document.getElementById(`internal-${id}`).value) || 0;
  const external = parseFloat(document.getElementById(`external-${id}`).value) || 0;
  const total    = internal + external;
  const hasData  = document.getElementById(`internal-${id}`).value !== '' ||
                   document.getElementById(`external-${id}`).value !== '';

  const totalEl  = document.getElementById(`total-${id}`);
  const gradeEl  = document.getElementById(`grade-${id}`);
  const resultEl = document.getElementById(`result-${id}`);

  // sync text cells
  document.getElementById(`txt-code-${id}`).textContent     = document.getElementById(`code-${id}`).value     || '—';
  document.getElementById(`txt-name-${id}`).textContent     = document.getElementById(`name-${id}`).value     || '—';
  document.getElementById(`txt-credit-${id}`).textContent   = document.getElementById(`credit-${id}`).value   || '—';
  document.getElementById(`txt-internal-${id}`).textContent = document.getElementById(`internal-${id}`).value || '—';
  document.getElementById(`txt-external-${id}`).textContent = document.getElementById(`external-${id}`).value || '—';

  if (!hasData) {
    totalEl.textContent  = '—';
    gradeEl.textContent  = '—';
    resultEl.innerHTML   = '<span class="badge badge--na">—</span>';
  } else {
    const gp     = getGradePoint(total);
    const letter = getLetterGrade(total);
    totalEl.textContent  = total;
    gradeEl.innerHTML    = `${gp} <span style="font-size:11px;color:var(--muted);">(${letter})</span>`;
    resultEl.innerHTML   = gp > 0
      ? '<span class="badge badge--pass">PASS</span>'
      : '<span class="badge badge--fail">FAIL</span>';
  }

  recalcSummary();
}

// also sync text cells when only code/name/credit changes (no recalcRow trigger)
function syncTextCells(id) {
  document.getElementById(`txt-code-${id}`).textContent   = document.getElementById(`code-${id}`).value   || '—';
  document.getElementById(`txt-name-${id}`).textContent   = document.getElementById(`name-${id}`).value   || '—';
  document.getElementById(`txt-credit-${id}`).textContent = document.getElementById(`credit-${id}`).value || '—';
}

function collectSubjects() {
  return Array.from(document.querySelectorAll('#subjectRows tr')).reduce((acc, row) => {
    const id = row.id.split('-')[1];
    if (!id) return acc;

    const code     = document.getElementById(`code-${id}`).value.trim();
    const name     = document.getElementById(`name-${id}`).value.trim();
    const credit   = parseFloat(document.getElementById(`credit-${id}`).value)   || 0;
    const internal = parseFloat(document.getElementById(`internal-${id}`).value) || 0;
    const external = parseFloat(document.getElementById(`external-${id}`).value) || 0;
    const total    = internal + external;
    const grade        = getGradePoint(total);
    const letterGrade  = getLetterGrade(total);
    const result       = grade > 0 ? 'P' : 'F';
    const creditPoints = grade * credit;

    if (code) acc.push({ code, name, credit, internal, external, total, grade, letterGrade, result, creditPoints });
    return acc;
  }, []);
}

function recalcSummary() {
  const subjects = collectSubjects();
  const sumTotal  = subjects.reduce((a, s) => a + s.total, 0);
  const totCred   = subjects.reduce((a, s) => a + s.credit, 0);
  const totCP     = subjects.reduce((a, s) => a + s.creditPoints, 0);
  const sgpa      = totCred > 0 ? totCP / totCred : 0;
  // VTU formula: Percentage = (SGPA - 0.75) × 10
  const pct       = sgpa > 0 ? Math.max(0, (sgpa - 0.75) * 10) : 0;
  const hasFail   = subjects.some(s => s.result === 'F');
  const cls       = subjects.length > 0 ? getClassAwarded(hasFail, pct) : '—';

  document.getElementById('sumTotal').textContent = subjects.length > 0 ? sumTotal   : '0';
  document.getElementById('sumPct').textContent   = subjects.length > 0 ? `${pct.toFixed(2)}%` : '0%';
  document.getElementById('sumSgpa').textContent  = subjects.length > 0 ? sgpa.toFixed(2) : '0.00';
  document.getElementById('sumClass').textContent = cls;
}

/* ==================== SAVE RESULT ==================== */
async function saveResult() {
  const branch       = document.getElementById('branch').value.trim();
  const semester     = document.getElementById('semester').value.trim();
  const academicYear = document.getElementById('academicYear').value.trim();
  const usn          = document.getElementById('usn').value.trim();
  const studentName  = document.getElementById('studentName').value.trim();
  const subjects     = collectSubjects();
  const msgEl        = document.getElementById('uploadMsg');

  if (!branch || !semester || !academicYear) {
    showMsg(msgEl, 'Please fill Branch, Semester, and Academic Year.', 'err'); return;
  }
  if (!usn || !studentName) {
    showMsg(msgEl, 'Please fill USN and Student Name.', 'err'); return;
  }
  if (subjects.length === 0) {
    showMsg(msgEl, 'Please add at least one subject with a subject code.', 'err'); return;
  }

  const saveBtn = document.getElementById('saveResultBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  try {
    const res  = await fetch(API.saveResult, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ branch, semester, academicYear, usn, studentName, subjects })
    });
    const data = await res.json();

    if (data.success) {
      showMsg(msgEl, '✓ Result saved successfully.', 'ok');
      resetUploadForm();
      loadLookups();
    } else {
      showMsg(msgEl, data.error || 'Failed to save result.', 'err');
    }
  } catch (err) {
    showMsg(msgEl, `Network error: ${err.message}`, 'err');
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Result`;
  }
}

function resetUploadForm() {
  ['branch','semester','academicYear','usn','studentName'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('subjectRows').innerHTML = '';
  subjectCount = 0;

  // Reset view displays
  ['branch','semester','academicYear','usn','studentName'].forEach(id => {
    const el = document.getElementById(`view-${id}`);
    if (el) { el.textContent = '—'; el.classList.add('is-empty'); }
  });

  recalcSummary();

  // Reset files
  clearAllImages();
  document.getElementById('uploadZone').classList.remove('hidden');
  document.getElementById('fileInput').value = '';

  // Go back to view mode with a fresh empty row
  isEditMode = true;   // trick so addSubjectRow adds in edit-visible state
  addSubjectRow();
  isEditMode = false;  // then snap back to view mode UI
  exitEditMode();
}

function showMsg(el, text, type) {
  el.textContent = text;
  el.className   = `message message--${type}`;
}

/* ==================== LOOKUPS ==================== */
async function loadLookups() {
  try {
    const res  = await fetch(API.lookups);
    const data = await res.json();
    if (!data.success) return;

    fillDatalist('branchList', data.branches);
    fillDatalist('semList',    data.semesters);
    fillDatalist('yearList',   data.academicYears);

    fillSelect('filterBranch',   data.branches);
    fillSelect('filterSemester', data.semesters);
    fillSelect('filterYear',     data.academicYears);

    // Re-apply cascade state after selects are populated
    if (typeof initDashboardCascade === 'function') initDashboardCascade();
  } catch (e) {
    console.warn('Lookups fetch failed:', e);
  }
}

function fillDatalist(id, values) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = (values || []).map(v => `<option value="${v}">`).join('');
}

function fillSelect(id, values) {
  const el = document.getElementById(id);
  if (!el) return;
  const def = el.options[0].outerHTML;
  el.innerHTML = def + (values || []).map(v => `<option value="${v}">${v}</option>`).join('');
}

/* ==================== DASHBOARD FILTER CASCADE ==================== */
function initDashboardCascade() {
  const branchSel   = document.getElementById('filterBranch');
  const semesterSel = document.getElementById('filterSemester');
  const yearSel     = document.getElementById('filterYear');
  const loadBtn     = document.getElementById('loadAnalysisBtn');

  function updateState() {
    const hasBranch   = !!branchSel.value;
    const hasSemester = !!semesterSel.value;
    const hasYear     = !!yearSel.value;

    semesterSel.disabled = !hasBranch;
    yearSel.disabled     = !hasBranch || !hasSemester;
    loadBtn.disabled     = !hasBranch || !hasSemester || !hasYear;

    // Visual hint
    semesterSel.style.opacity = hasBranch   ? '1' : '0.45';
    yearSel.style.opacity     = (hasBranch && hasSemester) ? '1' : '0.45';
    loadBtn.style.opacity     = (hasBranch && hasSemester && hasYear) ? '1' : '0.55';
  }

  branchSel.addEventListener('change', () => {
    // Reset downstream when branch changes
    semesterSel.value = '';
    yearSel.value     = '';
    document.getElementById('dashResults').classList.add('hidden');
    document.getElementById('downloadCSVBtn').classList.add('hidden');
    updateState();
  });

  semesterSel.addEventListener('change', () => {
    yearSel.value = '';
    document.getElementById('dashResults').classList.add('hidden');
    document.getElementById('downloadCSVBtn').classList.add('hidden');
    updateState();
  });

  yearSel.addEventListener('change', updateState);

  // Set initial state
  updateState();
}

/* ==================== ANALYSIS ==================== */
async function loadAnalysis() {
  const branch       = document.getElementById('filterBranch').value;
  const semester     = document.getElementById('filterSemester').value;
  const academicYear = document.getElementById('filterYear').value;

  if (!branch || !semester || !academicYear) return; // cascade prevents this, safety guard

  const btn = document.getElementById('loadAnalysisBtn');
  btn.disabled    = true;
  btn.textContent = 'Loading…';

  document.getElementById('dashResults').classList.add('hidden');
  document.getElementById('downloadCSVBtn').classList.add('hidden');

  try {
    const params = new URLSearchParams({ branch, semester, academicYear });
    const res    = await fetch(`${API.analysis}?${params}`);
    const data   = await res.json();

    if (!data.success) { alert(data.error || 'Failed to load analysis.'); return; }

    if (!data.students || data.students.length === 0) {
      alert('No results found for this selection.');
      document.getElementById('dashResults').classList.add('hidden');
      return;
    }

    renderDashboard(data.students);
  } catch (e) {
    alert(`Error: ${e.message}`);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Load Analysis';
  }
}

function renderDashboard(students) {
  document.getElementById('dashResults').classList.remove('hidden');
  document.getElementById('downloadCSVBtn').classList.remove('hidden');

  const total     = students.length;
  const passCount = students.filter(s => s.classAwarded !== 'NC').length;
  const failCount = total - passCount;
  const pct       = total > 0 ? (passCount / total) * 100 : 0;

  document.getElementById('statTotalStudents').textContent = total;
  document.getElementById('statOverallPct').textContent    = `${pct.toFixed(1)}%`;
  document.getElementById('statPassCount').textContent     = passCount;
  document.getElementById('statFailCount').textContent     = failCount;

  // class distribution
  document.getElementById('classFCD').textContent = students.filter(s => s.classAwarded === 'FCD').length;
  document.getElementById('classFC').textContent  = students.filter(s => s.classAwarded === 'FC').length;
  document.getElementById('classSC').textContent  = students.filter(s => s.classAwarded === 'SC').length;
  document.getElementById('classNC').textContent  = students.filter(s => s.classAwarded === 'NC').length;

  renderToppers(students);
  renderAllStudents(students);
  renderSubjectAnalysis(students);
}

function renderToppers(students) {
  const ranked = [...students].sort((a, b) =>
    b.totalCreditPoints - a.totalCreditPoints || b.sumTotal - a.sumTotal
  );

  const tbody = document.querySelector('#topperTable tbody');
  tbody.innerHTML = '';

  const topN = CFG.appSettings.toppersCount || 3;
  ranked.slice(0, topN).forEach((s, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="topper-badge">${i + 1}</span></td>
      <td>${s.usn}</td>
      <td style="text-align:left">${s.studentName}</td>
      <td>${s.sumTotal}</td>
      <td>${s.totalCreditPoints}</td>
      <td>${s.sgpa}</td>
      <td>${s.percentage}%</td>
      <td><span class="badge ${s.classAwarded !== 'NC' ? 'badge--pass' : 'badge--fail'}">${s.classAwarded}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

function renderAllStudents(students) {
  const sorted = [...students].sort((a, b) => (a.usn || '').localeCompare(b.usn || ''));

  // Collect all unique subjects (ordered by their first appearance across all students)
  const subjectOrder = [];
  const subjectNames = {};
  sorted.forEach(s => {
    (s.subjects || []).forEach(sub => {
      if (!subjectNames[sub.code]) {
        subjectOrder.push(sub.code);
        subjectNames[sub.code] = sub.name || sub.code;
      }
    });
  });

  // Fixed left column widths (px) — must match CSS .col-sl, .col-usn, .col-name
  const COL_SL   = 48;
  const COL_USN  = 120;
  const COL_NAME = 160;
  const LEFT = {
    sl:   0,
    usn:  COL_SL,
    name: COL_SL + COL_USN,
  };

  // ── Build thead ──────────────────────────────────────────────────────────
  const thead = document.getElementById('allStudentsHead');
  thead.innerHTML = '';

  // Row 1: group headers
  const row1 = document.createElement('tr');

  // Fixed left cols — rowSpan=2 so they span both header rows
  [
    { label: 'Sl No',        cls: 'sticky-left col-sl',   left: LEFT.sl   },
    { label: 'USN',          cls: 'sticky-left col-usn',  left: LEFT.usn  },
    { label: 'Student Name', cls: 'sticky-left col-name', left: LEFT.name },
  ].forEach(({ label, cls, left }) => {
    const th = document.createElement('th');
    th.rowSpan = 2;
    th.textContent = label;
    th.className = cls;
    th.style.left = left + 'px';
    th.style.minWidth = (label === 'Sl No' ? COL_SL : label === 'USN' ? COL_USN : COL_NAME) + 'px';
    row1.appendChild(th);
  });

  // Subject group headers — each spans 5 sub-cols
  subjectOrder.forEach((code, si) => {
    const th = document.createElement('th');
    th.colSpan = 5;
    th.textContent = `Subject ${si + 1} — ${subjectNames[code]}`;
    th.className = `subj-hdr-${si % 8}`;
    row1.appendChild(th);
  });

  // Tail summary headers — rowSpan=2
  ['Total Marks', 'Total GP', 'SGPA', 'Percentage %', 'Class Awarded'].forEach(label => {
    const th = document.createElement('th');
    th.rowSpan = 2;
    th.textContent = label;
    th.className = 'tail-hdr';
    row1.appendChild(th);
  });
  thead.appendChild(row1);

  // Row 2: sub-column headers (In / Ex / Tot / Re / GP) for each subject
  const row2 = document.createElement('tr');
  subjectOrder.forEach((_, si) => {
    ['In', 'Ex', 'Tot', 'Re', 'GP'].forEach(label => {
      const th = document.createElement('th');
      th.textContent = label;
      th.className = `subj-hdr-${si % 8}`;
      row2.appendChild(th);
    });
  });
  thead.appendChild(row2);

  // ── Build tbody ──────────────────────────────────────────────────────────
  const tbody = document.getElementById('allStudentsBody');
  tbody.innerHTML = '';

  sorted.forEach((s, i) => {
    const subMap = {};
    (s.subjects || []).forEach(sub => { subMap[sub.code] = sub; });

    const tr = document.createElement('tr');

    // Fixed left cells
    [
      { text: i + 1,          cls: 'sticky-left col-sl',   left: LEFT.sl,   extraStyle: 'color:var(--muted);font-size:11px' },
      { text: s.usn,          cls: 'sticky-left col-usn',  left: LEFT.usn,  extraStyle: 'font-family:monospace;font-size:11px' },
      { text: s.studentName,  cls: 'sticky-left col-name', left: LEFT.name, extraStyle: 'text-align:left;font-weight:500' },
    ].forEach(({ text, cls, left, extraStyle }) => {
      const td = document.createElement('td');
      td.textContent = text;
      td.className = cls;
      td.style.left = left + 'px';
      if (extraStyle) td.setAttribute('style', td.getAttribute('style') || '' + ';' + extraStyle);
      td.style.left = left + 'px';   // re-set after setAttribute
      tr.appendChild(td);
    });

    // Subject data cells
    subjectOrder.forEach(code => {
      const sub = subMap[code];
      if (sub) {
        const isPass = sub.result === 'P';
        const gp     = sub.grade !== undefined ? sub.grade : (sub.gradePoint || 0);
        [
          { val: sub.internal,  style: '' },
          { val: sub.external,  style: '' },
          { val: sub.total,     style: 'font-weight:600' },
          { val: sub.result,    isResult: true, pass: isPass },
          { val: gp,            style: isPass ? 'color:var(--accent-2)' : 'color:var(--danger)' },
        ].forEach(col => {
          const td = document.createElement('td');
          if (col.isResult) {
            td.innerHTML = `<span class="${col.pass ? 'res-pass' : 'res-fail'}">${col.val}</span>`;
          } else {
            td.textContent = col.val ?? '—';
            if (col.style) td.setAttribute('style', col.style);
          }
          tr.appendChild(td);
        });
      } else {
        for (let k = 0; k < 5; k++) {
          const td = document.createElement('td');
          td.textContent = '—';
          td.style.color = 'var(--muted)';
          tr.appendChild(td);
        }
      }
    });

    // Tail summary cells
    const isNC = s.classAwarded === 'NC';
    [
      { val: s.sumTotal,          style: 'font-weight:600' },
      { val: s.totalCreditPoints, style: '' },
      { val: s.sgpa,              style: 'font-weight:700;color:var(--accent-2)' },
      { val: `${s.percentage}%`,  style: '' },
      { val: s.classAwarded,      style: isNC ? 'color:var(--danger);font-weight:700' : 'color:var(--accent-2);font-weight:700' },
    ].forEach(col => {
      const td = document.createElement('td');
      td.textContent = col.val;
      if (col.style) td.setAttribute('style', col.style);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  window._lastAnalysisStudents     = sorted;
  window._lastAnalysisSubjectOrder = subjectOrder;
  window._lastAnalysisSubjectNames = subjectNames;
}

/* ==================== CSV DOWNLOAD ==================== */
function downloadCSV() {
  const branch       = document.getElementById('filterBranch').value;
  const semester     = document.getElementById('filterSemester').value;
  const academicYear = document.getElementById('filterYear').value;

  const students    = window._lastAnalysisStudents || [];
  const subOrder    = window._lastAnalysisSubjectOrder || [];
  const subNames    = window._lastAnalysisSubjectNames || {};

  if (!students.length) return;

  // Build header rows
  const row1 = ['Sl No', 'USN', 'Student Name'];
  const row2 = ['', '', ''];
  subOrder.forEach((code, si) => {
    const label = `Subject ${si + 1} (${subNames[code]})`;
    row1.push(label, '', '', '', '');
    row2.push('In', 'Ex', 'Tot', 'Re', 'GP');
  });
  row1.push('Total Marks', 'Total GP', 'SGPA', 'Percentage %', 'Class Awarded');
  row2.push('', '', '', '', '');

  const lines = [
    `"Result Analysis – Branch: ${branch} | Semester: ${semester} | Year: ${academicYear}"`,
    row1.map(v => `"${v}"`).join(','),
    row2.map(v => `"${v}"`).join(','),
  ];

  students.forEach((s, i) => {
    const subMap = {};
    (s.subjects || []).forEach(sub => { subMap[sub.code] = sub; });

    const row = [i + 1, s.usn, s.studentName];
    subOrder.forEach(code => {
      const sub = subMap[code];
      if (sub) {
        const gp = sub.grade !== undefined ? sub.grade : sub.gradePoint || 0;
        row.push(sub.internal, sub.external, sub.total, sub.result, gp);
      } else {
        row.push('—', '—', '—', '—', '—');
      }
    });
    row.push(s.sumTotal, s.totalCreditPoints, s.sgpa, `${s.percentage}%`, s.classAwarded);

    lines.push(row.map((v, ci) => ci === 2 ? `"${v}"` : v).join(','));
  });

  const csv  = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `results_${branch}_${semester}_${academicYear}.csv`.replace(/\s+/g, '_');
  a.click();
  URL.revokeObjectURL(url);
}

function renderSubjectAnalysis(students) {
  const map = {};
  students.forEach(s => {
    (s.subjects || []).forEach(sub => {
      if (!map[sub.code]) {
        map[sub.code] = { name: sub.name, count: 0, pass: 0 };
      }
      const m = map[sub.code];
      m.count += 1;
      if (sub.result === 'P') m.pass += 1;
    });
  });

  const tbody = document.querySelector('#subjectTable tbody');
  tbody.innerHTML = '';
  Object.entries(map).forEach(([code, m]) => {
    const fail    = m.count - m.pass;
    const passPct = ((m.pass / m.count) * 100).toFixed(1);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-family:monospace;font-size:12px">${code}</td>
      <td style="text-align:left">${m.name}</td>
      <td style="color:var(--accent-2);font-weight:600">${m.pass}</td>
      <td style="color:var(--danger);font-weight:600">${fail}</td>
      <td>${passPct}%</td>
    `;
    tbody.appendChild(tr);
  });
}
