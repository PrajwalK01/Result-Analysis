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
  scheme:      { maxMarksPerSubject: 100, maxInternalMarks: 50, maxExternalMarks: 100, maxCredit: 10, minExternalPass: 18 },
  appSettings: { toppersCount: 3 },
  branchMap:   {},   // {USN_code: branch_name} — e.g. {"CS":"CSE","IS":"ISE",...}
  subjectCreditsMap:   {},   // {subjectCode: credit} — set per-subject in Admin → Subjects
  externalRequiredMap: {},   // {subjectCode: bool}   — set per-subject in Admin → Subjects
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
      CFG.branchMap   = data.branchMap   || CFG.branchMap;
      CFG.subjectCreditsMap   = data.subjectCredits          || CFG.subjectCreditsMap;
      CFG.externalRequiredMap = data.subjectExternalRequired || CFG.externalRequiredMap;
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
  document.getElementById('fixAbsentBtn').addEventListener('click', fixAbsentData);

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

  await loadImportedFromBookmarklet();
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

        // Find the result cell — VTU puts P/F/A/W/X/NE/NA in the Result column.
        // Search cells[5] onwards for a recognisable result code so layout
        // changes (extra columns) don't silently turn Absent into Fail.
        var result = '';
        for(var ci=5; ci<cells.length; ci++){
          var rv = (cells[ci]||'').trim().toUpperCase();
          if(/^(P|F|A|AB|W|X|NE|NA)$/.test(rv)){ result = rv; break; }
        }
        // Only fall back to computed P/F when we truly found no result code
        // AND there are actual marks — never default to F when marks are zero
        // (zero external = absent, not necessarily fail)
        if(!result){
          result = (internal>0||external>0) ? (total>=40?'P':'F') : 'A';
        }

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
async function loadImportedFromBookmarklet() {
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

  // ── Enrich subjects with credits from DB (same as PDF parse does) ───────
  if (d.subjects && d.subjects.length > 0) {
    try {
      const res = await fetch('/api/resolve-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usn: d.usn, subjects: d.subjects }),
      });
      const enriched = await res.json();
      if (enriched.success) {
        d.subjects = enriched.subjects;   // replace with enriched (has creditDefined)
        if (enriched.branch && !d.branch) d.branch = enriched.branch;
      }
    } catch (err) {
      console.warn('Failed to enrich subjects with credits:', err);
    }
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

  // If server returned branch from resolve-import, use it
  if (d.branch) {
    const branchInput = document.getElementById('branch');
    if (!branchInput.value.trim()) branchInput.value = d.branch;
  }

  ['usn', 'studentName', 'semester', 'branch'].forEach(id => {
    const val = document.getElementById(id).value.trim();
    const el  = document.getElementById(`view-${id}`);
    if (el) { el.textContent = val || '—'; el.classList.toggle('is-empty', !val); }
  });

  if (d.subjects && d.subjects.length > 0) {
    document.getElementById('subjectRows').innerHTML = '';
    subjectCount = 0;

    d.subjects.forEach(s => {
      const isAbsent = ['A','AB','W','X','NE','NA','-'].includes((s.result||'').toUpperCase());
      addSubjectRow({
        code: s.code, name: s.name,
        credit: s.creditDefined ? s.credit : '',
        creditLocked: !!s.creditDefined,
        internal: isAbsent ? '' : s.internal,
        external: isAbsent ? '' : s.external,
        result:   s.result,
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
  // VTU USN format: 1JV24IS022 — chars[5:7] = branch code
  // Uses CFG.branchMap loaded from DB via /api/config — no hardcoding here.
  usn = (usn || '').trim().toUpperCase();
  if (usn.length < 7) return '';
  const code = usn.slice(5, 7);
  return CFG.branchMap[code] || code;
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
        const isAbsent = ['A','AB','W','X','NE','NA','-'].includes((s.result||'').toUpperCase());
        addSubjectRow({
          code:        s.code,
          name:        s.name,
          credit:      s.creditDefined ? s.credit : '',
          creditLocked: !!s.creditDefined,
          internal:    isAbsent ? '' : s.internal,
          external:    isAbsent ? '' : s.external,
          result:      s.result,
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

// Mirrors the same rules enforced server-side in save_result():
// A subject fails if external < minExternalPass OR internal < minInternalPass,
// regardless of total — unless admin has disabled external requirement for this code.
function applyExternalPassRule(code, external, gp, letter, internal) {
  const minExternal = (CFG.scheme && CFG.scheme.minExternalPass) || 18;
  const minInternal = (CFG.scheme && CFG.scheme.minInternalPass) || 22;
  const requiresExternal = CFG.externalRequiredMap[code] !== undefined
    ? CFG.externalRequiredMap[code]
    : true;
  if (requiresExternal) {
    if (external < minExternal) return { gp: 0, letter: 'F' };
    if (internal  < minInternal) return { gp: 0, letter: 'F' };
  }
  return { gp, letter };
}

// Runs whenever the subject-code field is edited by hand. If the admin has
// already defined a credit for this code (Admin → Subjects), pull it in
// automatically and lock the field — same treatment a PDF-parsed row gets.
// If the code isn't recognised, unlock the field so the user can type a
// credit in themselves.
function autoFillCreditFromAdmin(id) {
  const codeEl   = document.getElementById(`code-${id}`);
  const creditEl = document.getElementById(`credit-${id}`);
  if (!codeEl || !creditEl) return;

  const code = codeEl.value.trim().toUpperCase();
  const isDefined = !!code && Object.prototype.hasOwnProperty.call(CFG.subjectCreditsMap, code);

  if (isDefined) {
    creditEl.value    = CFG.subjectCreditsMap[code];   // may legitimately be 0
    creditEl.readOnly = true;
    creditEl.title    = 'Credit set by Admin — cannot be changed';
  } else {
    creditEl.readOnly = false;
    creditEl.title    = '';
  }

  syncTextCells(id);
  recalcSummary();
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
      <input class="td-input td-input--num cell-input" type="number" id="credit-${id}" placeholder="4" min="0" max="10" value="${prefill.credit ?? ''}" ${prefill.creditLocked ? 'readonly title="Credit set by Admin — cannot be changed"' : ''}>
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
    <td id="result-${id}" style="text-align:center;">
      <span class="badge badge--na">—</span>
      <label class="absent-label cell-input" style="display:block;margin-top:4px;font-size:10px;color:var(--warning);cursor:pointer;">
        <input type="checkbox" id="absent-${id}" style="margin-right:3px;" ${['A','AB','W','X','NE','NA','-'].includes((prefill.result||'').toUpperCase()) ? 'checked' : ''}>Absent
      </label>
    </td>

    <!-- Delete (hidden in view mode) -->
    <td style="text-align:center;">
      <button class="btn btn--danger btn--sm btn-delete-row" data-remove="${id}">✕</button>
    </td>
  `;

  tbody.appendChild(tr);

  const codeEl     = tr.querySelector(`#code-${id}`);
  const internalEl = tr.querySelector(`#internal-${id}`);
  const externalEl = tr.querySelector(`#external-${id}`);
  const creditEl   = tr.querySelector(`#credit-${id}`);
  const absentEl   = tr.querySelector(`#absent-${id}`);

  codeEl.addEventListener('blur', () => autoFillCreditFromAdmin(id));
  internalEl.addEventListener('input', () => recalcRow(id));
  externalEl.addEventListener('input', () => recalcRow(id));
  creditEl.addEventListener('input', recalcSummary);
  absentEl.addEventListener('change', () => {
    if (absentEl.checked) {
      // Clear marks when absent is ticked
      internalEl.value = '';
      externalEl.value = '';
    }
    recalcRow(id);
  });

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

  if (prefill.internal !== undefined || prefill.external !== undefined || prefill.result) {
    recalcRow(id);
  }
}

function recalcRow(id) {
  const internal = parseFloat(document.getElementById(`internal-${id}`).value) || 0;
  const external = parseFloat(document.getElementById(`external-${id}`).value) || 0;
  const total    = internal + external;
  const internalBlank = document.getElementById(`internal-${id}`).value.trim() === '';
  const externalBlank = document.getElementById(`external-${id}`).value.trim() === '';

  // Check if this subject requires an external exam
  const code = document.getElementById(`code-${id}`).value.trim().toUpperCase();
  const requiresExternal = CFG.externalRequiredMap && CFG.externalRequiredMap[code] !== undefined
    ? CFG.externalRequiredMap[code]
    : true;   // default: external is required

  // Absent when external is blank AND external is required for this subject.
  // If external is not required (lab/Yoga), blank external just means 0 — not absent.
  const hasData = !externalBlank || !requiresExternal;

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
    // Both fields blank = Absent
    totalEl.textContent = '—';
    gradeEl.textContent = '—';
    resultEl.innerHTML  = '<span class="badge badge--absent">ABSENT</span>';
  } else {
    const code     = document.getElementById(`code-${id}`).value.trim().toUpperCase();
    const absentCb = document.getElementById(`absent-${id}`);
    // Also absent if checkbox is ticked even when marks exist
    const isAbsent = absentCb && absentCb.checked;

    if (isAbsent) {
      totalEl.textContent = '—';
      gradeEl.textContent = '—';
      resultEl.innerHTML  = '<span class="badge badge--absent">ABSENT</span>';
    } else {
      let gp     = getGradePoint(total);
      let letter = getLetterGrade(total);
      ({ gp, letter } = applyExternalPassRule(code, external, gp, letter, internal));
      totalEl.textContent  = total;
      gradeEl.innerHTML    = `${gp} <span style="font-size:11px;color:var(--muted);">(${letter})</span>`;
      resultEl.innerHTML   = gp > 0
        ? '<span class="badge badge--pass">PASS</span>'
        : '<span class="badge badge--fail">FAIL</span>';
    }
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
    const credit   = parseFloat(document.getElementById(`credit-${id}`).value) || 0;

    const internalInput = document.getElementById(`internal-${id}`);
    const externalInput = document.getElementById(`external-${id}`);
    const absentCb      = document.getElementById(`absent-${id}`);

    // A subject is absent when:
    // 1. The absent checkbox is ticked, OR
    // 2. External field is blank AND the subject requires an external exam.
    //    Subjects with externalRequired=false (labs, Yoga, etc.) have no
    //    external component — blank/0 external for them is normal, not absent.
    const externalBlank = !externalInput || externalInput.value.trim() === '';
    const subCode = code.toUpperCase();
    const requiresExt = CFG.externalRequiredMap && CFG.externalRequiredMap[subCode] !== undefined
      ? CFG.externalRequiredMap[subCode]
      : true;   // default: external required
    const isAbsent = (absentCb && absentCb.checked) || (externalBlank && requiresExt);

    if (isAbsent) {
      if (code) acc.push({
        code, name, credit, internal: 0, external: 0, total: 0,
        grade: 0, letterGrade: 'A', result: 'A', creditPoints: 0,
      });
      return acc;
    }

    const internal = parseFloat(internalInput.value) || 0;
    const external = parseFloat(externalInput.value) || 0;
    const total    = internal + external;
    let grade        = getGradePoint(total);
    let letterGrade  = getLetterGrade(total);
    ({ gp: grade, letter: letterGrade } = applyExternalPassRule(code.toUpperCase(), external, grade, letterGrade, internal));
    const result       = grade > 0 ? 'P' : 'F';
    const creditPoints = grade * credit;

    if (code) acc.push({ code, name, credit, internal, external, total, grade, letterGrade, result, creditPoints });
    return acc;
  }, []);
}

function recalcSummary() {
  const subjects = collectSubjects();
  // Absent subjects don't contribute to SGPA/percentage/class
  const appeared  = subjects.filter(s => s.result !== 'A');
  const sumTotal  = appeared.reduce((a, s) => a + s.total, 0);
  const totCred   = appeared.reduce((a, s) => a + s.credit, 0);
  const totCP     = appeared.reduce((a, s) => a + s.creditPoints, 0);
  const sgpa      = totCred > 0 ? totCP / totCred : 0;
  const pct       = sgpa > 0 ? sgpa * 10 : 0;
  const hasFail   = appeared.some(s => s.result === 'F');
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
    document.getElementById('fixAbsentBtn').classList.add('hidden');
    updateState();
  });

  semesterSel.addEventListener('change', () => {
    yearSel.value = '';
    document.getElementById('dashResults').classList.add('hidden');
    document.getElementById('downloadCSVBtn').classList.add('hidden');
    document.getElementById('fixAbsentBtn').classList.add('hidden');
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
  document.getElementById('fixAbsentBtn').classList.add('hidden');

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

    renderDashboard(data.students, data.teacherMap || {});
  } catch (e) {
    alert(`Error: ${e.message}`);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Load Analysis';
  }
}

// Store current dashboard filter context so edit/delete can reference it
let _dashCtx = { branch: '', semester: '', academicYear: '' };

/* ==================== FIX ABSENT DATA ==================== */
async function fixAbsentData() {
  const { branch, semester, academicYear } = _dashCtx;
  if (!branch || !semester || !academicYear) return;

  if (!confirm(
    `This will scan all saved results for:\nBranch: ${branch} | Sem: ${semester} | Year: ${academicYear}\n\n` +
    `Any subject where Internal=0 AND External=0 AND Result=F will be corrected to Absent (A).\n\n` +
    `Proceed?`
  )) return;

  const btn = document.getElementById('fixAbsentBtn');
  btn.disabled    = true;
  btn.textContent = 'Fixing…';

  try {
    const res  = await fetch('/api/fix-absent', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ branch, semester, academicYear }),
    });
    const data = await res.json();
    if (data.success) {
      alert(`✓ ${data.message}\n\nReloading dashboard…`);
      loadAnalysis();   // refresh the table with corrected data
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (e) {
    alert(`Network error: ${e.message}`);
  } finally {
    btn.disabled    = false;
    btn.innerHTML   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 22C6.48 22 2 17.52 2 12S6.48 2 12 2s10 4.48 10 10-4.48 10-10 10z"/>
      <path d="M12 8v4l3 3"/></svg> Fix Absent Data`;
  }
}

function renderDashboard(students, teacherMap) {
  // Capture filter context for edit/delete actions
  _dashCtx = {
    branch:       document.getElementById('filterBranch').value,
    semester:     document.getElementById('filterSemester').value,
    academicYear: document.getElementById('filterYear').value,
  };
  document.getElementById('dashResults').classList.remove('hidden');
  document.getElementById('downloadCSVBtn').classList.remove('hidden');
  document.getElementById('fixAbsentBtn').classList.remove('hidden');

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
  renderSubjectAnalysis(students, teacherMap || {});
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

  // Subject group headers — each spans 6 sub-cols (In, Ex, Tot, Re, GP, TGP)
  subjectOrder.forEach((code, si) => {
    const th = document.createElement('th');
    th.colSpan = 6;
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

  // Actions column header — rowSpan=2
  const thAct = document.createElement('th');
  thAct.rowSpan = 2;
  thAct.textContent = 'Actions';
  thAct.className = 'tail-hdr';
  row1.appendChild(thAct);
  thead.appendChild(row1);

  // Row 2: sub-column headers (In / Ex / Tot / Re / GP / TGP) for each subject
  const row2 = document.createElement('tr');
  subjectOrder.forEach((_, si) => {
    ['In', 'Ex', 'Tot', 'Re', 'GP', 'TGP'].forEach(label => {
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
        const isPass   = sub.result === 'P';
        const NON_ATT  = ['A', 'AB', 'W', 'X', 'NE', 'NA', '-'];
        const isAbsent = NON_ATT.includes((sub.result || '').toUpperCase());
        const gp       = sub.grade !== undefined ? sub.grade : (sub.gradePoint || 0);
        const credit   = sub.credit || 0;
        const tgp      = isAbsent ? 0 : gp * credit;
        [
          { val: isAbsent ? '—' : sub.internal,  style: '' },
          { val: isAbsent ? '—' : sub.external,  style: '' },
          { val: isAbsent ? '—' : sub.total,     style: 'font-weight:600' },
          { val: sub.result,  isResult: true, pass: isPass, absent: isAbsent },
          { val: isAbsent ? '—' : gp,   style: isPass ? 'color:var(--accent-2)' : 'color:var(--danger)' },
          { val: isAbsent ? '—' : tgp,  style: 'font-weight:600;color:var(--muted)' },
        ].forEach(col => {
          const td = document.createElement('td');
          if (col.isResult) {
            if (col.absent) {
              // Show actual code (A / W / X etc.) in amber badge
              td.innerHTML = `<span class="badge badge--absent">${col.val || 'A'}</span>`;
            } else {
              td.innerHTML = `<span class="${col.pass ? 'res-pass' : 'res-fail'}">${col.val}</span>`;
            }
          } else {
            td.textContent = col.val ?? '—';
            if (col.style) td.setAttribute('style', col.style);
          }
          tr.appendChild(td);
        });
      } else {
        for (let k = 0; k < 6; k++) {   // 6 cols now
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

    // Actions cell — Edit + Delete
    const tdAct = document.createElement('td');
    tdAct.style.whiteSpace = 'nowrap';
    tdAct.innerHTML = `
      <button class="btn btn--secondary btn--sm dash-edit-btn"
        style="margin-right:4px"
        data-usn="${s.usn}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        Edit
      </button>
      <button class="btn btn--danger btn--sm dash-del-btn"
        data-usn="${s.usn}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
        Delete
      </button>`;
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  });

  // Wire Edit + Delete buttons after all rows are in the DOM
  tbody.querySelectorAll('.dash-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => editStudentResult(btn.dataset.usn))
  );
  tbody.querySelectorAll('.dash-del-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteStudentResult(btn.dataset.usn))
  );

  window._lastAnalysisStudents     = sorted;
  window._lastAnalysisSubjectOrder = subjectOrder;
  window._lastAnalysisSubjectNames = subjectNames;
}

/* ==================== DASHBOARD EDIT / DELETE ==================== */
async function editStudentResult(usn) {
  const { branch, semester, academicYear } = _dashCtx;
  try {
    const params = new URLSearchParams({ branch, semester, academicYear, usn });
    const res    = await fetch(`/api/get-result?${params}`);
    const data   = await res.json();
    if (!data.success) { alert(data.error); return; }

    const r = data.result;

    // Switch to Upload tab and enter edit mode
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('tab--active'));
    document.querySelector('[data-tab="upload"]').classList.add('tab--active');
    document.getElementById('uploadPanel').classList.remove('hidden');
    document.getElementById('dashboardPanel').classList.add('hidden');

    if (!isEditMode) enterEditMode();

    // Fill student details
    const fields = { branch: r.branch, semester: r.semester,
                     academicYear: r.academicYear, usn: r.usn, studentName: r.studentName };
    Object.entries(fields).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (el) el.value = val || '';
    });

    // Sync view fields
    ['branch','semester','academicYear','usn','studentName'].forEach(id => {
      const val = document.getElementById(id).value.trim();
      const view = document.getElementById(`view-${id}`);
      if (view) { view.textContent = val || '—'; view.classList.toggle('is-empty', !val); }
    });

    // Fill subject rows
    document.getElementById('subjectRows').innerHTML = '';
    subjectCount = 0;
    (r.subjects || []).forEach(s => {
      const isAbsent = ['A','AB','W','X','NE','NA','-'].includes((s.result||'').toUpperCase());
      addSubjectRow({
        code:        s.code,
        name:        s.name,
        credit:      s.credit,
        creditLocked: s.credit > 0,
        internal:    isAbsent ? '' : s.internal,
        external:    isAbsent ? '' : s.external,
        result:      s.result,
      });
    });

    recalcSummary();

    const msgEl = document.getElementById('uploadMsg');
    showMsg(msgEl, `✓ Loaded ${r.usn} for editing. Make changes and click Save Result to update.`, 'ok');
    window.scrollTo({ top: 0, behavior: 'smooth' });

  } catch (e) {
    alert(`Error loading result: ${e.message}`);
  }
}

async function deleteStudentResult(usn) {
  const { branch, semester, academicYear } = _dashCtx;
  if (!confirm(`Delete result for ${usn}?\n\nBranch: ${branch} | Semester: ${semester} | Year: ${academicYear}\n\nThis cannot be undone.`)) return;

  try {
    const params = new URLSearchParams({ branch, semester, academicYear, usn });
    const res    = await fetch(`/api/delete-result?${params}`, { method: 'DELETE' });
    const data   = await res.json();
    if (data.success) {
      // Refresh the dashboard with the same filters
      loadAnalysis();
    } else {
      alert(data.error || 'Delete failed.');
    }
  } catch (e) {
    alert(`Error deleting result: ${e.message}`);
  }
}

/* ==================== EXCEL DOWNLOAD (2 sheets) ==================== */
function downloadCSV() {
  if (typeof XLSX === 'undefined') {
    alert('Excel library not loaded yet — please wait a moment and try again.');
    return;
  }

  const branch       = document.getElementById('filterBranch').value;
  const semester     = document.getElementById('filterSemester').value;
  const academicYear = document.getElementById('filterYear').value;

  const students = window._lastAnalysisStudents     || [];
  const subOrder = window._lastAnalysisSubjectOrder || [];
  const subNames = window._lastAnalysisSubjectNames || {};

  if (!students.length) return;

  const wb = XLSX.utils.book_new();

  // ── Helper: push a blank row then a bold-style section title ─────────────
  // SheetJS doesn't support cell styles in the free build, so we use
  // an ALL-CAPS label row to visually separate sections.

  // ════════════════════════════════════════════════════════════════════════
  // SHEET 1 — Summary  (Overall + Class Distribution + Toppers + Subject-wise)
  // ════════════════════════════════════════════════════════════════════════
  const s1 = [];   // array of arrays

  const total     = students.length;
  const passCount = students.filter(s => s.classAwarded !== 'NC').length;
  const failCount = total - passCount;
  const passPct   = total > 0 ? ((passCount / total) * 100).toFixed(1) : '0.0';
  const fcd       = students.filter(s => s.classAwarded === 'FCD').length;
  const fc        = students.filter(s => s.classAwarded === 'FC').length;
  const sc        = students.filter(s => s.classAwarded === 'SC').length;
  const nc        = students.filter(s => s.classAwarded === 'NC').length;

  // Header info
  s1.push([`Result Analysis`]);
  s1.push([`Branch: ${branch}`, `Semester: ${semester}`, `Year: ${academicYear}`]);
  s1.push([]);

  // Overall Summary
  s1.push(['OVERALL SUMMARY']);
  s1.push(['Metric', 'Value']);
  s1.push(['Total Students',   total]);
  s1.push(['Passed',           passCount]);
  s1.push(['NC / Failed',      failCount]);
  s1.push(['Overall Pass %',   `${passPct}%`]);
  s1.push([]);

  // Class Distribution
  s1.push(['CLASS DISTRIBUTION']);
  s1.push(['Class', 'Count']);
  s1.push(['FCD (≥75%)', fcd]);
  s1.push(['FC  (≥60%)', fc]);
  s1.push(['SC  (≥45%)', sc]);
  s1.push(['NC  (Failed)', nc]);
  s1.push([]);

  // Toppers
  const topN   = CFG.appSettings.toppersCount || 3;
  const ranked = [...students].sort((a, b) =>
    b.totalCreditPoints - a.totalCreditPoints || b.sumTotal - a.sumTotal
  );
  s1.push(['TOPPERS']);
  s1.push(['Rank', 'USN', 'Student Name', 'Total Marks', 'Total GP', 'SGPA', 'Percentage %', 'Class']);
  ranked.slice(0, topN).forEach((s, i) => {
    s1.push([i + 1, s.usn, s.studentName, s.sumTotal,
             s.totalCreditPoints, s.sgpa, `${s.percentage}%`, s.classAwarded]);
  });
  s1.push([]);

  // Subject-wise Analysis
  const subMap2 = {};
  students.forEach(s => {
    (s.subjects || []).forEach(sub => {
      if (!subMap2[sub.code]) subMap2[sub.code] = { name: sub.name, count: 0, pass: 0, fail: 0, absent: 0 };
      const NON_ATT2 = ['A', 'AB', 'W', 'X', 'NE', 'NA', '-'];
      const res2 = (sub.result || '').toUpperCase();
      if (NON_ATT2.includes(res2)) {
        subMap2[sub.code].absent += 1;
      } else {
        subMap2[sub.code].count += 1;
        if (res2 === 'P') subMap2[sub.code].pass += 1;
        else              subMap2[sub.code].fail += 1;
      }
    });
  });
  s1.push(['SUBJECT-WISE ANALYSIS']);
  s1.push(['Subject Code', 'Subject Name', 'Total Students', 'Absent', 'Pass', 'Fail', 'Pass %']);
  Object.entries(subMap2).forEach(([code, m]) => {
    const total = m.count + m.absent;
    const pct   = m.count > 0 ? ((m.pass / m.count) * 100).toFixed(1) : '0.0';
    s1.push([code, m.name, total, m.absent > 0 ? m.absent : 0, m.pass, m.fail, `${pct}%`]);
  });

  const ws1 = XLSX.utils.aoa_to_sheet(s1);
  // Set column widths for readability
  ws1['!cols'] = [{ wch: 28 }, { wch: 14 }, { wch: 28 }, { wch: 14 },
                  { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

  // ════════════════════════════════════════════════════════════════════════
  // SHEET 2 — All Students  (full result sheet with In/Ex/Tot/Re/GP/TGP)
  // ════════════════════════════════════════════════════════════════════════
  const s2 = [];

  s2.push([`All Students — Full Result Sheet`]);
  s2.push([`Branch: ${branch}`, `Semester: ${semester}`, `Year: ${academicYear}`]);
  s2.push([]);

  // Row 1: group-level header (Subject 1, Subject 2 … + tail cols)
  const hRow1 = ['Sl No', 'USN', 'Student Name'];
  subOrder.forEach((code, si) => {
    hRow1.push(`Subject ${si + 1} — ${subNames[code]}`, '', '', '', '', '');
  });
  hRow1.push('Total Marks', 'Total GP', 'SGPA', 'Percentage %', 'Class Awarded');
  s2.push(hRow1);

  // Row 2: sub-column labels (In / Ex / Tot / Re / GP / TGP)
  const hRow2 = ['', '', ''];
  subOrder.forEach(() => hRow2.push('In', 'Ex', 'Tot', 'Re', 'GP', 'TGP'));
  hRow2.push('', '', '', '', '');
  s2.push(hRow2);

  // Data rows
  const sorted = [...students].sort((a, b) => (a.usn || '').localeCompare(b.usn || ''));
  sorted.forEach((s, i) => {
    const sm = {};
    (s.subjects || []).forEach(sub => { sm[sub.code] = sub; });

    const row = [i + 1, s.usn, s.studentName];
    subOrder.forEach(code => {
      const sub = sm[code];
      if (sub) {
        const gp  = sub.grade !== undefined ? sub.grade : (sub.gradePoint || 0);
        const tgp = gp * (sub.credit || 0);
        row.push(sub.internal, sub.external, sub.total, sub.result, gp, tgp);
      } else {
        row.push('', '', '', '', '', '');
      }
    });
    row.push(s.sumTotal, s.totalCreditPoints, s.sgpa, `${s.percentage}%`, s.classAwarded);
    s2.push(row);
  });

  const ws2 = XLSX.utils.aoa_to_sheet(s2);
  // Fixed col widths: Sl(5), USN(14), Name(24), then 6 per subject, then 5 tail cols
  const w2cols = [{ wch: 5 }, { wch: 14 }, { wch: 24 }];
  subOrder.forEach(() => {
    w2cols.push({ wch: 5 }, { wch: 5 }, { wch: 5 }, { wch: 4 }, { wch: 4 }, { wch: 5 });
  });
  [12, 10, 8, 12, 14].forEach(w => w2cols.push({ wch: w }));
  ws2['!cols'] = w2cols;

  XLSX.utils.book_append_sheet(wb, ws2, 'All Students');

  // ── Write the workbook ────────────────────────────────────────────────────
  const fileName = `results_${branch}_${semester}_${academicYear}.xlsx`.replace(/\s+/g, '_');
  XLSX.writeFile(wb, fileName);
}

function renderSubjectAnalysis(students, teacherMap) {
  const totalStudents = students.length;
  const map = {};
  students.forEach(s => {
    (s.subjects || []).forEach(sub => {
      if (!map[sub.code]) {
        map[sub.code] = { name: sub.name, present: 0, pass: 0, fail: 0, absent: 0 };
      }
      const m = map[sub.code];
      const NON_ATT = ['A', 'AB', 'W', 'X', 'NE', 'NA', '-'];
      const res = (sub.result || '').toUpperCase();
      if (NON_ATT.includes(res)) {
        m.absent += 1;
      } else {
        m.present += 1;
        if (res === 'P') m.pass += 1;
        else             m.fail += 1;
      }
    });
  });

  const tbody = document.querySelector('#subjectTable tbody');
  tbody.innerHTML = '';
  Object.entries(map).forEach(([code, m]) => {
    // Total = present + absent (everyone in the batch who has this subject entry)
    const total   = m.present + m.absent;
    // Pass % = pass out of those who actually appeared (not absent)
    const passPct = m.present > 0 ? ((m.pass / m.present) * 100).toFixed(1) : '0.0';
    const teacher = (teacherMap && teacherMap[code]) ? teacherMap[code] : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-family:monospace;font-size:12px">${code}</td>
      <td style="text-align:left">${m.name}</td>
      <td style="text-align:left;color:var(--accent-2)">${teacher}</td>
      <td style="font-weight:600">${total}</td>
      <td style="color:var(--warning);font-weight:600">${m.absent > 0 ? m.absent : '—'}</td>
      <td style="color:var(--accent-2);font-weight:600">${m.pass}</td>
      <td style="color:var(--danger);font-weight:600">${m.fail}</td>
      <td>${passPct}%</td>
    `;
    tbody.appendChild(tr);
  });
}