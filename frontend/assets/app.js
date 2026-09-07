/* ══════════════════════════════════════════════════════
   Bunai Task Manager — application script
   Extracted from frontend/app.html so the markup, the styles and the
   behaviour are three files instead of one 9 000-line document. The server
   serves each with its own content-hash ETag, so editing one does not
   invalidate the browser cache of the other two.
   ══════════════════════════════════════════════════════ */
// ── Delegate-by-me modal (was the first inline <script>) ──
// ══════════════════════════════════════════════════════
// DELEGATE BY ME — shows all tasks delegated by the current logged-in user to others
// ══════════════════════════════════════════════════════
let _dbmTasks = [];
let _dbmStatusFilter = 'pending';

async function openDelegateByMeModal() {
  _dbmStatusFilter = 'pending';
  document.querySelectorAll('#delegateByMeModal .tab').forEach(t => t.classList.remove('active'));
  document.getElementById('dbmTabPending').classList.add('active');
  const searchEl = document.getElementById('dbmSearch');
  if (searchEl) searchEl.value = '';
  document.getElementById('delegateByMeModal').classList.add('open');
  document.getElementById('dbmContent').innerHTML = '<div class="empty">Loading…</div>';

  // Fetch delegation tasks only (checklist tasks are mostly self-assigned)
  const data = await api('/api/tasks?type=delegation&mine=1');
  let tasks = [];
  if (data.grouped) {
    data.grouped.forEach(g => g.tasks.forEach(t => tasks.push(t)));
  } else {
    tasks = data.tasks || [];
  }
  // Only tasks assigned by me (assigned_by === ME.id) — server also filters but double-checking client-side
  _dbmTasks = tasks.filter(t => String(t.assigned_by) === String(ME.id));
  renderDbmTable();
}

function filterDbmStatus(status, el) {
  _dbmStatusFilter = status;
  document.querySelectorAll('#delegateByMeModal .tab-group .tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderDbmTable();
}

function renderDbmTable() {
  const search = (document.getElementById('dbmSearch')?.value || '').toLowerCase();
  const filtered = _dbmTasks.filter(t => {
    const matchStatus = _dbmStatusFilter === 'all' || t.status === _dbmStatusFilter;
    const matchSearch = !search ||
      (t.description||'').toLowerCase().includes(search) ||
      (t.assignedToName||'').toLowerCase().includes(search) ||
      (t.due_date||'').includes(search) ||
      (t.remarks||'').toLowerCase().includes(search);
    return matchStatus && matchSearch;
  });

  if (!filtered.length) {
    document.getElementById('dbmContent').innerHTML =
      `<div class="empty" style="padding:30px;text-align:center;color:var(--faint)">
        ${_dbmStatusFilter === 'pending' ? 'You have not delegated any pending tasks yet' : 'None of your delegated tasks are completed yet'}
      </div>`;
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const rows = filtered.map(t => {
    const isOverdue = (t.status === 'pending' || t.status === 'revised') && t.due_date && t.due_date < today;
    return `<tr>
      <td style="font-size:13px">${t.description||'—'}</td>
      <td style="white-space:nowrap;font-size:13px">${t.assignedToName||'—'}</td>
      <td style="white-space:nowrap;font-size:12px">${fmtDate(t.due_date||'')||'—'}${isOverdue?' <span style="color:#dc2626;font-weight:600;font-size:10px">⏰ Overdue</span>':''}</td>
      <td style="font-size:12px;color:var(--muted-foreground)">${t.remarks||'—'}</td>
      <td><span class="status-badge ${t.status}">${t.status==='revised'?'Revision':t.status.charAt(0).toUpperCase()+t.status.slice(1)}</span></td>
    </tr>`;
  }).join('');

  document.getElementById('dbmContent').innerHTML = `
    <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--card)">
      <div style="overflow-x:auto">
        <table style="width:100%;min-width:600px">
          <thead>
            <tr>
              <th>Task</th><th>Assigned To</th><th>Due Date</th><th>Remarks</th><th>Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="padding:8px 12px;background:var(--muted);border-top:1px solid var(--border);font-size:12px;color:var(--muted-foreground)">
        Total: <strong>${filtered.length}</strong> task(s) delegated by you
      </div>
    </div>`;
}

// ── Main application (was the second inline <script>) ──
// ══════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════
let ME = null;
// ⬇️⬇️ IMS (Inventory Management System) — admin-only, served natively by this app
// at /ims (reads your Google Sheets via a service account). No Apps Script web
// app needed. Leave as "/ims" unless you host the IMS elsewhere.
const IMS_WEBAPP_URL = "/ims";

// ══════════════════════════════════════════════════════
// UNIT / LOCATION NAMES  ← rename your production units here
// The two Merchandising FMS forms write to two different sheets, one per unit.
// Change the two strings below and every tab + heading follows; nothing else
// needs touching. (Sheet IDs for each unit live in .env.)
// ══════════════════════════════════════════════════════
const UNIT_NAMES = { 1: 'Unit 1', 2: 'Unit 2' };
function applyUnitNames() {
  document.querySelectorAll('[data-unit]').forEach(el => {
    el.textContent = UNIT_NAMES[el.dataset.unit] || '';
  });
}
let _imsLoaded = false;
let dashType = 'all';
let tasksType = 'delegation';
let dashChartInst = null;
// Holidays now server-backed — loaded fresh each time the holiday modal opens
let holidays = [];
let transferMode = false;
let pendingTransferTaskIds = []; // task IDs that already have pending transfer
// Dashboard date sort: 0=default(API order), 1=asc(oldest first), 2=desc(newest first)
let _dashDateSortState = 0;

// ══════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════
async function init() {
  try {
    const token = localStorage.getItem('authToken');
    const headers = {'Content-Type': 'application/json'};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch('/api/me', { credentials: 'include', headers });
    if (!r.ok) {
      localStorage.removeItem('authToken');
      window.location.replace('/');
      return;
    }
    ME = await r.json();
    if (!ME || !ME.id) { window.location.replace('/'); return; }
    const initials = ME.name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
    document.getElementById('sidebarName').textContent = ME.name;
    const roleLabel = ME.role==='admin' ? '👑 Admin' : ME.role==='hod' ? '🏢 HOD' : ME.role==='pc' ? '🖥️ PC' : '👤 Employee';
    document.getElementById('sidebarRole').textContent = roleLabel;
    document.getElementById('pName').value = ME.name;
    document.getElementById('pEmail').value = ME.email;
    document.getElementById('pPhone').value = ME.phone || '';
    document.getElementById('profileNameDisplay').textContent = ME.name;
    document.getElementById('profileRoleDisplay').textContent = roleLabel;

    setAvatarDisplay(ME.profile_image, initials);

    if (ME.role === 'admin') {
      document.getElementById('nav-users').style.display = 'flex';
      document.getElementById('nav-dailyreports').style.display = 'flex';
      document.getElementById('nav-hr').style.display = 'flex';
      document.getElementById('nav-mis').style.display = 'flex';
      document.getElementById('nav-fms').style.display = 'flex';
      document.getElementById('nav-ims').style.display = 'flex';
      document.getElementById('nav-sales').style.display = 'flex';
      document.getElementById('nav-returns').style.display = 'flex';
      document.getElementById('nav-clients').style.display = 'flex';
      document.getElementById('nav-compliance').style.display = 'flex';
      document.getElementById('bulkDeleteBtn').style.display = 'inline-flex';
    }
    // PO — Production department fills it, Finance department uploads doc against it,
    // Admin sees/does everything.
    window.PO_DEPT = (ME.department || '').trim().toLowerCase();
    window.IS_PO_PROD = window.PO_DEPT === 'production';
    window.IS_PO_FINANCE = window.PO_DEPT === 'finance';
    window.IS_PO_ADMIN = ME.role === 'admin';
    if (ME.role === 'hod') {
      // HOD can view MIS for their own department
      document.getElementById('nav-mis').style.display = 'flex';
      document.getElementById('setPlanBtn').style.display = 'inline-flex';
    }
    if (ME.role === 'pc') {
      // PC: can view all tasks + approve, but cannot edit/delete
      // Nav items same as employee (dashboard, alltasks, approvals, profile, fms-tasks)
    }
    // Leave Tracker — HOD / Admin / PC also see Team tab
    if (ME.role === 'admin' || ME.role === 'hod' || ME.role === 'pc') {
      const tTeam = document.getElementById('lvTabTeam');
      if (tTeam) tTeam.style.display = 'flex';
    }
    // FMS Tasks nav — hide for users who are not a doer in any FMS step.
    // Admin / PC see it regardless (overview / approval role).
    (async () => {
      const fmsNav = document.getElementById('nav-fms-tasks');
      if (!fmsNav) return;
      if (ME.role === 'admin' || ME.role === 'pc') { fmsNav.style.display = 'flex'; return; }
      try {
        const list = await api('/api/fms-tasks');
        const hasFMS = Array.isArray(list) && list.length > 0;
        fmsNav.style.display = hasFMS ? 'flex' : 'none';
      } catch { fmsNav.style.display = 'none'; }
    })();
    setMinDates();
    hideEmptyNavSections();   // drop group headers whose items are all role-hidden
    // Restore whatever page the URL points at instead of always opening the
    // dashboard. Runs after the role checks above, so nav visibility is settled.
    openFromHash();
    loadApprovalBadge();
    loadTransferBadge();
    // Refresh badges every 30 seconds
    setInterval(loadApprovalBadge, 30000);
    setInterval(loadTransferBadge, 30000);
  } catch(e) { console.error('Init error:', e); window.location.replace('/'); }
}

// Set avatar in sidebar + profile page
function setAvatarDisplay(imageData, initials) {
  const sidebar = document.getElementById('sidebarAvatar');
  const profile = document.getElementById('profileAvatar');

  if (imageData) {
    // Sidebar
    sidebar.style.backgroundImage = `url(${imageData})`;
    sidebar.style.backgroundSize = 'cover';
    sidebar.style.backgroundPosition = 'center';
    sidebar.textContent = '';
    // Profile
    profile.style.backgroundImage = `url(${imageData})`;
    profile.style.backgroundSize = 'cover';
    profile.style.backgroundPosition = 'center';
    profile.textContent = '';
  } else {
    sidebar.style.backgroundImage = '';
    sidebar.textContent = initials || '?';
    profile.style.backgroundImage = '';
    profile.textContent = initials || '?';
  }
}

// Handle image file selection
function handleProfileImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { showToast('Image size must be under 2MB','error'); return; }

  const reader = new FileReader();
  reader.onload = async (e) => {
    const imageData = e.target.result; // base64
    // Save to DB immediately
    const r = await api('/api/profile/image','POST',{image: imageData});
    if (r.error) { showToast(r.error,'error'); return; }
    ME.profile_image = imageData;
    const initials = ME.name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
    setAvatarDisplay(imageData, initials);
    showToast('Profile photo updated!');
  };
  reader.readAsDataURL(file);
}

// Remove profile image
async function removeProfileImage() {
  if (!confirm('Remove profile photo?')) return;
  await api('/api/profile/image','POST',{image: null});
  ME.profile_image = null;
  const initials = ME.name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
  setAvatarDisplay(null, initials);
  showToast('Profile photo removed!');
}

function setMinDates() {
  const today = new Date().toISOString().split('T')[0];
  ['dDate','cDate','hDate'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.min = today;
  });
}

// ══════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════
const pageTitles = {dashboard:'Dashboard',alltasks:'All Tasks',approvals:'Approvals',users:'Users',hr:'HR — Employees',profile:'Profile',daily:'Daily Task Form',dailyreports:'Daily Reports',mis:'MIS Report',fms:'FMS Admin','fms-tasks':'FMS Tasks',merchfms:'Form',pms:'PMS — Production',clients:'Project Master',compliance:'Compliance Tracker',leaves:'Leave Tracker',ims:'Inventory (IMS)',stock:'Stock',sales:'Sales',returns:'Returns'};

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sidebarBackdrop');
  const opening = !sb.classList.contains('open');
  sb.classList.toggle('open', opening);
  bd.classList.toggle('open', opening);
  document.body.style.overflow = opening ? 'hidden' : '';
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('open');
  document.body.style.overflow = '';
}

// ══════════════════════════════════════════════════════
// DEEP LINKS — the current page lives in location.hash
// This is a single page, so a refresh used to drop you back on the dashboard
// no matter where you were. Mirroring the page into the hash fixes that, and
// browser back/forward and bookmarking start working for free.
// ══════════════════════════════════════════════════════
function navElFor(page) {
  return document.querySelector(`.nav-item[onclick*="navigate('${page}'"]`);
}

// A sidebar group header (.nav-section) is only useful when at least one of the
// items under it (up to the next header/divider) is visible for this role. Run
// after the role-based reveal so empty groups' headers don't linger.
function hideEmptyNavSections() {
  const nav = document.querySelector('nav.nav');
  if (!nav) return;
  const kids = [...nav.children];
  kids.forEach((el, i) => {
    if (!el.classList.contains('nav-section')) return;
    let anyVisible = false;
    for (let j = i + 1; j < kids.length; j++) {
      const n = kids[j];
      if (n.classList.contains('nav-section') || n.classList.contains('nav-divider')) break;
      if (n.classList.contains('nav-item') && n.style.display !== 'none') { anyVisible = true; break; }
    }
    el.style.display = anyVisible ? '' : 'none';
  });
}

// A hash can be typed or bookmarked, so never trust it — the page must exist
// and the signed-in role must be allowed to open it.
function canOpenPage(page) {
  if (!page || !document.getElementById('page-' + page)) return false;
  if (page === 'mis') return ME && (ME.role === 'admin' || ME.role === 'hod');
  if (page === 'ims') return ME && ME.role === 'admin';
  if (page === 'sales') return ME && ME.role === 'admin';
  if (page === 'returns') return ME && ME.role === 'admin';
  if (page === 'hr') return ME && ME.role === 'admin';
  const el = navElFor(page);
  return !el || el.style.display !== 'none';   // hidden nav item = not their page
}

function openFromHash() {
  const page = (location.hash || '').replace(/^#/, '');
  const target = canOpenPage(page) ? page : 'dashboard';
  navigate(target, navElFor(target), true);
}

window.addEventListener('hashchange', openFromHash);

function navigate(page, el, fromHash) {
  // MIS page — admin and HOD (App Role) only
  if (page === 'mis' && ME.role !== 'admin' && ME.role !== 'hod') return;
  // IMS page — admin only
  if (page === 'ims' && (!ME || ME.role !== 'admin')) return;
  // Sales page — admin only
  if (page === 'sales' && (!ME || ME.role !== 'admin')) return;
  // HR page — admin only
  if (page === 'hr' && (!ME || ME.role !== 'admin')) return;
  // Returns page — admin only
  if (page === 'returns' && (!ME || ME.role !== 'admin')) return;
  // Record where we are. Skipped when the hash is what triggered this call,
  // and skipped when unchanged — otherwise the hashchange handler would loop.
  if (!fromHash && location.hash.replace(/^#/, '') !== page) location.hash = page;
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  if (el) el.classList.add('active');
  document.getElementById('topbarTitle').textContent = pageTitles[page] || page;
  // Auto-close mobile drawer after navigation
  if (window.innerWidth <= 768) closeSidebar();
  if (page==='dashboard') loadDashboard();
  if (page==='alltasks') loadAllTasks();
  if (page==='users') loadUsers();
  if (page==='hr') loadHr();
  if (page==='approvals') loadApprovals();
  if (page==='fms') loadFMSAdmin();
  if (page==='fms-tasks') loadFMSTasks();
  if (page==='merchfms') loadMerchFMS();
  if (page==='clients') loadClients();
  if (page==='daily') loadDailyForm();
  if (page==='compliance') loadCompliance();
  if (page==='dailyreports') loadDailyReports();
  if (page==='leaves') loadLeaves();
  if (page==='pms') loadPMS();
  if (page==='ims') loadIMS();
  if (page==='stock') loadStock();
  if (page==='sales') loadSales();
  if (page==='returns') loadReturns();
  window.scrollTo(0,0);
}

// ══════════════════════════════════════════════════════
// STOCK — Vinculum warehouse stock
// Reads /api/stock, which reads the synced tables. Nothing here talks to
// Vinculum directly, so the page renders instantly regardless of their API.
// ══════════════════════════════════════════════════════
let _stockTimer = null;
function stockDebounced() {
  clearTimeout(_stockTimer);
  _stockTimer = setTimeout(loadStock, 300);   // typing shouldn't fire a query per keystroke
}

function stockTile(label, value, note, tone) {
  const colors = { good: '#16a34a', warn: '#d97706', bad: '#dc2626' };
  return `<div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 18px">
    <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-foreground);margin-bottom:9px">${label}</div>
    <div style="font-size:25px;font-weight:800;letter-spacing:-.02em;line-height:1;color:${colors[tone] || 'var(--foreground)'};font-variant-numeric:tabular-nums">${value}</div>
    ${note ? `<div style="font-size:12px;color:var(--faint);margin-top:6px">${note}</div>` : ''}
  </div>`;
}

// Kicks off a sync and watches it, rather than waiting on one long request.
// A run takes about ten minutes — 20 SKUs per call, plus a forced pause when
// the API's 40-call quota trips — and the server returns as soon as it has
// started. From then on the page just polls, so closing the tab, a flaky
// network or a server restart cannot make a healthy sync look failed.
let _stockPoll = null;

// An alert() is wrong for a job this long — six minutes later the user is on
// another page or another tab, and a modal that hijacks whatever they are doing
// to announce a background task is an interruption, not a courtesy. This says
// the same thing in place, and waits there until it is read.
function stockNotice(kind, text) {
  const el = document.getElementById('stockNotice');
  if (!el) return;
  if (!text) { el.style.display = 'none'; return; }
  const skin = {
    ok:   ['#ECFDF3', '#A6F4C5', '#05603A'],
    busy: ['#FFF8E6', '#FDE68A', '#8A5A00'],
    bad:  ['#FEF3F2', '#FECDCA', '#B42318'],
  }[kind] || ['#F8FAFC', '#E2E8F0', '#334155'];
  el.style.background = skin[0];
  el.style.border = '1px solid ' + skin[1];
  el.style.color = skin[2];
  el.textContent = text;
  el.style.display = 'block';
}

function stockWatch(on) {
  const btn = document.getElementById('stockSyncBtn');
  clearInterval(_stockPoll);
  if (!on) {
    if (btn) { btn.disabled = false; btn.textContent = 'Sync now'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing… (~6 min)'; }
  // Every 20s: cheap for a job this long, and quick enough that the page
  // notices the finish without the user reaching for refresh.
  _stockPoll = setInterval(async () => {
    try {
      const d = await api('/api/stock');
      if (d.lastSync && d.lastSync.ended_at) {
        stockWatch(false);
        stockNotice(d.lastSync.ok ? 'ok' : 'bad', d.lastSync.ok
          ? `Sync finished — ${d.lastSync.rows_seen} stock rows updated. Any new low-stock tasks are in All Tasks.`
          : `Sync failed — ${d.lastSync.error || 'no error recorded'}`);
        await loadStock();
      }
    } catch (_) { /* a blip mid-poll is not a failed sync — keep watching */ }
  }, 20000);
}

async function syncStockNow() {
  try {
    await api('/api/stock/sync', 'POST');
    stockNotice('busy', 'Sync started. It takes about six minutes — you can leave this page, it keeps running.');
    stockWatch(true);
    await loadStock();
  } catch (e) {
    const busy = (e.message || '').includes('already running');
    stockNotice(busy ? 'busy' : 'bad',
      busy ? e.message : 'Could not start the sync — ' + (e.message || 'unknown error'));
    if (busy) stockWatch(true);
  }
}

// ── One-click Vinculum sync (Stock / Sales / Returns pages) ──
// Triggers the GitHub Actions workflow (stock + orders + returns — Vercel can't
// run the long pull in-process), then watches THIS page's own sync log for the
// fresh run and reloads it. The whole workflow runs regardless of which page's
// button was clicked; each page just waits for its own data to land.
const VIN_SYNC = {
  stock:   { endpoint: '/api/stock',   notice: (k, m) => stockNotice(k, m),  reload: () => loadStock(),   seen: d => d.lastSync && d.lastSync.rows_seen,    label: 'stock rows' },
  sales:   { endpoint: '/api/sales',   notice: (k, m) => salesNotice(k, m),  reload: () => loadSales(),   seen: d => d.lastSync && d.lastSync.orders_seen,  label: 'orders' },
  returns: { endpoint: '/api/returns', notice: (k, m) => returnsNotice(k, m), reload: () => loadReturns(), seen: d => d.lastSync && d.lastSync.returns_seen, label: 'returns' },
};
const _vinSyncPoll = {};
function _vinSyncBtn(kind) { return document.getElementById(kind + 'SyncGhBtn'); }
function _vinSyncReset(kind) { const b = _vinSyncBtn(kind); if (b) { b.disabled = false; b.textContent = '↻ Sync from Vinculum'; } }

async function runVinSync(kind) {
  const cfg = VIN_SYNC[kind]; if (!cfg) return;
  const btn = _vinSyncBtn(kind);
  // Remember the current sync so we can tell when a NEW run has landed.
  let before = null;
  try { const d0 = await api(cfg.endpoint); before = d0.lastSync ? d0.lastSync.started_at : null; } catch (_) {}
  let r;
  try { r = await api('/api/sync/run', 'POST'); } catch (e) { cfg.notice('bad', 'Could not start sync — ' + (e.message || 'error')); return; }
  if (r.error) { cfg.notice('bad', r.error); return; }
  cfg.notice('busy', '⏳ Sync started on GitHub — pulling stock, orders & returns from Vinculum. Takes ~5-7 min; you can leave this page, it keeps running.');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing… (~6 min)'; }
  _vinSyncWatch(kind, before, Date.now());
}
function _vinSyncWatch(kind, before, startedAt) {
  const cfg = VIN_SYNC[kind];
  clearInterval(_vinSyncPoll[kind]);
  _vinSyncPoll[kind] = setInterval(async () => {
    if (Date.now() - startedAt > 13 * 60000) {          // stop watching after ~13 min
      clearInterval(_vinSyncPoll[kind]); _vinSyncReset(kind);
      cfg.notice('busy', 'Still running on GitHub — give it another minute, then hit Refresh.');
      return;
    }
    try {
      const d = await api(cfg.endpoint);
      const now = d.lastSync ? d.lastSync.started_at : null;
      if (now && now !== before && d.lastSync.ended_at) {   // a fresh finished run
        clearInterval(_vinSyncPoll[kind]); _vinSyncReset(kind);
        cfg.notice('ok', `✓ Synced — ${Number(cfg.seen(d) || 0).toLocaleString('en-IN')} ${cfg.label} updated.`);
        cfg.reload();
      }
    } catch (_) { /* transient blip — keep watching */ }
  }, 20000);
}

async function loadStock() {
  const body = document.getElementById('stockBody');
  const tiles = document.getElementById('stockSynced');
  const syncBtn = document.getElementById('stockSyncBtn');
  if (syncBtn) syncBtn.style.display = 'none';   // replaced by "↻ Sync from Vinculum" (GitHub trigger)
  const ghBtn = document.getElementById('stockSyncGhBtn');
  if (ghBtn) ghBtn.style.display = (ME && ME.role === 'admin') ? '' : 'none';
  try {
    const q = document.getElementById('stockSearch').value.trim();
    const low = document.getElementById('stockLow').value;
    const soldSel = document.getElementById('stockSoldDays');
    const soldDays = soldSel ? soldSel.value : '';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (low === 'reorder') params.set('reorder', '1');
    else if (low !== '') params.set('low', low);
    if (soldDays) params.set('soldDays', soldDays);
    const groupSel = document.getElementById('stockGroupBy');
    const groupBy = groupSel ? groupSel.value : 'sku';
    if (groupBy && groupBy !== 'sku') params.set('groupBy', groupBy);

    const d = await api('/api/stock' + (params.toString() ? '?' + params : ''));

    if (d.notConfigured) {
      document.getElementById('stockTiles').innerHTML = '';
      body.innerHTML = `<tr><td colspan="6" class="empty">Stock sync isn't set up on this server yet — run <code>node vinculum-sync.js sync</code>.</td></tr>`;
      tiles.textContent = '';
      return;
    }

    const totalUnits = d.totals.reduce((s, t) => s + Number(t.units || 0), 0);
    document.getElementById('stockTiles').innerHTML =
      stockTile('Total units', totalUnits.toLocaleString('en-IN'),
        d.totals.length === 1 ? `${d.totals[0].skus} SKUs in ${d.totals[0].warehouse}` : `${d.counts ? d.counts.tracked : 0} SKU-warehouse rows`) +
      // Per-warehouse cards only when there is more than one — with a single
      // warehouse the card would just repeat Total units.
      (d.totals.length > 1
        ? d.totals.map(t => stockTile(t.warehouse, Number(t.units).toLocaleString('en-IN'), `${t.skus} SKUs in stock`)).join('') : '') +
      (d.counts && d.counts.out_of_stock > 0
        ? stockTile('Out of stock', d.counts.out_of_stock, 'quantity is zero', 'bad') : '') +
      // Period cards — recompute whenever the "Sold: N days" window changes.
      (d.period && d.period.hasOrders
        ? stockTile(`Sold (${d.period.soldDays}d)`, Number(d.period.soldUnits).toLocaleString('en-IN'), `${d.period.skusSold} SKUs sold`) +
          stockTile('Needs reorder', Number(d.period.reorderCount).toLocaleString('en-IN'), `stock below ${d.period.soldDays}d sales`, 'warn')
        : '');

    // The sync timestamp is the honest part of this page: stale data that looks
    // current is worse than no data, so say plainly when it last ran.
    const agoText = ts => {
      const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
      return mins < 60 ? `${mins} min ago`
           : mins < 1440 ? `${Math.round(mins / 60)} hr ago`
           : `${Math.round(mins / 1440)} days ago`;
    };

    // How old the data is comes from the last SUCCESSFUL run; a failed retry
    // afterwards does not make the numbers on screen any less real. The failure
    // is worth saying, but as a second line, not by hiding the age.
    if (d.lastOk) {
      tiles.textContent = `Synced ${agoText(d.lastOk.started_at)}`;
      tiles.style.color = 'var(--faint)';
    } else {
      tiles.textContent = 'Never synced';
      tiles.style.color = '#d97706';
    }

    // The log row is written when a run starts, so ok=0 with no end time means
    // "still going", not "failed" — reading it as a failure would cry wolf on
    // every sync while it runs.
    if (d.lastSync && !d.lastSync.ended_at) {
      tiles.textContent = `Syncing now — started ${agoText(d.lastSync.started_at)}`;
      tiles.style.color = '#d97706';
      // Landing on the page mid-run (someone else started it, or a refresh)
      // should pick the watch back up, not leave the button looking idle.
      if (!_stockPoll) {
        stockNotice('busy', 'A sync is already running. This page will update on its own when it finishes.');
        stockWatch(true);
      }
    } else if (d.lastSync && !d.lastSync.ok &&
               (!d.lastOk || new Date(d.lastSync.started_at) > new Date(d.lastOk.started_at))) {
      tiles.textContent += ` · last attempt failed: ${d.lastSync.error || 'no error recorded'}`;
      tiles.style.color = '#dc2626';
    }

    const soldHdr = document.getElementById('stockSoldHeader');
    if (soldHdr && d.soldDays) soldHdr.textContent = 'Sold (' + d.soldDays + 'd)';
    // Live check needs real SKUs to ask Vinculum about, and a clubbed row's
    // "SKU" is a key that exists nowhere in Vinculum — so send its members.
    window._stockSkus = [...new Set(d.rows.flatMap(r => r.skus || [r.sku]))];
    const clubbed = (d.groupBy || 'sku') !== 'sku';
    // Orders live behind an admin-only endpoint, and Stock is not an admin-only
    // page — so the rows only become clickable for someone who could read them.
    const canOrders = !!(ME && ME.role === 'admin');
    window._stockRows = d.rows;
    const skuHdr = document.getElementById('stockSkuHeader');
    if (skuHdr) skuHdr.textContent = clubbed ? (d.groupBy === 'design' ? 'Design' : 'Style') : 'SKU';
    body.innerHTML = d.rows.length ? d.rows.map((r, i) => {
      const qty = Number(r.qty);
      const sold = Number(r.sold) || 0;
      // Fewer units in stock than sold in the window ⇒ under one window's cover
      // at the current pace: flag it for reorder.
      const reorder = sold > 0 && qty < sold;
      const colour = qty <= 0 ? '#dc2626' : qty <= 5 ? '#d97706' : 'var(--foreground)';
      const soldCol = reorder ? '#dc2626' : 'var(--muted-foreground)';
      return `<tr${canOrders ? ` onclick="stockOrders(${i})" style="cursor:pointer" title="See the orders behind this row"` : ''}>
        <td style="color:var(--faint);font-variant-numeric:tabular-nums">${i + 1}</td>
        <td style="white-space:nowrap;font-family:var(--font-mono);font-size:12px">${dtEscape(r.sku)}${r.skuCount > 1
          ? ` <span style="font-family:var(--font-sans);font-size:10.5px;color:var(--faint)" title="${dtEscape((r.skus || []).join(', '))}">+${r.skuCount - 1}</span>`
          : ''}</td>
        <td>${dtEscape(r.description || '—')}${clubbed && r.nameCount > 1
          ? ` <span style="font-size:10.5px;color:var(--faint)">· ${r.nameCount} names</span>`
          : ''}</td>
        <td style="white-space:nowrap">${dtEscape(r.warehouse)}</td>
        <td style="text-align:right;font-weight:600;font-variant-numeric:tabular-nums;color:${colour}">${qty.toLocaleString('en-IN')}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums;color:${soldCol}">${sold ? sold.toLocaleString('en-IN') : '—'}${reorder ? ' <span style="font-size:10.5px;font-weight:700" title="Stock is below window sales — reorder">⚠</span>' : ''}</td>
      </tr>`;
    }).join('') + (d.truncated
      ? `<tr><td colspan="6" style="text-align:center;font-size:12px;color:var(--faint);padding:10px">Showing the first 500 — narrow the search to see the rest</td></tr>`
      : '')
      : `<tr><td colspan="6" class="empty">No stock matches this filter</td></tr>`;

  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="empty">Could not load stock — ${dtEscape(e.message || 'unknown error')}</td></tr>`;
  }
}

// A row on the Stock page → the orders behind it. A clubbed row is a product
// rather than a SKU, so its members are asked for together: querying them one at
// a time would list the same order once per size the customer bought. The window
// matches the "Sold (Nd)" column the row is already showing, so the count in the
// row and the orders in the popup are the same set of facts.
async function stockOrders(i) {
  const r = (window._stockRows || [])[i];
  if (!r) return;
  const skus = (r.skus && r.skus.length) ? r.skus : [r.sku];
  const soldSel = document.getElementById('stockSoldDays');
  const days = soldSel ? soldSel.value : '';
  const label = skus.length > 1 ? `${r.sku} · ${skus.length} SKUs` : r.sku;

  document.getElementById('salesDetailTitle').textContent = label;
  document.getElementById('salesDetailSummary').textContent = 'Loading…';
  document.getElementById('salesDetailBody').innerHTML = '<tr><td colspan="9" class="empty">Loading…</td></tr>';
  const pager = document.getElementById('salesDetailPager');
  if (pager) pager.textContent = '';
  document.getElementById('salesDetailModal').classList.add('open');

  const params = new URLSearchParams({ skus: skus.join(',') });
  if (days) params.set('days', days);
  const d = await api('/api/sales/sku?' + params.toString());
  if (d.error) {
    document.getElementById('salesDetailSummary').textContent = 'Could not load orders — ' + dtEscape(d.error);
    document.getElementById('salesDetailBody').innerHTML = '<tr><td colspan="9" class="empty">—</td></tr>';
    return;
  }
  const s = d.summary || {};
  const orders = d.orders || [];
  document.getElementById('salesDetailTitle').textContent = label + (r.description ? ' — ' + r.description : '');
  document.getElementById('salesDetailSummary').textContent =
    `${Number(s.qty || 0).toLocaleString('en-IN')} units sold${days ? ' in the last ' + days + ' days' : ''}`
    + ` · ${inr(s.value)} · current stock ${d.stock != null ? Number(d.stock).toLocaleString('en-IN') : '—'}`
    + ` · ${Number(s.orders || 0)} orders`;
  // The orders query is capped; saying so beats a list that quietly stops.
  if (pager && orders.length >= 200) pager.textContent = 'Showing the 200 most recent of ' + Number(s.orders || 0) + ' orders';
  else if (pager && skus.length > 1) pager.textContent = skus.join(', ');
  salesRenderOrders(orders, 'salesDetailBody');
}

// Live check — asks Vinculum for the current stock of the SKUs on screen
// (up to 20, the API's per-call cap) right now, updates the snapshot, and
// re-renders. This is the genuinely-live path: a single fast call, so it works
// even on Vercel where the full sync cannot. Narrow the search first to check
// exactly the product you want.
async function liveCheckStock() {
  const all = window._stockSkus || [];
  const skus = all.slice(0, 20);
  if (!skus.length) { stockNotice('busy', 'Nothing to check — search a SKU or product first, then Live check.'); return; }
  const btn = document.getElementById('stockLiveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    const d = await api('/api/stock/live?skus=' + encodeURIComponent(skus.join(',')));
    if (d.error) {
      stockNotice('bad', 'Live check failed — ' + d.error);
    } else {
      stockNotice('ok', `Live checked ${d.checked} SKU(s) from Vinculum just now — ${d.found} in stock.` +
        (all.length > 20 ? ' (first 20 shown — narrow the search to check others)' : ''));
      await loadStock();
    }
  } catch (e) {
    stockNotice('bad', 'Live check failed — ' + (e.message || 'network error'));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Live check'; }
  }
}

// ══════════════════════════════════════════════════════
// IMS (admin-only embedded Apps Script web app)
// ══════════════════════════════════════════════════════
function loadIMS() {
  if (!ME || ME.role !== 'admin') return;       // hard gate
  if (_imsLoaded) return;                         // load the iframe once
  const frame = document.getElementById('imsFrame');
  const note  = document.getElementById('imsConfigNote');
  if (!frame) return;
  if (!IMS_WEBAPP_URL) {                           // no URL set yet
    if (note) note.style.display = 'block';
    frame.style.display = 'none';
    return;
  }
  if (note) note.style.display = 'none';
  frame.style.display = 'block';
  frame.src = IMS_WEBAPP_URL;
  _imsLoaded = true;
}

// ══════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════
async function loadDashboard() {
  const empFilter = document.getElementById('dashEmployeeFilter');
  const empVal = empFilter ? empFilter.value : 'all';
  const isAdmin = ME.role === 'admin';
  const isHod = ME.role === 'hod';
  const isPC = ME.role === 'pc';
  // ME.department may be blank — server will resolve from DB
  const hodParam = isHod ? '&hodDept='+encodeURIComponent(ME.department||'') : '';

  // PC date range params
  const dateFrom = isPC ? (document.getElementById('pcDateFrom')?.value || '') : '';
  const dateTo   = isPC ? (document.getElementById('pcDateTo')?.value || '') : '';
  const dateParams = (isPC && dateFrom && dateTo) ? `&dateFrom=${dateFrom}&dateTo=${dateTo}` : '';

  const baseUrl = (isAdmin || isHod || isPC)
    ? `/api/dashboard?employee=${empVal}${hodParam}${dateParams}&taskType=`
    : `/api/dashboard?taskType=`;
  const [dDel, dChl] = await Promise.all([
    api(baseUrl + 'delegation'),
    api(baseUrl + 'checklist')
  ]);

  // Error check: show error to user if DB or API fails
  if (dDel.error || dChl.error) {
    const errMsg = dDel.error || dChl.error;
    console.error('Dashboard API error:', errMsg);
    document.getElementById('dPending').textContent = 'Err';
    document.getElementById('dRevised').textContent = 'Err';
    document.getElementById('dCompleted').textContent = 'Err';
    document.getElementById('dashTbody').innerHTML = `<tr><td colspan="6" style="color:red;padding:16px;text-align:center">⚠️ Data load failed: ${errMsg}<br><small>Check /api/debug for details</small></td></tr>`;
    return;
  }

  // Keep raw per-type stats so the count cards can update per selected tab.
  window._dashStats = { del: dDel, chl: dChl };
  renderDashStats(dashType);

  if (isAdmin || isHod || isPC) {
    empFilter.style.display = 'block';

    if (isPC) {
      // Show date range filter for PC
      const drFilter = document.getElementById('pcDateRangeFilter');
      if (drFilter) drFilter.style.display = 'flex';
      // Smart dropdown: show only users with pending tasks
      await refreshPCEmployeeDropdown();
    } else if (empFilter.options.length <= 1) {
      const users = await api('/api/users');
      const filtered = isHod
        ? users.filter(u => u.department === ME.department)
        : users;
      filtered.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u.id; opt.textContent = u.name;
        empFilter.appendChild(opt);
      });
    }

    if (isAdmin) {
      document.getElementById('dashBtns').innerHTML = `
        <button class="btn btn-yellow" onclick="openHoliday()">🗓 Holidays</button>
        <button class="btn btn-green" onclick="openChecklist()">+ Checklist</button>
        <button class="btn btn-primary" onclick="openDelegate()">+ Delegate</button>`;
    } else if (isHod) {
      document.getElementById('dashBtns').innerHTML = `
        <button class="btn btn-green" onclick="openChecklist()">+ Checklist</button>
        <button class="btn btn-primary" onclick="openDelegate()">+ Delegate</button>`;
    } else if (ME.role === 'user') {
      document.getElementById('dashBtns').innerHTML = `
        <button class="btn btn-primary" onclick="openDelegate()">+ Assign Task</button>`;
    }
  }

  // Chart is (re)built inside renderDashStats() so it always matches the selected tab.

  // Combine both types for the unified pending table
  const allTodayPending = [...(dDel.todayPending||[]), ...(dChl.todayPending||[])];
  window._lastDashTasks = allTodayPending;
  // Rows behind the Completed card — fetched in the same call, filtered client-side.
  window._lastDashCompleted = [...(dDel.todayCompleted||[]), ...(dChl.todayCompleted||[])];
  // Future-dated rows, so the Total view can list what the Total card counts.
  window._lastDashUpcoming  = [...(dDel.upcomingTasks||[]), ...(dChl.upcomingTasks||[])];
  // Keep sort state across reloads (don't reset)
  renderDashTable(allTodayPending, dashType);

  // Load FMS section — respects same employee filter
  loadDashFMS();
}

// Update the three count cards + chart for the currently selected dashboard tab.
// 'all' → delegation + checklist (+ FMS pending); 'delegation'/'checklist'/'fms' → that type only.
function renderDashStats(type) {
  const s = window._dashStats || {};
  const del = s.del || {}, chl = s.chl || {};
  const fmsPending = (window._lastDashFMS || []).length;
  let pending, revised, completed;
  if (type === 'delegation') {
    pending = del.pending||0; revised = del.revised||0; completed = del.completed||0;
  } else if (type === 'checklist') {
    pending = chl.pending||0; revised = chl.revised||0; completed = chl.completed||0;
  } else if (type === 'fms') {
    pending = fmsPending; revised = 0; completed = 0;
  } else { // 'all'
    pending   = (del.pending||0)   + (chl.pending||0) + fmsPending;
    revised   = (del.revised||0)   + (chl.revised||0);
    completed = (del.completed||0) + (chl.completed||0);
  }
  // Total comes from the server, not pending+revised+completed: those three stop
  // at today, while Total counts future-dated tasks as well.
  const totalAll = (type === 'delegation') ? (del.total || 0)
                 : (type === 'checklist')  ? (chl.total || 0)
                 : (type === 'fms')        ? fmsPending
                 : (del.total || 0) + (chl.total || 0) + fmsPending;
  const upcomingAll = (type === 'delegation') ? (del.upcoming || 0)
                    : (type === 'checklist')  ? (chl.upcoming || 0)
                    : (type === 'fms')        ? 0
                    : (del.upcoming || 0) + (chl.upcoming || 0);
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('dTotal', totalAll);
  setTxt('dUpcoming', upcomingAll);
  setTxt('dPending', pending);
  setTxt('dRevised', revised);
  setTxt('dCompleted', completed);
  renderDashChart(completed, pending, revised);
}

// ── Count cards double as filters for the table below ──────────────────
// 'all' | 'pending' | 'revised' | 'completed'. All four filter in place; the
// completed rows come from the same /api/dashboard call (todayCompleted).
let _dashCard = 'all';

function dashCard(kind, el) {
  _dashCard = kind;
  document.querySelectorAll('.overview-cards .ov-card').forEach(c => {
    const on = c === el;
    c.classList.toggle('is-active', on);
    c.setAttribute('aria-pressed', String(on));
  });
  const title = document.getElementById('dashTableTitle');
  if (title) title.textContent =
    kind === 'pending'   ? 'Pending Tasks'   :
    kind === 'revised'   ? 'Revised Tasks'   :
    kind === 'completed' ? 'Completed Tasks' :
    kind === 'upcoming'  ? 'Upcoming Tasks'  : 'All Pending Tasks';
  if (window._lastDashTasks) renderDashTable(window._lastDashTasks, dashType);
}

// role="button" elements don't fire on Enter/Space by themselves.
function dashCardKey(ev, kind, el) {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  ev.preventDefault();
  dashCard(kind, el);
}

function renderDashChart(completed, pending, revised) {
  const canvas = document.getElementById('dashChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (dashChartInst) dashChartInst.destroy();
  dashChartInst = new Chart(canvas.getContext('2d'), {
    type:'pie',
    data:{labels:['Completed','Pending','Revised'],datasets:[{data:[completed,pending,revised],backgroundColor:['#10b981','#ef4444','#f59e0b'],borderWidth:3,borderColor:'#fff',hoverOffset:6}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` ${c.label}: ${c.raw}`}}}}
  });
}

// PC: date range change → refresh dropdown then dashboard
async function onPCFilterChange() {
  if (ME.role === 'pc') {
    await refreshPCEmployeeDropdown();
  }
  loadDashboard();
}

function clearPCDateFilter() {
  const df = document.getElementById('pcDateFrom');
  const dt = document.getElementById('pcDateTo');
  if (df) df.value = '';
  if (dt) dt.value = '';
  onPCFilterChange();
}

// Refresh PC employee dropdown — show only users with pending tasks
async function refreshPCEmployeeDropdown() {
  const empFilter = document.getElementById('dashEmployeeFilter');
  if (!empFilter) return;
  const dateFrom = document.getElementById('pcDateFrom')?.value || '';
  const dateTo   = document.getElementById('pcDateTo')?.value   || '';
  const dateQ    = (dateFrom && dateTo) ? `?dateFrom=${dateFrom}&dateTo=${dateTo}` : '';
  const pendingUsers = await api(`/api/users/with-pending-tasks${dateQ}`);
  // Save current dropdown value
  const currentVal = empFilter.value;
  empFilter.innerHTML = '<option value="all">All Employees</option>';
  (pendingUsers || []).forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id; opt.textContent = u.name;
    empFilter.appendChild(opt);
  });
  // Restore previous selection if still valid
  if (currentVal && [...empFilter.options].some(o => o.value === currentVal)) {
    empFilter.value = currentVal;
  } else {
    empFilter.value = 'all';
  }
}

function dashTab(type, el) {
  dashType = type;
  document.querySelectorAll('#dashTypeTabGroup .tab').forEach(t=>t.classList.remove('active'));
  if(el) el.classList.add('active');
  // Re-render table + count cards without a full API reload
  renderDashStats(dashType);
  if (window._lastDashTasks) {
    renderDashTable(window._lastDashTasks, dashType);
  } else {
    loadDashboard();
  }
}

// FMS Dashboard loader — fetches FMS rows used by the unified pending table
async function loadDashFMS() {
  // Keep the separate section hidden — FMS rows now render inside the main pending table
  const isAdmin = ME.role === 'admin';
  const isHod   = ME.role === 'hod';
  const isPC    = ME.role === 'pc';

  const empFilter = document.getElementById('dashEmployeeFilter');
  const empVal = empFilter ? empFilter.value : 'all';
  const url = `/api/fms-dashboard${(isAdmin||isHod||isPC) ? `?employee=${empVal}` : ''}`;

  const data = await api(url);
  if (data.error) {
    window._lastDashFMS = [];
    // Re-render unified table without FMS
    renderDashStats(dashType);
    if (window._lastDashTasks) renderDashTable(window._lastDashTasks, dashType);
    return;
  }

  const rows = data.rows || [];

  // Normalize for unified table
  window._lastDashFMS = rows.map(r => ({
    id: r.stepId || r.id || 0,
    type: 'fms',
    description: `${r.fmsName} — ${r.stepName}`,
    assignedToName: r.doer || '—',
    assignedByName: r.doer || '—',
    due_date: r.planDate || '',
    planValue: r.planValue || '',
    isLate: !!r.isLate,
    status: 'pending'
  }));

  // Re-render unified table + count cards now that FMS data is in
  renderDashStats(dashType);
  if (window._lastDashTasks) renderDashTable(window._lastDashTasks, dashType);
}

function toggleDashDateSort() {
  _dashDateSortState = (_dashDateSortState + 1) % 3; // 0→1→2→0
  const icon = document.getElementById('dashDateSortIcon');
  if (icon) {
    icon.textContent = _dashDateSortState === 0 ? '⇅' : _dashDateSortState === 1 ? '↑' : '↓';
    icon.style.color = _dashDateSortState === 0 ? 'var(--faint)' : 'var(--brand-deep)';
  }
  if (window._lastDashTasks) renderDashTable(window._lastDashTasks, dashType);
}

function renderDashTable(tasks, type) {
  // Show ALL pending tasks (delegation + checklist + FMS) combined
  const isAdmin = ME.role==='admin' || ME.role==='hod';
  const isPC    = ME.role==='pc';
  document.getElementById('dashDoerHead').textContent = (isAdmin||isPC)?'Doer':'Assigned By';
  const showPriority = (type === 'delegation');
  const prioHead = document.getElementById('dashPriorityHead');
  if (prioHead) prioHead.style.display = showPriority ? '' : 'none';
  const tbody = document.getElementById('dashTbody');
  window._dashTaskMap = {};

  // Which rows the active count card draws from. Total means every task, so it
  // reads both lists — otherwise the card could say 4 while the table showed 2.
  const showingCompleted = (_dashCard === 'completed');
  const showingAll       = (_dashCard === 'all');
  const showingUpcoming  = (_dashCard === 'upcoming');
  const openRows  = tasks || [];
  const doneRows  = window._lastDashCompleted || [];
  const laterRows = window._lastDashUpcoming || [];   // open, due after today

  // A revised delegation task comes back in the open list whatever its date, so
  // one dated in the future is in BOTH lists. Merging without this would print
  // it twice and make Total's row count disagree with the card.
  const dedupe = rows => {
    const seen = new Set();
    return rows.filter(t => {
      const key = `${t.type}:${t.id}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  };

  // Total = outstanding work, so completed rows are left out of it entirely.
  const source = showingCompleted ? doneRows
               : showingUpcoming  ? laterRows
               : showingAll       ? dedupe([...openRows, ...laterRows])
               : openRows;

  // Merge in FMS rows when the user wants 'all' or 'fms'. FMS rows are open
  // steps with no completed state, so they are left out of the completed view.
  let combined = (type === 'fms') ? [] : source.slice();
  if (!showingCompleted && !showingUpcoming && (!type || type === 'all' || type === 'fms')) {
    const fmsRows = window._lastDashFMS || [];
    combined = combined.concat(fmsRows);
  }

  // Two independent filters: the tab picks the task type, the count card picks
  // the status. FMS rows carry no status, so they count as plain pending.
  let allPending = combined.filter(t => {
    const matchType = (!type || type === 'all') ? true : t.type === type;
    const st = t.status || 'pending';
    const matchCard = (showingAll || showingUpcoming) ? (st !== 'completed') : (st === _dashCard);
    return matchType && matchCard;
  });
  // Apply date sort
  if (_dashDateSortState === 1) {
    allPending = [...allPending].sort((a,b) => (a.due_date||a.date||'').localeCompare(b.due_date||b.date||''));
  } else if (_dashDateSortState === 2) {
    allPending = [...allPending].sort((a,b) => (b.due_date||b.date||'').localeCompare(a.due_date||a.date||''));
  }
  const colCount = showPriority ? 6 : 5;
  if (!allPending.length) {
    const emptyMsg = showingCompleted ? 'No completed tasks in this range'
                   : showingUpcoming ? 'Nothing scheduled after today'
                   : _dashCard === 'revised' ? 'No revised tasks'
                   : _dashCard === 'pending' ? 'No pending tasks 🎉'
                   : 'No pending tasks 🎉';
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="empty">${emptyMsg}</td></tr>`; return;
  }
  const typeBadge = t => {
    if (t.type === 'fms') return `<span style="font-size:10px;background:#fff7ed;color:#A63F43;padding:2px 8px;border-radius:10px;font-weight:700;border:1px solid #fed7aa">📊 FMS</span>`;
    if (t.type === 'checklist') return `<span style="font-size:10px;background:#f0fdf4;color:#16a34a;padding:2px 8px;border-radius:10px;font-weight:700;border:1px solid #bbf7d0">✅ Checklist</span>`;
    return `<span style="font-size:10px;background:#eff6ff;color:#1d4ed8;padding:2px 8px;border-radius:10px;font-weight:700;border:1px solid #bfdbfe">📋 Delegation</span>`;
  };
  tbody.innerHTML = allPending.map(t => {
    if (t.type === 'fms') {
      const lateBadge = t.isLate
        ? `<span style="font-size:10px;background:#fef2f2;color:#dc2626;padding:2px 8px;border-radius:10px;font-weight:700;border:1px solid #fecaca">⏰ Late</span>`
        : `<span style="font-size:10px;background:#f0fdf4;color:#16a34a;padding:2px 8px;border-radius:10px;font-weight:700;border:1px solid #bbf7d0">✅ On Track</span>`;
      const dateCell = t.due_date
        ? `<span style="${t.isLate?'color:#dc2626;font-weight:600':''}">${fmtDate(t.due_date)}</span>`
        : `<span style="color:var(--faint);font-size:12px">${t.planValue||'—'}</span>`;
      return `<tr>
        <td style="white-space:nowrap">${typeBadge(t)}</td>
        <td>${t.description}</td>
        <td>${t.assignedToName}</td>
        <td>${dateCell}</td>
        ${showPriority ? `<td>—</td>` : ''}
        <td>${lateBadge}</td>
      </tr>`;
    }
    if (t.id) window._dashTaskMap[t.id] = t;
    const clientPill = t.client_name
      ? `<div style="margin-top:3px"><span style="font-size:10px;background:#fff7ed;color:#A63F43;padding:2px 7px;border-radius:6px;font-weight:600">🏢 ${dtEscape(t.client_name)}</span></div>`
      : '';
    const revisedPill = (t.status === 'revised' && t.waiting_approval != 1)
      ? `<div style="margin-top:3px"><span style="font-size:10px;background:#fffbeb;color:#d97706;padding:2px 7px;border-radius:6px;font-weight:600">🔄 Revised</span></div>`
      : '';
    const isDeleg = t.type === 'delegation';
    return `<tr onclick="window._dashTaskMap[${t.id}]&&openTaskDetail(window._dashTaskMap[${t.id}])" style="cursor:pointer" title="Click to view details">
      <td style="white-space:nowrap">${typeBadge(t)}</td>
      <td>${t.description||t.desc}${clientPill}${revisedPill}</td>
      <td>${(isAdmin||isPC)?t.assignedToName:t.assignedByName}</td>
      <td>${fmtDate(t.due_date||t.date)}</td>
      ${showPriority ? `<td>${isDeleg ? `<span class="priority-badge ${t.priority||'low'}">${t.priority||'low'}</span>` : '—'}</td>` : ''}
      <td onclick="event.stopPropagation()">
        ${t.status === 'completed' ? `
          <span class="status-badge completed">✓ Completed</span>
        ` : t.waiting_approval==1 ? `
          <span style="font-size:11px;color:#f59e0b;font-weight:600">⏳ Waiting Approval${t.approverName?` · ${dtEscape(t.approverName)}`:''}</span>
        ` : `
          ${(!isPC || t.type==='checklist') ? `<button class="action-btn done" onclick="updateStatus(${t.id},'completed','dashboard','${t.type}')">Done</button>` : ''}
          ${(!isPC && t.type!=='checklist') ? `<button class="action-btn revise" style="margin-left:3px" onclick="openReviseModal(${t.id},'${t.type}')">Revise</button>` : ''}
        `}
      </td>
    </tr>`;
  }).join('');
}

// ══════════════════════════════════════════════════════
// ALL TASKS
// ══════════════════════════════════════════════════════
let allTasksData = [];
let taskStatusFilter = 'pending';

let allTasksPage = 1;
const ALL_TASKS_PAGE_SIZE = 50;

async function loadAllTasks() {
  const isAdmin = ME.role==='admin';
  const isHod = ME.role==='hod';
  const isPC = ME.role==='pc';
  const isUser = ME.role==='user';
  const isDesktop = window.innerWidth >= 768;

  // Show/hide assign task button based on role
  const assignBtn = document.getElementById('tasksAssignBtn');
  if (assignBtn) assignBtn.style.display = (isAdmin || isHod || isUser) ? '' : 'none';

  // Delegate by Me tab — show only for users who can assign tasks
  const dbmTab = document.getElementById('tasksTabDelByMe');
  if (dbmTab) dbmTab.style.display = (isAdmin || isHod || isUser) ? '' : 'none';

  // All Checklist tab — admin/HOD only: full history (past, today, upcoming) + completed, filterable by employee
  const chlAllTab = document.getElementById('tasksTabChlAll');
  if (chlAllTab) chlAllTab.style.display = (isAdmin || isHod) ? '' : 'none';
  const isChecklistFull = tasksType === 'checklist-full';

  // PC desktop, or Admin/HOD on the All Checklist tab: show user filter + date range
  const filtersDiv = document.getElementById('tasksUserDateFilters');
  const showUserDateFilters = (isPC && isDesktop) || ((isAdmin || isHod) && isChecklistFull);
  if (filtersDiv) {
    filtersDiv.style.display = showUserDateFilters ? 'flex' : 'none';
  }

  const fetchType = tasksType === 'delegatebyme' ? 'delegation' : (isChecklistFull ? 'checklist' : tasksType);
  const mineParam = tasksType === 'delegatebyme' ? '&mine=1' : '';
  const fullParam = isChecklistFull ? '&full=1' : '';
  const data = await api(`/api/tasks?type=${fetchType}${mineParam}${fullParam}`);

  // Flatten all tasks — admin, HOD and PC get grouped response
  let allTasks = [];
  if (tasksType === 'delegatebyme') {
    if (data.grouped) {
      data.grouped.forEach(g => g.tasks.forEach(t => allTasks.push(t)));
    } else {
      allTasks = data.tasks || [];
    }
    allTasks = allTasks.filter(t => String(t.assigned_by) === String(ME.id));
  } else if (isAdmin || isHod || ME.role==='pc') {
    (data.grouped||[]).forEach(g => {
      g.tasks.forEach(t => allTasks.push(t));
    });
  } else {
    allTasks = data.tasks || [];
  }
  allTasksData = allTasks;
  allTasksPage = 1;

  // PC desktop, or Admin/HOD on All Checklist: populate employee dropdown
  if (showUserDateFilters) {
    const userSel = document.getElementById('tasksUserFilter');
    if (userSel) {
      const prevVal = userSel.value;
      const uniqueUsers = {};
      allTasks.forEach(t => {
        if (t.assigned_to && t.assignedToName) uniqueUsers[t.assigned_to] = t.assignedToName;
      });
      userSel.innerHTML = '<option value="all">All Employees</option>';
      Object.entries(uniqueUsers).sort((a,b)=>a[1].localeCompare(b[1])).forEach(([id,name]) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = name;
        userSel.appendChild(opt);
      });
      if (prevVal && [...userSel.options].some(o => o.value === prevVal)) userSel.value = prevVal;
    }
  }

  renderTasksTable();
}

function clearTasksDateFilter() {
  const f = document.getElementById('tasksDateFrom');
  const t = document.getElementById('tasksDateTo');
  if (f) f.value = '';
  if (t) t.value = '';
  filterTasks();
}

function filterTasks() { allTasksPage = 1; renderTasksTable(); }

function filterTaskStatus(status, el) {
  taskStatusFilter = status;
  allTasksPage = 1;
  document.querySelectorAll('#page-alltasks .tab-group .tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  renderTasksTable();
}

function renderTasksTable() {
  const isAdmin = ME.role==='admin' || ME.role==='hod'; // HOD gets admin-like view
  // PC gets view-only — see ME.role==='pc' branch in actionBtns below
  const search = (document.getElementById('taskSearch')?.value||'').toLowerCase();
  const userFilterVal = document.getElementById('tasksUserFilter')?.value || 'all';
  const dateFrom = document.getElementById('tasksDateFrom')?.value || '';
  const dateTo = document.getElementById('tasksDateTo')?.value || '';
  const container = document.getElementById('tasksContent');

  const todayStr = new Date().toISOString().slice(0, 10);
  let tasks = allTasksData.filter(t => {
    // A revised task is still active (not done), so it belongs under "Pending".
    // "Upcoming" is a date bucket, not a status — any open task dated after
    // today, whether it is pending or was revised into the future.
    const matchStatus =
      taskStatusFilter === 'all'      ? true :
      taskStatusFilter === 'pending'  ? ((t.status === 'pending' || t.status === 'revised') && (!t.due_date || t.due_date <= todayStr)) :
      taskStatusFilter === 'upcoming' ? (t.status !== 'completed' && t.due_date > todayStr) :
      t.status === taskStatusFilter;
    const matchSearch = !search ||
      (t.description||'').toLowerCase().includes(search) ||
      (t.assignedToName||'').toLowerCase().includes(search) ||
      (t.assignedByName||'').toLowerCase().includes(search) ||
      (t.due_date||'').includes(search) ||
      (t.remarks||'').toLowerCase().includes(search) ||
      (t.status||'').toLowerCase().includes(search) ||
      (t.priority||'').toLowerCase().includes(search);
    const matchUser = userFilterVal === 'all' || String(t.assigned_to) === String(userFilterVal);
    const matchDateFrom = !dateFrom || (t.due_date && t.due_date >= dateFrom);
    const matchDateTo = !dateTo || (t.due_date && t.due_date <= dateTo);
    return matchStatus && matchSearch && matchUser && matchDateFrom && matchDateTo;
  });

  if (!tasks.length) {
    container.innerHTML = `<div class="empty tasks-slide-in" style="background:var(--card);border-radius:var(--radius);border:1px solid var(--border);box-shadow:var(--shadow-xs);">No tasks found</div>`;
    return;
  }

  const totalPages = Math.ceil(tasks.length / ALL_TASKS_PAGE_SIZE);
  const pageTasks = tasks.slice((allTasksPage-1)*ALL_TASKS_PAGE_SIZE, allTasksPage*ALL_TASKS_PAGE_SIZE);

  // Re-build rows only for this page
  const isDelegateByMe = tasksType === 'delegatebyme';
  const isChecklistFull = tasksType === 'checklist-full';
  const isClickable = tasksType === 'delegation' || isDelegateByMe;
  // Group by doer only for roles that see more than their own work, and only
  // once a single employee has not been picked from the filter.
  const groupByDoer = (isAdmin || ME.role === 'pc') && userFilterVal === 'all';
  if (isClickable) window._taskDetailMap = {};
  // Shared row builder — the flat and grouped views must render rows identically.
  const rowsFor = rowList => rowList.map(t => {
    const isCompleted = t.status === 'completed';
    const isWaiting = t.waiting_approval == 1;
    const isChecklist = tasksType === 'checklist' || isChecklistFull;
    const editType = isDelegateByMe ? 'delegation' : (isChecklistFull ? 'checklist' : tasksType);
    if (isClickable) window._taskDetailMap[t.id] = t;

    const actionBtns = (isAdmin || isDelegateByMe) ? `
      <button class="action-btn edit" style="padding:4px 7px" onclick="openEditTask(${t.id},'${editType}')" title="Edit">✏️</button>
      <button class="action-btn delete" style="padding:4px 7px;margin-left:3px" onclick="deleteTask(${t.id},'${editType}')" title="Delete">🗑</button>
      <button class="action-btn" style="background:#eff6ff;color:#1d4ed8;padding:4px 7px;margin-left:3px" onclick="openComments(${t.id},'${editType}')" title="Comments">💬</button>
      ${!isCompleted && !isWaiting ? `<button class="action-btn done" style="margin-left:3px" onclick="updateStatus(${t.id},'completed','alltasks','${editType}')">Done</button>` : ''}
      ${!isChecklist && !isCompleted && !isWaiting ? `<button class="action-btn revise" style="margin-left:3px" onclick="openReviseModal(${t.id},'${editType}')">Revise</button>` : ''}
      ${isWaiting ? `<span style="font-size:11px;color:#f59e0b;font-weight:600;margin-left:4px">⏳ Waiting</span>` : ''}
    ` : (ME.role==='pc') ? `
      <button class="action-btn" style="background:#eff6ff;color:#1d4ed8;padding:4px 7px" onclick="openComments(${t.id},'${tasksType}')" title="Comments">💬</button>
      ${isChecklist && !isCompleted && !isWaiting ? `<button class="action-btn done" style="margin-left:3px" onclick="updateStatus(${t.id},'completed','alltasks','${tasksType}')">Done</button>` : ''}
      ${isWaiting ? `<span style="font-size:11px;color:#f59e0b;font-weight:600;margin-left:4px">⏳ Waiting</span>` : ''}
    ` : `
      <button class="action-btn" style="background:#eff6ff;color:#1d4ed8;padding:4px 7px" onclick="openComments(${t.id},'${tasksType}')" title="Comments">💬</button>
      ${!isCompleted && !isWaiting ? `
        <button class="action-btn done" style="margin-left:3px" onclick="updateStatus(${t.id},'completed','alltasks','${tasksType}')">Done</button>
        ${!isChecklist ? `<button class="action-btn revise" style="margin-left:3px" onclick="openReviseModal(${t.id},'${tasksType}')">Revise</button>` : ''}
      ` : ''}
      ${isWaiting ? `<span style="font-size:11px;color:#f59e0b;font-weight:600;margin-left:4px">⏳ Waiting Approval</span>` : ''}
    `;
    const clientCell = (tasksType === 'delegation' || isDelegateByMe)
      ? `<td style="white-space:nowrap;font-size:12px">${t.client_name ? `<span style="background:#fff7ed;color:#A63F43;padding:2px 7px;border-radius:6px;font-weight:600">🏢 ${dtEscape(t.client_name)}</span>` : '<span style="color:var(--faint)">—</span>'}</td>`
      : '';
    const trClick = isClickable
      ? `onclick="openTaskDetail(window._taskDetailMap[${t.id}])" style="cursor:pointer" title="Click to view details"`
      : '';
    return `<tr ${trClick}>
      <td style="white-space:nowrap;padding-right:12px" onclick="event.stopPropagation()">${actionBtns}</td>
      <td>${t.description||''}</td>
      <td style="white-space:nowrap">${t.assignedToName||''}</td>
      <td style="white-space:nowrap">${t.assignedByName||''}</td>
      <td style="white-space:nowrap">${fmtDate(t.due_date||'')||''}${(isChecklist && t.end_date) ? `<div style="font-size:10px;color:var(--faint);font-weight:600">🏁 ends ${fmtDate(t.end_date)}</div>` : ''}</td>
      ${clientCell}
      <td style="color:var(--muted-foreground);max-width:220px;word-break:break-word;overflow-wrap:anywhere;font-size:12px">${t.remarks||'—'}</td>
      <td style="white-space:nowrap"><span class="status-badge ${t.status}">${t.waiting_approval==1?'Awaiting Approval':t.status==='revised'?'Revised':t.status.charAt(0).toUpperCase()+t.status.slice(1)}</span></td>
    </tr>`;
  }).join('');
  const pageRows = rowsFor(pageTasks);

  const paginationHtml = totalPages > 1 ? `
    <div style="display:flex;align-items:center;justify-content:center;gap:10px;padding:12px;border-top:1px solid var(--border);font-size:13px;color:var(--muted-foreground)">
      <button onclick="if(allTasksPage>1){allTasksPage--;renderTasksTable();}" 
        style="padding:4px 12px;border:1.5px solid var(--border);border-radius:6px;background:var(--card);cursor:pointer;font-size:12px;${allTasksPage===1?'opacity:.4;cursor:not-allowed;pointer-events:none;':''}" >
        ◀ Prev
      </button>
      <span>Page <strong>${allTasksPage}</strong> of <strong>${totalPages}</strong> &nbsp;(${tasks.length} tasks)</span>
      <button onclick="if(allTasksPage<${totalPages}){allTasksPage++;renderTasksTable();}"
        style="padding:4px 12px;border:1.5px solid var(--border);border-radius:6px;background:var(--card);cursor:pointer;font-size:12px;${allTasksPage===totalPages?'opacity:.4;cursor:not-allowed;pointer-events:none;':''}" >
        Next ▶
      </button>
    </div>` : '';

  const showClientCol = tasksType === 'delegation' || tasksType === 'delegatebyme';
  const headHtml = `<thead><tr>
      <th style="white-space:nowrap">Action</th>
      <th>Desc</th>
      <th>Doer</th>
      <th>Assignee</th>
      <th>Date</th>
      ${showClientCol ? '<th>Project</th>' : ''}
      <th>Remarks</th>
      <th>Status</th>
    </tr></thead>`;
  const minW = showClientCol ? '820px' : '700px';

  // ── Grouped view ──
  // Only worth it when the viewer actually sees several people's work; a normal
  // user has one doer, so a single group would be pure noise. Groups render
  // collapsed, which is why this view drops pagination — the page stays short
  // until something is opened.
  if (groupByDoer) {
    const groups = new Map();
    for (const t of tasks) {
      const key = t.assigned_to || 'unassigned';
      if (!groups.has(key)) groups.set(key, { name: t.assignedToName || 'Unassigned', rows: [] });
      groups.get(key).rows.push(t);
    }
    const ordered = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));

    const pill = (text, bg, fg) =>
      `<span style="background:${bg};color:${fg};font-size:11px;font-weight:600;padding:3px 10px;border-radius:var(--radius-full);white-space:nowrap">${text}</span>`;

    const blocks = ordered.map((g, i) => {
      const done    = g.rows.filter(t => t.status === 'completed').length;
      const revised = g.rows.filter(t => t.status === 'revised').length;
      const pending = g.rows.filter(t => t.status === 'pending').length;
      return `<div class="user-task-block">
        <div class="utb-header" onclick="toggleTaskGroup(this)">
          <div style="display:flex;align-items:center;gap:10px;min-width:0">
            <span class="utb-arrow" style="color:var(--faint);font-size:11px;transition:transform .15s">▶</span>
            <span class="utb-name">${dtEscape(g.name)}</span>
          </div>
          <div class="utb-actions" style="flex-wrap:wrap;justify-content:flex-end">
            ${pill(`${g.rows.length} total`, 'var(--muted)', 'var(--muted-foreground)')}
            ${pending ? pill(`${pending} pending`, '#fef2f2', '#dc2626') : ''}
            ${revised ? pill(`${revised} revised`, '#fffbeb', '#d97706') : ''}
            ${done    ? pill(`${done} completed`, '#f0fdf4', '#16a34a') : ''}
          </div>
        </div>
        <div class="utb-body">
          <div class="flat-tasks-scroll">
            <table style="min-width:${minW};width:100%">${headHtml}<tbody>${rowsFor(g.rows)}</tbody></table>
          </div>
        </div>
      </div>`;
    }).join('');

    container.innerHTML = `
      <div class="tasks-slide-in">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-xs);padding:12px 18px;margin-bottom:10px">
          <span style="font-size:13px;font-weight:600;color:var(--muted-foreground)">${ordered.length} doer${ordered.length === 1 ? '' : 's'} · ${tasks.length} task${tasks.length === 1 ? '' : 's'}</span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-outline btn-sm" onclick="setAllTaskGroups(true)">Expand all</button>
            <button class="btn btn-outline btn-sm" onclick="setAllTaskGroups(false)">Collapse all</button>
          </div>
        </div>
        ${blocks}
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="flat-tasks-table tasks-slide-in">
      <div class="flat-tasks-scroll">
        <table style="min-width:${minW};width:100%">
          ${headHtml}
          <tbody>${pageRows}</tbody>
        </table>
      </div>
      ${paginationHtml}
    </div>`;
}

function toggleTaskGroup(header) {
  const body = header.nextElementSibling;
  const open = body.classList.toggle('open');
  const arrow = header.querySelector('.utb-arrow');
  if (arrow) arrow.style.transform = open ? 'rotate(90deg)' : '';
}

function setAllTaskGroups(open) {
  document.querySelectorAll('#tasksContent .user-task-block').forEach(b => {
    b.querySelector('.utb-body').classList.toggle('open', open);
    const arrow = b.querySelector('.utb-arrow');
    if (arrow) arrow.style.transform = open ? 'rotate(90deg)' : '';
  });
}

function tasksTab(type, el) {
  tasksType = type;
  document.querySelectorAll('#tasksTypeTabGroup .tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  loadAllTasks();
}

function openTaskDetail(t) {
  const priorityColors = { urgent:'#dc2626', high:'#ea580c', medium:'#d97706', low:'#16a34a' };
  const statusLabels = { pending:'Pending', completed:'Completed', revised:'Revision Requested', transferred:'Transferred' };
  const row = (label, value) => value
    ? `<div style="display:flex;gap:10px;align-items:flex-start;border-bottom:1px solid var(--border);padding-bottom:10px">
        <span style="min-width:110px;color:var(--muted-foreground);font-size:12px;font-weight:600;padding-top:1px">${label}</span>
        <span style="flex:1;word-break:break-word;overflow-wrap:anywhere">${value}</span>
      </div>`
    : '';
  const urlVal = t.url
    ? `<a href="${dtEscape(t.url)}" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:underline;word-break:break-all">${dtEscape(t.url)}</a>`
    : null;
  const priorityBadge = t.priority
    ? `<span style="background:${priorityColors[t.priority]||'var(--muted-foreground)'}22;color:${priorityColors[t.priority]||'var(--muted-foreground)'};padding:2px 9px;border-radius:5px;font-weight:600;font-size:12px">${t.priority.charAt(0).toUpperCase()+t.priority.slice(1)}</span>`
    : null;
  const statusBadge = t.status
    ? `<span class="status-badge ${t.status}" style="font-size:12px">${t.waiting_approval==1?'Awaiting Approval':(statusLabels[t.status]||t.status)}</span>`
    : null;

  document.getElementById('tdTitle').textContent = '📋 ' + (t.description || 'Task Detail');
  document.getElementById('tdBody').innerHTML = [
    row('Description', dtEscape(t.description||'')),
    row('Doer', dtEscape(t.assignedToName||'')),
    row('Assigned By', dtEscape(t.assignedByName||'')),
    row('Due Date', fmtDate(t.due_date||'')),
    row('Project', t.client_name ? `<span style="background:#fff7ed;color:#A63F43;padding:2px 8px;border-radius:6px;font-weight:600">🏢 ${dtEscape(t.client_name)}</span>` : null),
    row('Priority', priorityBadge),
    row('Status', statusBadge),
    row('Approval', t.approval === 'yes' ? '<span style="color:#16a34a;font-weight:600">Required</span>' : '<span style="color:var(--muted-foreground)">Not required</span>'),
    row('Approver', (t.approval === 'yes' && t.approverName) ? dtEscape(t.approverName) : null),
    row('Remarks', t.remarks ? dtEscape(t.remarks) : null),
    // Only present once a revision has actually been requested.
    row('Revision Reason', t.revise_reason
      ? `<span style="background:#fffbeb;color:#d97706;padding:4px 10px;border-radius:6px;display:inline-block">${dtEscape(t.revise_reason)}</span>`
      : null),
    row('URL', urlVal || '<span style="color:var(--faint)">No URL</span>'),
  ].filter(Boolean).join('');
  document.getElementById('taskDetailModal').classList.add('open');
}

function toggleBlock(header) { header.nextElementSibling.classList.toggle('open'); }

// ══════════════════════════════════════════════════════
// TASK ACTIONS
// ══════════════════════════════════════════════════════
async function updateStatus(id, status, from, type) {
  const r = await api(`/api/tasks/${id}/status`,'PUT',{status, type: type || dashType});
  if (r.needsApproval) {
    showToast('✅ Approval request sent to your manager!');
  }
  if (from==='dashboard') loadDashboard(); else loadAllTasks();
  loadApprovalBadge();
}

async function deleteTask(id, type) {
  if (!confirm('Delete this task?')) return;
  await api(`/api/tasks/${id}?type=${type||tasksType}`,'DELETE');
  loadAllTasks();
}

// ══════════════════════════════════════════════════════
// REVISE DATE MODAL
// ══════════════════════════════════════════════════════
function openReviseModal(taskId, taskType) {
  const today = new Date().toISOString().split('T')[0];
  // Min date = tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const minDate = tomorrow.toISOString().split('T')[0];

  document.getElementById('reviseTaskId').value = taskId;
  document.getElementById('reviseTaskType').value = taskType;
  document.getElementById('reviseDate').value = '';
  document.getElementById('reviseDate').min = minDate;
  document.getElementById('reviseReason').value = '';
  document.getElementById('reviseErr').style.display = 'none';
  document.getElementById('reviseDateModal').classList.add('open');
}

async function submitRevise() {
  const taskId   = document.getElementById('reviseTaskId').value;
  const taskType = document.getElementById('reviseTaskType').value;
  const newDate  = document.getElementById('reviseDate').value;
  const reason   = document.getElementById('reviseReason').value.trim();
  const err      = document.getElementById('reviseErr');
  err.style.display = 'none';

  if (!newDate) { err.textContent='Please select a new date'; err.style.display='block'; return; }

  // Send revise request with new date
  const r = await api(`/api/tasks/${taskId}/status`,'PUT',{
    status: 'revised',
    type: taskType,
    newDate,
    reason
  });

  if (r.error) { err.textContent = r.error; err.style.display='block'; return; }

  closeModal('reviseDateModal');
  if (r.needsApproval) {
    showToast('✅ Revision request sent to manager!');
  } else {
    showToast('Task revised with new date!');
  }
  loadDashboard();
  loadAllTasks();
  loadApprovalBadge();
}

// ══════════════════════════════════════════════════════
// EDIT TASK MODAL (Admin only)
// ══════════════════════════════════════════════════════
async function openEditTask(id, type) {
  // Fetch task details
  const data = await api(`/api/tasks/${id}/detail?type=${type}`);
  if (data.error) { showToast(data.error,'error'); return; }
  const t = data.task;

  document.getElementById('editTId').value = id;
  document.getElementById('editTType').value = type;
  document.getElementById('editTDesc').value = t.description || '';
  document.getElementById('editTDate').value = t.due_date || '';
  document.getElementById('editTRemarks').value = t.remarks || '';
  document.getElementById('editTaskErr').style.display = 'none';

  // Show/hide priority, approval, and URL for delegation only
  const isDeleg = type === 'delegation';
  document.getElementById('editTPriorityWrap').style.display = isDeleg ? 'block' : 'none';
  document.getElementById('editTApprovalWrap').style.display = isDeleg ? 'block' : 'none';
  const urlWrap = document.getElementById('editTUrlWrap');
  if (urlWrap) urlWrap.style.display = isDeleg ? 'block' : 'none';
  if (isDeleg) {
    document.getElementById('editTPriority').value = t.priority || 'low';
    document.getElementById('editTApproval').value = t.approval || 'no';
    const urlEl = document.getElementById('editTUrl');
    if (urlEl) urlEl.value = t.url || '';
  }

  document.getElementById('editTaskModal').classList.add('open');
}

async function saveEditTask() {
  const id      = document.getElementById('editTId').value;
  const type    = document.getElementById('editTType').value;
  const desc    = document.getElementById('editTDesc').value.trim();
  const date    = document.getElementById('editTDate').value;
  const remarks = document.getElementById('editTRemarks').value.trim();
  const err     = document.getElementById('editTaskErr');
  err.style.display = 'none';

  if (!desc) { err.textContent='Description required'; err.style.display='block'; return; }
  if (!date)  { err.textContent='Date required'; err.style.display='block'; return; }

  const body = { desc, date, remarks, type };
  if (type === 'delegation') {
    body.priority = document.getElementById('editTPriority').value;
    body.approval = document.getElementById('editTApproval').value;
    const urlEl = document.getElementById('editTUrl');
    body.url = urlEl ? (urlEl.value.trim() || null) : null;
  }

  const r = await api(`/api/tasks/${id}/edit`,'PUT', body);
  if (r.error) { err.textContent = r.error; err.style.display='block'; return; }

  closeModal('editTaskModal');
  showToast('Task updated!');
  loadAllTasks();
}

// ══════════════════════════════════════════════════════
// COMMENTS
// ══════════════════════════════════════════════════════
async function openComments(taskId, taskType) {
  document.getElementById('commentTaskId').value = taskId;
  document.getElementById('commentTaskType').value = taskType;
  document.getElementById('commentInput').value = '';
  await loadComments(taskId, taskType);
  document.getElementById('commentModal').classList.add('open');
}

async function loadComments(taskId, taskType) {
  const comments = await api(`/api/comments/${taskType}/${taskId}`);
  const container = document.getElementById('commentsList');
  if (!comments.length) {
    container.innerHTML = `<div class="comment-empty">No comments yet. Be the first!</div>`;
    return;
  }
  container.innerHTML = comments.map(c => `
    <div class="comment-item">
      <div class="comment-header">
        <span class="comment-author">👤 ${c.userName}</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="comment-time">${new Date(c.created_at).toLocaleString('en-IN')}</span>
          <button class="action-btn delete" style="padding:2px 7px;font-size:10px" onclick="deleteComment(${c.id})">✕</button>
        </div>
      </div>
      <div class="comment-text">${c.comment}</div>
    </div>`).join('');
  container.scrollTop = container.scrollHeight;
}

async function addComment() {
  const taskId = document.getElementById('commentTaskId').value;
  const taskType = document.getElementById('commentTaskType').value;
  const comment = document.getElementById('commentInput').value.trim();
  if (!comment) return;
  await api('/api/comments','POST',{taskId, taskType, comment});
  document.getElementById('commentInput').value = '';
  await loadComments(taskId, taskType);
}

async function deleteComment(id) {
  if (!confirm('Delete this comment?')) return;
  await api(`/api/comments/${id}`,'DELETE');
  const taskId = document.getElementById('commentTaskId').value;
  const taskType = document.getElementById('commentTaskType').value;
  await loadComments(taskId, taskType);
}

async function bulkDelete(userId) {
  if (!confirm(`Delete all ${tasksType} tasks for this user?`)) return;
  await api(`/api/tasks/user/${userId}?type=${tasksType}`,'DELETE');
  loadAllTasks();
}

async function transferToday(userId) {
  await api(`/api/tasks/user/${userId}/transfer-today?type=${tasksType}`,'PUT');
  loadAllTasks();
  showToast('Tasks moved to today!');
}

// ══════════════════════════════════════════════════════
// DELEGATE MODAL
// ══════════════════════════════════════════════════════
async function openDelegate() {
  document.getElementById('delegateErr').style.display='none';
  document.getElementById('dDesc').value='';
  document.getElementById('dUrl').value='';
  document.getElementById('dRemarks').value='';
  document.getElementById('dPriority').value='low';
  document.getElementById('dApproval').value='no';
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('dDate').value=today;
  document.getElementById('dDate').min=today;
  const [users, clients] = await Promise.all([api('/api/users'), api('/api/clients')]);
  // Cache for email lookup in onDelegateApproverChange()
  window._delegateUsers = users || [];
  const opts = (users || []).map(u=>`<option value="${u.id}" data-email="${dtEscape(u.email||'')}">${u.name}</option>`).join('');
  _dDoerPick = _dDoerPick || createUserPicker('dDoer', { placeholder: 'Select doer(s)' });
  _dDoerPick.setUsers(users || []);
  _dDoerPick.clear();
  document.getElementById('dApprover').innerHTML='<option value="">Select Approver</option>'+opts;
  // Client dropdown — pulls from Client Master
  const clientOpts = (clients || []).map(c => `<option value="${c.id}">${dtEscape(c.name)}</option>`).join('');
  document.getElementById('dClient').innerHTML = '<option value="">— No Project —</option>' + clientOpts;
  // Hidden by default — only shown when Approval Required = Yes
  document.getElementById('dApproverGroup').style.display = 'none';
  document.getElementById('dApproverEmail').style.display = 'none';
  document.getElementById('delegateModal').classList.add('open');
}

function onDelegateApprovalChange() {
  const approval = document.getElementById('dApproval').value;
  const group = document.getElementById('dApproverGroup');
  if (approval === 'yes') {
    group.style.display = 'block';
  } else {
    group.style.display = 'none';
    document.getElementById('dApprover').value = '';
    document.getElementById('dApproverEmail').style.display = 'none';
  }
}

function onDelegateApproverChange() {
  const sel = document.getElementById('dApprover');
  const opt = sel.options[sel.selectedIndex];
  const email = opt ? opt.getAttribute('data-email') : '';
  const box = document.getElementById('dApproverEmail');
  const text = document.getElementById('dApproverEmailText');
  if (email) {
    text.textContent = email;
    box.style.display = 'block';
  } else {
    box.style.display = 'none';
  }
}

async function saveDelegate() {
  const err = document.getElementById('delegateErr');
  err.style.display='none';
  const doers = _dDoerPick ? _dDoerPick.getSelected() : [];
  const date = document.getElementById('dDate').value;
  const desc = document.getElementById('dDesc').value.trim();
  const priority = document.getElementById('dPriority').value;
  const approval = document.getElementById('dApproval').value;
  const remarks = document.getElementById('dRemarks').value.trim();
  const url = document.getElementById('dUrl').value.trim() || null;
  const approver = approval === 'yes' ? document.getElementById('dApprover').value : '';
  const client_id = document.getElementById('dClient').value || null;
  if (!doers.length) { err.textContent='Please select at least one doer'; err.style.display='block'; return; }
  if (!date) { err.textContent='Please select a date'; err.style.display='block'; return; }
  if (!desc) { err.textContent='Description is required'; err.style.display='block'; return; }
  if (approval === 'yes' && !approver) { err.textContent='Please select an approver'; err.style.display='block'; return; }
  if (approval === 'yes' && doers.includes(String(approver))) { err.textContent='The approver cannot also be one of the doers — please deselect them.'; err.style.display='block'; return; }
  const r = await api('/api/tasks','POST',{type:'delegation',desc,assignedTo:doers,date,priority,approval,approver,remarks,client_id,url});
  if (r.error) { err.textContent = r.error; err.style.display = 'block'; return; }
  closeModal('delegateModal');
  if (doers.length > 1) {
    showToast(`Task delegated to ${r.created ?? doers.length} employees!`);
  } else if (r.adjusted) {
    showToast(`Task delegated! 📅 Moved to ${r.effectiveDate} (holiday/week-off)`);
  } else {
    showToast('Task delegated successfully!');
  }
  loadDashboard();
}

// ══════════════════════════════════════════════════════
// CHECKLIST MODAL - Recurring
// ══════════════════════════════════════════════════════
async function openChecklist() {
  document.getElementById('checklistErr').style.display='none';
  document.getElementById('checklistSuccess').style.display='none';
  document.getElementById('cDesc').value='';
  document.getElementById('cRemarks').value='';
  document.getElementById('cFrequency').value='daily';
  document.getElementById('cPreview').style.display='none';
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('cDate').value=today;
  document.getElementById('cDate').min=today;
  document.getElementById('cEndDate').value='';
  document.getElementById('cEndDate').min=today;
  const [users, clients] = await Promise.all([api('/api/users'), api('/api/clients')]);
  _cDoerPick = _cDoerPick || createUserPicker('cDoer', { placeholder: 'Select employee(s)' });
  _cDoerPick.setUsers(users || []);
  _cDoerPick.clear();
  document.getElementById('cClient').innerHTML='<option value="">— No Project —</option>'+
    (clients || []).map(c=>`<option value="${c.id}">${dtEscape(c.name)}</option>`).join('');

  populateFrequencyOptions();
  ['cFrequency','cDate','cEndDate','cDesc'].forEach(id=>{
    document.getElementById(id).onchange = updateChecklistPreview;
    document.getElementById(id).oninput = updateChecklistPreview;
  });

  document.getElementById('checklistModal').classList.add('open');
}

// ══════════════════════════════════════════════════════
// MULTI-SELECT EMPLOYEE PICKER
//
// One task can now go to several people at once. A native <select multiple>
// would have been less code, but it needs Ctrl-click — which people do not
// discover and which barely works on a touchscreen — so this is a checkbox list
// in a dropdown, with a search box and Select all / Clear.
//
// Selection is held here rather than in the DOM, so the caller asks for
// getSelected() instead of scraping checkboxes.
// ══════════════════════════════════════════════════════
// Built once each, the first time their modal opens.
let _dDoerPick = null, _cDoerPick = null;
let _mpickCloserBound = false;
const _mpickOpen = [];

function createUserPicker(hostId, { placeholder = 'Select employees' } = {}) {
  const host = document.getElementById(hostId);
  if (!host) return null;
  let users = [], selected = new Set(), filter = '';

  host.classList.add('mpick');
  host.innerHTML =
    '<button type="button" class="mpick-trigger">' +
      '<span class="mpick-text"></span><span class="mpick-caret">▼</span></button>' +
    '<div class="mpick-panel" hidden>' +
      '<input type="text" class="mpick-search" placeholder="Search employee…">' +
      '<div class="mpick-bar">' +
        '<button type="button" class="mpick-all">Select all</button>' +
        '<button type="button" class="mpick-none">Clear</button></div>' +
      '<div class="mpick-list"></div></div>';

  const trigger = host.querySelector('.mpick-trigger');
  const text    = host.querySelector('.mpick-text');
  const panel   = host.querySelector('.mpick-panel');
  const search  = host.querySelector('.mpick-search');
  const list    = host.querySelector('.mpick-list');

  const visible = () => {
    const q = filter.trim().toLowerCase();
    return q ? users.filter(u => (u.name || '').toLowerCase().includes(q)) : users;
  };

  function label() {
    if (!selected.size) return placeholder;
    if (selected.size === 1) {
      const u = users.find(x => String(x.id) === [...selected][0]);
      return u ? u.name : '1 selected';
    }
    return selected.size + ' employees selected';
  }

  function paintLabel() {
    text.textContent = label();
    text.classList.toggle('mpick-empty', !selected.size);
  }

  function draw() {
    paintLabel();
    const shown = visible();
    list.innerHTML = shown.length
      ? shown.map(u =>
          '<label class="mpick-row"><input type="checkbox" value="' + u.id + '"' +
          (selected.has(String(u.id)) ? ' checked' : '') + '>' +
          '<span>' + dtEscape(u.name || '') + '</span></label>').join('')
      : '<div class="mpick-empty-list">No employee matches that search</div>';
  }

  const close = () => { panel.hidden = true; host.classList.remove('open'); };
  const open  = () => {
    _mpickOpen.forEach(fn => fn());          // only one picker open at a time
    panel.hidden = false; host.classList.add('open'); search.focus();
  };
  _mpickOpen.push(close);

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden ? open() : close();
  });
  // Clicks inside the panel must not reach the document closer below.
  panel.addEventListener('click', (e) => e.stopPropagation());
  search.addEventListener('input', () => { filter = search.value; draw(); });
  // Only the label is repainted on a tick: redrawing the list would rebuild the
  // checkbox the user just clicked and lose their scroll position.
  list.addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb || cb.type !== 'checkbox') return;
    if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
    paintLabel();
  });
  // Select all applies to what the search is currently showing, which is what
  // "all" means when a filter is on.
  host.querySelector('.mpick-all').addEventListener('click', () => {
    visible().forEach(u => selected.add(String(u.id)));
    draw();
  });
  host.querySelector('.mpick-none').addEventListener('click', () => { selected.clear(); draw(); });

  if (!_mpickCloserBound) {
    document.addEventListener('click', () => _mpickOpen.forEach(fn => fn()));
    _mpickCloserBound = true;
  }

  draw();
  return {
    setUsers(next) { users = next || []; draw(); },
    getSelected() { return [...selected]; },
    count() { return selected.size; },
    clear() { selected.clear(); filter = ''; search.value = ''; close(); draw(); },
  };
}

// ── Checklist frequencies — the single source of truth ──
// This used to be six separate literals (dropdown options, labels, intervals,
// yearly counts, CSV validation, breakdown labels) that all had to be edited
// together. They now derive from this one list, so a new frequency is one row.
//
// step: how the next date is found. `days` walks forward N days; `months` and
// `years` step the calendar so month-ends stay put. `weekday` (0=Sun..6=Sat)
// pins the series to one day of the week — the start date is snapped forward to
// the first matching day, then it repeats weekly, which is what "Every Tuesday"
// has to mean regardless of which day the user picked as the start.
//
// `value` is stored in delegation/checklist rows and validated by the backend
// (VALID_FREQS in utils/dates.js) — keep the two lists in step, and keep every
// value within the column's VARCHAR(20).
const CHECKLIST_FREQS = [
  { value: 'daily',            label: 'Daily',            perYear: 365, step: { days: 1 } },
  { value: 'alternate_days',   label: 'Alternate Days',   perYear: 182, step: { days: 2 } },
  { value: 'weekly',           label: 'Weekly',           perYear: 52,  step: { days: 7 } },
  { value: 'every_tuesday',    label: 'Every Tuesday',    perYear: 52,  step: { days: 7 }, weekday: 2 },
  { value: 'every_thursday',   label: 'Every Thursday',   perYear: 52,  step: { days: 7 }, weekday: 4 },
  { value: 'every_10_days',    label: 'Every 10 Days',    perYear: 36,  step: { days: 10 } },
  { value: 'alternative_week', label: 'Alternative Week', perYear: 26,  step: { days: 14 } },
  { value: 'monthly',          label: 'Monthly',          perYear: 12,  step: { months: 1 } },
  { value: 'quarterly',        label: 'Quarterly',        perYear: 4,   step: { months: 3 } },
  { value: 'yearly',           label: 'Yearly',           perYear: 1,   step: { years: 1 } },
];

const FREQ_BY_VALUE = Object.fromEntries(CHECKLIST_FREQS.map(f => [f.value, f]));
const freqLabel = (v) => (FREQ_BY_VALUE[v] || {}).label || v || '';

// Fills the dropdown from the list above so the markup cannot drift out of step
// with it. Called when the checklist modal opens.
function populateFrequencyOptions() {
  const sel = document.getElementById('cFrequency');
  if (!sel || sel.dataset.filled === '1') return;
  const keep = sel.value;
  sel.innerHTML = CHECKLIST_FREQS.map(f =>
    `<option value="${f.value}">${f.label} (${f.perYear} task${f.perYear === 1 ? '' : 's'}/year)</option>`
  ).join('');
  if (keep && FREQ_BY_VALUE[keep]) sel.value = keep;
  sel.dataset.filled = '1';
}

// Moves `d` forward to the next date falling on `weekday` (0=Sun..6=Sat),
// leaving it alone when it already does.
function snapToWeekday(d, weekday) {
  const diff = (weekday - d.getDay() + 7) % 7;
  if (diff) d.setDate(d.getDate() + diff);
  return d;
}

function updateChecklistPreview() {
  const freq    = document.getElementById('cFrequency').value;
  const date    = document.getElementById('cDate').value;
  const endDate = document.getElementById('cEndDate').value;
  const desc    = document.getElementById('cDesc').value.trim();
  const box     = document.getElementById('cPreview');
  const txt     = document.getElementById('cPreviewText');
  if (!date || !desc) { box.style.display='none'; return; }

  box.style.display='block';

  if (endDate && endDate < date) {
    txt.textContent = '⚠️ End date cannot be earlier than the start date.';
    return;
  }

  // The preview counts only the dates that will actually be generated
  const dates = generateDates(date, freq, '', '', endDate);
  if (!dates.length) {
    txt.textContent = '⚠️ No tasks will be created in this range — please check the dates.';
    return;
  }

  const last = dates[dates.length - 1];
  const tail = endDate
    ? ` · End date: ${endDate}`
    : ' · (End date blank — defaults to 1 year)';
  txt.textContent = `"${desc}" — ${dates.length} task ${date} se ${last} tak banenge (${freqLabel(freq)})${tail}`;
}

function getEndDate(startDate, freq, count) {
  const d = new Date(startDate);
  // Approximate on purpose: this only sizes the default window, and the real
  // dates come from generateDates().
  const st = (FREQ_BY_VALUE[freq] || {}).step || { days: 1 };
  const perStep = (st.days || 0) + (st.months || 0) * 30 + (st.years || 0) * 365;
  d.setDate(d.getDate() + (perStep * (count-1)));
  return d.toISOString().split('T')[0];
}

// endDate (optional, 'YYYY-MM-DD') — di gayi ho to us date tak hi tasks banenge,
// otherwise the old default (daily=365, weekly=52, ...) stays in effect.
function generateDates(startDate, freq, weekOffStr, extraOffStr, endDate) {
  const dates = [];
  const d = new Date(startDate+'T00:00:00');
  const spec = FREQ_BY_VALUE[freq] || FREQ_BY_VALUE.daily;
  // 'Every Tuesday' must land on Tuesdays whatever start date was picked, so the
  // cursor moves forward to the first matching day before anything is emitted.
  if (spec.weekday != null) snapToWeekday(d, spec.weekday);
  const endDt = (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) ? new Date(endDate+'T00:00:00') : null;
  if (endDt && endDt < d) return [];
  // When an end date is set, the count is only a safety cap
  const count = endDt ? 3000 : spec.perYear;
  const weekOff = (weekOffStr||'').split(',').map(s=>parseInt(s.trim())).filter(n=>!isNaN(n));
  let extraOff = [];
  try { extraOff = extraOffStr ? JSON.parse(extraOffStr) : []; } catch(e) {}

  // Helper: get occurrence number of a weekday in its month (1=1st, 2=2nd...)
  function getNthWeekday(date) {
    const day = date.getDate();
    return Math.ceil(day / 7);
  }

  function isExtraOff(date) {
    const dayOfWeek = date.getDay();
    const nth = getNthWeekday(date);
    return extraOff.some(e => e.day === dayOfWeek && e.weeks.includes(nth));
  }

  let added = 0;
  let safety = endDt ? 40000 : count * 14;
  while (added < count && safety-- > 0) {
    if (endDt && d > endDt) break;   // end date passed — stop here
    const day = d.getDay();
    if (freq === 'daily') {
      if (weekOff.includes(day) || isExtraOff(d)) {
        d.setDate(d.getDate() + 1);
        continue;
      }
    }
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    dates.push(`${yyyy}-${mm}-${dd}`);
    added++;
    if (spec.step.days)        d.setDate(d.getDate() + spec.step.days);
    else if (spec.step.months) d.setMonth(d.getMonth() + spec.step.months);
    else if (spec.step.years)  d.setFullYear(d.getFullYear() + spec.step.years);
  }
  return dates;
}

async function saveChecklist() {
  const err = document.getElementById('checklistErr');
  const suc = document.getElementById('checklistSuccess');
  err.style.display='none'; suc.style.display='none';

  const doers   = _cDoerPick ? _cDoerPick.getSelected() : [];
  const date    = document.getElementById('cDate').value;
  const endDate = document.getElementById('cEndDate').value;
  const desc    = document.getElementById('cDesc').value.trim();
  const remarks = document.getElementById('cRemarks').value.trim();
  const freq    = document.getElementById('cFrequency').value;

  if (!doers.length) { err.textContent='Please select at least one employee'; err.style.display='block'; return; }
  if (!date) { err.textContent='Please select a start date'; err.style.display='block'; return; }
  if (!desc) { err.textContent='Task name is required'; err.style.display='block'; return; }
  if (endDate && endDate < date) { err.textContent='End date cannot be earlier than the start date'; err.style.display='block'; return; }

  const btn = document.getElementById('cGenerateBtn');
  btn.disabled=true; btn.textContent='Generating…';

  // No per-user week_off — holiday filtering happens server-side via /api/holidays
  const dates = generateDates(date, freq, '', '', endDate);
  if (!dates.length) {
    btn.disabled=false; btn.textContent='Generate Tasks';
    err.textContent='No tasks fall within this start/end date range — please check the dates';
    err.style.display='block'; return;
  }
  const client_id = document.getElementById('cClient').value || null;

  const result = await api('/api/tasks/bulk-checklist','POST',{
    desc, assignedTo: doers, priority: 'low', remarks, dates, client_id,
    endDate: endDate || dates[dates.length - 1], frequency: freq
  });

  btn.disabled=false; btn.textContent='Generate Tasks';

  if (result.error) { err.textContent=result.error; err.style.display='block'; return; }

  const skippedNote = result.skipped ? ` (${result.skipped} holiday date${result.skipped===1?'':'s'} skipped)` : '';
  const forNote = doers.length > 1 ? ` for ${doers.length} employees` : '';
  suc.textContent = `✅ ${result.count || dates.length} tasks generated${forNote} — ${date} se ${endDate || dates[dates.length-1]} tak!${skippedNote}`;
  suc.style.display='block';

  setTimeout(()=>{ closeModal('checklistModal'); loadDashboard(); }, 2000);
}

// ══════════════════════════════════════════════════════
// HOLIDAYS — server-backed; admin manages
// ══════════════════════════════════════════════════════
async function openHoliday() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('hDate').value='';
  document.getElementById('hDate').min=today;
  document.getElementById('hName').value='';
  document.getElementById('holidayErr').style.display = 'none';
  document.getElementById('holidayBulkFile').value = '';
  await refreshHolidays();
  document.getElementById('holidayModal').classList.add('open');
}

async function refreshHolidays() {
  try {
    const data = await api('/api/holidays');
    holidays = Array.isArray(data) ? data : [];
  } catch(e) { holidays = []; }
  renderHolidayList();
}

async function addHoliday() {
  const err = document.getElementById('holidayErr');
  err.style.display = 'none';
  const date = document.getElementById('hDate').value;
  const name = document.getElementById('hName').value.trim();
  if (!date||!name) { err.textContent='Date and name required!'; err.style.display='block'; return; }

  const r = await api('/api/holidays','POST',{ date, name });
  if (r.error) { err.textContent = r.error; err.style.display = 'block'; return; }

  document.getElementById('hDate').value='';
  document.getElementById('hName').value='';
  await refreshHolidays();

  const parts = [];
  if (r.deletedChecklist) parts.push(`${r.deletedChecklist} checklist task(s) removed`);
  if (r.pushedDelegation) parts.push(`${r.pushedDelegation} delegation task(s) pushed forward`);
  const detail = parts.length ? ' — ' + parts.join(', ') : '';
  showToast(`✅ Holiday added${detail}`);
}

async function deleteHoliday(id) {
  if (!confirm('Remove this holiday?')) return;
  const r = await api('/api/holidays/'+id, 'DELETE');
  if (r.error) { showToast(r.error, 'error'); return; }
  await refreshHolidays();
  showToast('🗑 Holiday removed');
}

function renderHolidayList() {
  const container = document.getElementById('holidayList');
  if (!holidays.length) { container.innerHTML='<div class="empty" style="padding:16px">No holidays added yet</div>'; return; }
  container.innerHTML = holidays.map(h => `
    <div class="holiday-item">
      <span><strong>${formatDate(h.holiday_date || h.date)}</strong> — ${dtEscape(h.name)}</span>
      <button class="action-btn delete" onclick="deleteHoliday(${h.id})">Remove</button>
    </div>`).join('');
}

function downloadHolidaySample() {
  const csv = `date,name\n2026-08-15,Independence Day\n2026-10-02,Gandhi Jayanti\n2026-11-09,Diwali\n2026-12-25,Christmas`;
  downloadFile(csv, 'holidays_sample.csv');
}

async function uploadHolidayBulk() {
  const err = document.getElementById('holidayErr');
  err.style.display = 'none';
  const file = document.getElementById('holidayBulkFile').files[0];
  if (!file) { err.textContent = 'Please select a CSV file'; err.style.display = 'block'; return; }

  const text = await file.text();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) { err.textContent = 'CSV is empty'; err.style.display = 'block'; return; }

  // Skip header if present (starts with "date" or contains "date,name")
  const firstLow = lines[0].toLowerCase();
  if (firstLow.startsWith('date,') || firstLow === 'date,name') lines.shift();

  const list = [];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(',').map(s => s.trim());
    if (parts.length < 2) { errors.push(`Line ${i+1}: missing name`); continue; }
    let date = parts[0];
    const name = parts.slice(1).join(',').trim();
    // Accept DD-MM-YYYY → convert to YYYY-MM-DD
    if (/^\d{2}-\d{2}-\d{4}$/.test(date)) date = date.split('-').reverse().join('-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push(`Line ${i+1}: invalid date "${parts[0]}"`); continue; }
    if (!name) { errors.push(`Line ${i+1}: empty name`); continue; }
    list.push({ date, name });
  }
  if (!list.length) {
    err.textContent = 'No valid rows. ' + (errors[0] || ''); err.style.display = 'block'; return;
  }

  const r = await api('/api/holidays/bulk', 'POST', { holidays: list });
  if (r.error) { err.textContent = r.error; err.style.display = 'block'; return; }

  document.getElementById('holidayBulkFile').value = '';
  await refreshHolidays();
  const parts = [`✅ ${r.added} holiday(s) added`];
  if (r.skipped) parts.push(`${r.skipped} skipped`);
  if (r.cascadeDeleted) parts.push(`${r.cascadeDeleted} checklist removed`);
  if (r.cascadePushed) parts.push(`${r.cascadePushed} delegation pushed`);
  showToast(parts.join(' · '));
}

function formatDate(d) {
  const dt = new Date(d+'T00:00:00');
  return dt.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}

// ══════════════════════════════════════════════════════
// BULK UPLOAD
// ══════════════════════════════════════════════════════
function downloadSample() {
  const csv = `doer_email,approver_email,due_date,priority,approval,description,remarks,client_name\npriyanka@test.com,aman@test.com,2026-04-01,high,yes,Complete sales report,Follow up needed,Bunai\npooja@test.com,aman@test.com,2026-04-02,medium,no,Prepare presentation,,Sohan Health Care`;
  downloadFile(csv,'delegation_sample.csv');
}

function downloadSampleC() {
  const csv = [
    'user_email,frequency,start_date,end_date,description,remarks',
    'priyanka@test.com,daily,2026-04-01,2026-06-30,Review attendance sheet,',
    'pooja@test.com,weekly,2026-04-01,2027-03-31,Send weekly report,',
    'rahul@test.com,monthly,2026-04-01,,Submit monthly expense report,end_date blank = defaults to 1 year',
    'neha@test.com,yearly,2026-04-01,,Annual performance self-review,',
    'amit@test.com,alternative_week,2026-04-01,2026-12-31,Bi-weekly team sync notes,',
    'sneha@test.com,quarterly,2026-04-01,2027-03-31,Quarterly audit checklist,Q2 2026',
  ].join('\n');
  downloadFile(csv,'checklist_bulk_sample.csv');
}

function downloadFile(content, filename) {
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(content);
  a.download = filename;
  a.click();
}

async function uploadCSV() {
  const file = document.getElementById('bulkFile').files[0];
  if (!file) { showToast('Please select a CSV file','error'); return; }
  const text = await file.text();
  const lines = text.trim().split('\n').slice(1);
  if (!lines.length) { showToast('CSV is empty','error'); return; }
  // Fetch users + clients once
  const [allUsers, allClients] = await Promise.all([api('/api/users'), api('/api/clients')]);
  const clientByName = {};
  (allClients || []).forEach(c => { clientByName[c.name.toLowerCase().trim()] = c.id; });
  let count = 0, skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const [doer_email,approver_email,due_date,priority,approval,description,remarks,client_name] = line.split(',').map(s=>s.trim());
    if (!doer_email||!description) { skipped++; continue; }
    const doer = allUsers.find(u=>u.email===doer_email);
    if (!doer) { skipped++; continue; }
    const client_id = client_name ? (clientByName[client_name.toLowerCase()] || null) : null;
    await api('/api/tasks','POST',{type:'delegation',desc:description,assignedTo:doer.id,approverEmail:approver_email,date:due_date,priority,approval,remarks,client_id});
    count++;
  }
  showToast(`✅ ${count} tasks uploaded! ${skipped?`(${skipped} skipped)`:''}`);
  closeModal('delegateModal');
  loadDashboard();
}

async function uploadCSVC() {
  const file = document.getElementById('bulkFileC').files[0];
  if (!file) { showToast('Please select a CSV file','error'); return; }
  const text = await file.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) { showToast('CSV is empty','error'); return; }

  // Detect format: new (frequency) vs old (due_date)
  const header = lines[0].toLowerCase().replace(/\s/g,'');
  const isNewFormat = header.includes('frequency') || header.includes('start_date');
  const hasEndDateCol = header.includes('end_date');

  const dataLines = lines.slice(1);
  const allUsers = await api('/api/users');

  let totalTasks = 0, skipped = 0;
  const validFreqs = CHECKLIST_FREQS.map(f => f.value);

  showToast('⏳ Generating tasks, please wait…');

  for (const line of dataLines) {
    if (!line.trim()) continue;

    let user_email, frequency, start_date, end_date, description, remarks;

    if (isNewFormat) {
      // New format: user_email, frequency, start_date, end_date, description, remarks
      // (end_date is optional — older CSVs keep working)
      const cols = line.split(',').map(s => s.trim());
      user_email = cols[0]; frequency = cols[1]; start_date = cols[2];
      if (hasEndDateCol) { end_date = cols[3]; description = cols[4]; remarks = cols[5]; }
      else               { end_date = '';      description = cols[3]; remarks = cols[4]; }
      if (!user_email || !description || !frequency || !start_date) { skipped++; continue; }
      frequency = frequency.toLowerCase();
      if (!validFreqs.includes(frequency)) { skipped++; continue; }
      if (end_date && !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) end_date = '';
    } else {
      // Old format fallback: user_email, due_date, priority, description, remarks
      let due_date, priority;
      [user_email, due_date, priority, description, remarks] = line.split(',').map(s => s.trim());
      if (!user_email || !description) { skipped++; continue; }
      const user = allUsers.find(u => u.email === user_email);
      if (!user) { skipped++; continue; }
      await api('/api/tasks','POST',{type:'checklist',desc:description,assignedTo:user.id,date:due_date,priority,remarks});
      totalTasks++;
      continue;
    }

    const user = allUsers.find(u => u.email === user_email);
    if (!user) { skipped++; continue; }

    const weekOff  = user.week_off  || '';
    const extraOff = user.extra_off || '';
    const dates    = generateDates(start_date, frequency, weekOff, extraOff, end_date);

    if (!dates.length) { skipped++; continue; }

    const result = await api('/api/tasks/bulk-checklist','POST',{
      desc: description,
      assignedTo: user.id,
      priority: 'low',
      remarks: remarks || '',
      dates,
      endDate: end_date || dates[dates.length - 1],
      frequency
    });

    if (!result.error) totalTasks += dates.length;
    else skipped++;
  }

  showToast(`✅ ${totalTasks} tasks generated!${skipped ? ` (${skipped} rows skipped)` : ''}`);
  closeModal('checklistModal');
  loadDashboard();
}

// ══════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════
let allUsersData = [];

async function loadUsers() {
  allUsersData = await api('/api/users');
  renderUsersTable(allUsersData);
}

function filterUsers() {
  const q = (document.getElementById('userSearch')?.value||'').toLowerCase().trim();
  if (!q) { renderUsersTable(allUsersData); return; }
  const filtered = allUsersData.filter(u =>
    (u.name||'').toLowerCase().includes(q) ||
    (u.email||'').toLowerCase().includes(q) ||
    (u.department||'').toLowerCase().includes(q) ||
    (u.role||'').toLowerCase().includes(q) ||
    (u.phone||'').includes(q)
  );
  renderUsersTable(filtered);
}

// Map to store full user data for safe edit access (avoids inline special-char bugs)
const _usersMap = {};

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTbody');
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--faint)">No users found</td></tr>`;
    return;
  }
  // Store all users in map so openEditUser(id) can safely retrieve data
  users.forEach(u => { _usersMap[u.id] = u; });
  const roleLabel = r => r==='admin'?'👑 Admin':r==='hod'?'🏢 HOD':r==='pc'?'🖥️ PC':'👤 User';
  tbody.innerHTML = users.map(u=>{
    const userRole = u.user_role || u.role;
    const showBoth = userRole !== u.role;
    return `
    <tr>
      <td style="font-weight:600">${u.name}</td>
      <td style="color:var(--muted-foreground)">${u.email}</td>
      <td style="color:var(--muted-foreground)">${u.phone||'—'}</td>
      <td style="color:var(--muted-foreground)">${u.department||'—'}</td>
      <td>
        <span class="role-badge ${u.role}" title="App Role — permissions">${roleLabel(u.role)}</span>
        ${showBoth ? `<br><span class="role-badge ${userRole}" style="font-size:10px;margin-top:3px;display:inline-block;opacity:.85" title="User Role — leave hierarchy">→ ${roleLabel(userRole)}</span>` : ''}
      </td>
      <td>
        <button class="action-btn edit" onclick="openEditUser(${u.id})">Edit</button>
        <button class="action-btn delete" style="margin-left:6px" onclick="deleteUser(${u.id})">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

function _setWeekOff(s) {
  const offs = (s||'').split(',').map(x=>x.trim()).filter(Boolean);
  document.querySelectorAll('.woff-cb').forEach(cb => { cb.checked = offs.includes(cb.value); });
}
function _getWeekOff() {
  return [...document.querySelectorAll('.woff-cb:checked')].map(cb=>cb.value).join(',');
}

// Extra Off — stored as JSON: [{day:6, weeks:[2,4]}]
let _extraOffData = [];

function _renderExtraOffList() {
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const weekNames = {1:'1st',2:'2nd',3:'3rd',4:'4th',5:'5th'};
  const container = document.getElementById('extraOffList');
  if (!container) return;
  container.innerHTML = _extraOffData.map((item,i) => `
    <div style="display:flex;align-items:center;gap:6px;background:var(--muted);border:1px solid var(--border);border-radius:8px;padding:6px 10px">
      <span style="font-size:12px;flex:1">
        <strong>${item.weeks.map(w=>weekNames[w]).join(', ')}</strong> ${dayNames[item.day]}
      </span>
      <select onchange="_extraOffData[${i}].day=parseInt(this.value);_renderExtraOffList()"
        style="padding:3px 6px;border:1px solid var(--border);border-radius:6px;font-size:12px;font-family:var(--font-sans);outline:none">
        ${[0,1,2,3,4,5,6].map(d=>`<option value="${d}" ${item.day===d?'selected':''}>${dayNames[d]}</option>`).join('')}
      </select>
      <div style="display:flex;gap:3px">
        ${[1,2,3,4,5].map(w=>`
          <label style="display:flex;align-items:center;gap:2px;font-size:11px;cursor:pointer;text-transform:none;letter-spacing:0">
            <input type="checkbox" ${item.weeks.includes(w)?'checked':''}
              onchange="if(this.checked)_extraOffData[${i}].weeks.push(${w});else _extraOffData[${i}].weeks=_extraOffData[${i}].weeks.filter(x=>x!==${w});_renderExtraOffList()"
              style="accent-color:var(--brand-deep);width:12px;height:12px"/>
            ${weekNames[w]}
          </label>`).join('')}
      </div>
      <button type="button" onclick="_extraOffData.splice(${i},1);_renderExtraOffList()"
        style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px;padding:0 2px">✕</button>
    </div>`).join('');
}

function addExtraOff() {
  _extraOffData.push({ day: 6, weeks: [2,4] }); // default: 2nd & 4th Saturday
  _renderExtraOffList();
}

function _setExtraOff(jsonStr) {
  try { _extraOffData = jsonStr ? JSON.parse(jsonStr) : []; } catch(e) { _extraOffData = []; }
  _renderExtraOffList();
}

function _getExtraOff() {
  return JSON.stringify(_extraOffData.filter(e => e.weeks.length > 0));
}

function openAddUser() {
  document.getElementById('userModalTitle').textContent='Add User';
  ['editUserId','uName','uEmail','uPhone','uDepartment','uPassword'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('uRole').value='user';
  document.getElementById('uUserRole').value='user';
  document.getElementById('pwdOptional').style.display='none';
  document.getElementById('userErr').style.display='none';
  document.getElementById('userSuccess').style.display='none';
  document.getElementById('userModal').classList.add('open');
}

function openEditUser(id) {
  const u = _usersMap[id];
  if (!u) { alert('User data not found. Please refresh the page.'); return; }
  document.getElementById('userModalTitle').textContent='Edit User';
  document.getElementById('editUserId').value=u.id;
  document.getElementById('uName').value=u.name||'';
  document.getElementById('uEmail').value=u.email||'';
  document.getElementById('uPhone').value=u.phone||'';
  document.getElementById('uDepartment').value=u.department||'';
  document.getElementById('uPassword').value='';
  document.getElementById('uRole').value=u.role||'user';
  document.getElementById('uUserRole').value=u.user_role||u.role||'user';
  document.getElementById('pwdOptional').style.display='inline';
  document.getElementById('userErr').style.display='none';
  document.getElementById('userSuccess').style.display='none';
  document.getElementById('userModal').classList.add('open');
}

async function saveUser() {
  const err=document.getElementById('userErr'); err.style.display='none';
  const suc=document.getElementById('userSuccess'); suc.style.display='none';
  const id=document.getElementById('editUserId').value;
  const name=document.getElementById('uName').value.trim();
  const email=document.getElementById('uEmail').value.trim();
  const phone=document.getElementById('uPhone').value.trim();
  const department=document.getElementById('uDepartment').value.trim();
  const password=document.getElementById('uPassword').value;
  const role=document.getElementById('uRole').value;
  const user_role=document.getElementById('uUserRole').value;
  if (!name||!email) { err.textContent='Name and email required'; err.style.display='block'; return; }
  if (!id&&!password) { err.textContent='Password required for new user'; err.style.display='block'; return; }
  const body={name,email,role,user_role,phone,department};
  if (password) body.password=password;
  const r = id ? await api(`/api/users/${id}`,'PUT',body) : await api('/api/users','POST',body);
  if (r.error) { err.textContent=r.error; err.style.display='block'; return; }
  closeModal('userModal');
  loadUsers();
}

function downloadUserSample() {
  const csv = `name,email,password,role,user_role,phone,department\nJohn Doe,john@test.com,pass123,user,user,9876543210,Sales\nJane Smith,jane@test.com,pass123,hod,hod,9876543211,Production\nIT Admin,it@test.com,pass123,admin,user,9876543212,IT\nAdmin User,admin2@test.com,pass123,admin,admin,,Management`;
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = 'users_sample.csv'; a.click();
  showToast('Sample CSV downloaded!');
}

async function uploadUsersCSV() {
  const file = document.getElementById('bulkUserFile').files[0];
  if (!file) { showToast('Please select a CSV file','error'); return; }
  const text = await file.text();
  const lines = text.trim().split('\n');
  const hdrs = lines[0].toLowerCase().split(',').map(h=>h.trim());
  const users = [];
  for (let i=1; i<lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(',').map(c=>c.trim());
    const u = {}; hdrs.forEach((h,hi) => u[h]=cols[hi]||'');
    if (u.name && u.email && u.password) users.push(u);
  }
  if (!users.length) { showToast('No valid rows found','error'); return; }
  const r = await api('/api/users/bulk','POST',{users});
  if (r.error) { showToast(r.error,'error'); return; }
  const suc = document.getElementById('userSuccess');
  suc.textContent = `✅ Added: ${r.added}, Skipped: ${r.skipped}`;
  suc.style.display='block';
  loadUsers();
}


// ══════════════════════════════════════════════════════
async function loadApprovalBadge() {
  const [d, lv] = await Promise.all([
    api('/api/approvals/count'),
    api('/api/leaves/pending-count')
  ]);
  const taskCnt = d.count || 0;
  const leaveCnt = lv?.count || 0;
  const total = taskCnt + leaveCnt;
  const badge = document.getElementById('approvalBadge');
  if (total > 0) {
    badge.textContent = total;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
  // Approvals page tab badges — task + leave (transfer is set in loadTransferBadge).
  const taskTabBadge = document.getElementById('apprTaskBadge');
  if (taskTabBadge) {
    if (taskCnt > 0) { taskTabBadge.textContent = taskCnt; taskTabBadge.style.display = 'inline-block'; }
    else taskTabBadge.style.display = 'none';
  }
  const tabBadge = document.getElementById('apprLeaveBadge');
  if (tabBadge) {
    if (leaveCnt > 0) { tabBadge.textContent = leaveCnt; tabBadge.style.display = 'inline-block'; }
    else tabBadge.style.display = 'none';
  }
  // Also refresh transfer badge
  loadTransferBadge();
}

function switchApprovalTab(tab, el) {
  document.querySelectorAll('#page-approvals .tab').forEach(t=>t.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('approvalsPanel').style.display = tab==='task' ? 'block' : 'none';
  document.getElementById('transferApprovalsPanel').style.display = tab==='transfer' ? 'block' : 'none';
  const leavePanel = document.getElementById('leaveApprovalsPanel');
  if (leavePanel) leavePanel.style.display = tab==='leave' ? 'block' : 'none';
  if (tab==='transfer') loadTransferApprovals();
  if (tab==='leave') loadLeaveApprovals();
}

async function loadApprovals() {
  // Show Transfer tab for admin/HOD/PC
  if (ME.role === 'admin' || ME.role === 'hod' || ME.role === 'pc') {
    document.getElementById('apprTabTransfer').style.display = 'block';
  }
  // Also pre-load leave approvals (so badge stays in sync)
  loadLeaveApprovals();

  const approvals = await api('/api/approvals');
  const container = document.getElementById('approvalsContent');
  const isAdminOrPC = ME.role === 'admin' || ME.role === 'pc';

  if (!approvals.length) {
    container.innerHTML = `<div class="empty" style="background:var(--card);border-radius:var(--radius);border:1px solid var(--border);box-shadow:var(--shadow-xs);">✅ No pending task approvals!</div>`;
  } else {
    container.innerHTML = `
      <div class="flat-tasks-table">
        <table>
          <thead><tr>
            <th>Employee</th>${isAdminOrPC ? '<th>Approver</th>' : ''}<th>Task</th><th>Action Requested</th><th>Requested On</th><th>Approve / Reject</th>
          </tr></thead>
          <tbody>
            ${approvals.map(a => `
              <tr>
                <td style="font-weight:600">${a.requestedByName}</td>
                ${isAdminOrPC ? `<td style="color:var(--muted-foreground);font-size:12px">${a.requestedToName}</td>` : ''}
                <td>${a.description||'—'}</td>
                <td><span class="status-badge ${a.action_type}">${a.action_type==='completed'?'✅ Mark Complete':'🔄 Revision'}</span>${(a.action_type==='revised' && a.new_date_fmt)?`<div style="font-size:11px;color:var(--muted-foreground);margin-top:3px">${a.currentDueDate?`${fmtDate(a.currentDueDate)} → `:''}<b style="color:#d97706">${fmtDate(a.new_date_fmt)}</b></div>`:''}</td>
                <td style="color:var(--muted-foreground);font-size:12px">${new Date(a.created_at).toLocaleDateString('en-IN')}</td>
                <td>
                  <button class="action-btn done" onclick="handleApproval(${a.id},'approved')">Approve</button>
                  <button class="action-btn delete" style="margin-left:6px" onclick="handleApproval(${a.id},'rejected')">Reject</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }
}

async function handleApproval(id, action) {
  const note = action === 'rejected' ? prompt('Reason for rejection (optional):') : '';
  const r = await api(`/api/approvals/${id}`,'PUT',{action, note: note||''});
  if (r && r.error) { showToast('⚠️ ' + r.error); }
  else { showToast(action === 'approved' ? '✅ Approved!' : '❌ Rejected!'); }
  loadApprovals();
  loadApprovalBadge();
}

async function deleteUser(id) {
  if (!confirm('Delete this user?')) return;
  const r=await api(`/api/users/${id}`,'DELETE');
  if (r.error) return alert(r.error);
  loadUsers();
}

// ══════════════════════════════════════════════════════
// HR — employee master (admin only). CRUD over /api/hr/*.
// ══════════════════════════════════════════════════════
// Every editable column, matched to a #hf_<field> input in the modal.
const HR_FIELDS = ['full_name','employee_code','designation','department','joining_date',
  'employment_type','employment_status','exit_date','reporting_manager','work_location','user_id',
  'official_email','kra',
  'gender','dob','blood_group','marital_status','personal_phone','personal_email',
  'current_address','permanent_address','emergency_contact_name','emergency_contact_phone',
  'emergency_contact_relation','pan','aadhaar','uan','pf_number','esic_number',
  'bank_name','bank_holder_name','bank_account','bank_ifsc','ctc','monthly_salary',
  'offer_letter_date','probation_end_date','confirmation_date','appointment_nda_status',
  'code_of_conduct_status','policy_handbook_status','bg_verification_status',
  'performance_remarks','record_log','notes'];

// Fields that map to an <input type=date> and need YYYY-MM-DD on load.
const HR_DATE_FIELDS = ['joining_date', 'exit_date', 'dob', 'probation_end_date', 'confirmation_date'];

const _hrMap = {};
let _hrTimer = null;
function hrDebounced() { clearTimeout(_hrTimer); _hrTimer = setTimeout(loadHr, 300); }

// A stored date/datetime → the YYYY-MM-DD an <input type=date> needs. A plain
// date string is used as-is; a Date/ISO (MySQL DATE comes back UTC-shifted, e.g.
// "…T18:30:00Z" for an IST-midnight date) is read with LOCAL getters so the day
// doesn't slip back by one.
function hrYmd(v) {
  if (!v) return '';
  const s = String(v);
  const plain = s.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (plain) return plain[1];
  const d = new Date(v); if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function hrDateLabel(v) { const y = hrYmd(v); return y ? new Date(y).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : ''; }

function hrStatusPill(s) {
  const t = /resign|terminat/i.test(s) ? '#dc2626' : /leave|notice/i.test(s) ? '#d97706' : '#16a34a';
  return `<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;color:${t};background:${t}1a">${dtEscape(s || '—')}</span>`;
}

function hrTile(label, value, tone) {
  const col = tone === 'good' ? '#16a34a' : tone === 'warn' ? '#dc2626' : 'var(--foreground)';
  return `<div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-foreground);margin-bottom:7px">${label}</div>
    <div style="font-size:24px;font-weight:800;letter-spacing:-.02em;line-height:1;color:${col}">${value}</div>
  </div>`;
}

async function loadHr() {
  const q = (document.getElementById('hrSearch') || {}).value || '';
  const status = (document.getElementById('hrStatusFilter') || {}).value || '';
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  if (status) params.set('status', status);
  const tiles = document.getElementById('hrTiles');
  const tbody = document.getElementById('hrTbody');
  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--faint)">Loading…</td></tr>';
  const d = await api('/api/hr/employees' + (params.toString() ? '?' + params : ''));
  if (d.error) { tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:24px;color:#dc2626">${dtEscape(d.error)}</td></tr>`; return; }
  const c = d.counts || {};
  tiles.innerHTML =
    hrTile('Total employees', Number(c.total || 0).toLocaleString('en-IN')) +
    hrTile('Active', Number(c.active || 0).toLocaleString('en-IN'), 'good') +
    hrTile('Inactive', Number(c.inactive || 0).toLocaleString('en-IN'), Number(c.inactive) ? 'warn' : null);
  renderHrTable(d.employees || []);
}

function renderHrTable(list) {
  const tbody = document.getElementById('hrTbody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--faint)">No employees yet — click “+ Add Employee”.</td></tr>`;
    return;
  }
  list.forEach(e => { _hrMap[e.id] = e; });
  tbody.innerHTML = list.map((e, i) => `
    <tr class="sales-row" style="cursor:pointer" onclick="openHrDetail(${e.id})">
      <td style="color:var(--faint);font-variant-numeric:tabular-nums">${i + 1}</td>
      <td style="font-weight:600">${dtEscape(e.full_name)}</td>
      <td style="color:var(--muted-foreground)">${dtEscape(e.designation || '—')}</td>
      <td style="color:var(--muted-foreground)">${dtEscape(e.department || '—')}</td>
      <td style="color:var(--muted-foreground)">${dtEscape(e.employment_type || '—')}</td>
      <td>${hrStatusPill(e.employment_status)}</td>
      <td style="color:var(--muted-foreground);white-space:nowrap">${dtEscape(e.personal_phone || '—')}</td>
      <td style="color:var(--muted-foreground)">${dtEscape(e.official_email || '—')}</td>
      <td style="color:var(--muted-foreground)">${e.login_name ? '🔗 ' + dtEscape(e.login_name) : '—'}</td>
      <td onclick="event.stopPropagation()">
        <button class="action-btn edit" onclick="openEditHr(${e.id})">Edit</button>
        <button class="action-btn delete" style="margin-left:6px" onclick="deleteHr(${e.id})">Delete</button>
      </td>
    </tr>`).join('');
}

// Populate the "Linked login account" dropdown; keeps `selectedId` selected.
async function loadHrLinkableUsers(selectedId) {
  const sel = document.getElementById('hf_user_id');
  if (!sel) return;
  const users = await api('/api/hr/linkable-users');
  if (!Array.isArray(users)) return;
  const sid = selectedId != null ? String(selectedId) : '';
  sel.innerHTML = '<option value="">— none —</option>' + users.map(u => {
    const linkedElsewhere = Number(u.already_linked) && String(u.id) !== sid;
    return `<option value="${u.id}" ${String(u.id) === sid ? 'selected' : ''} ${linkedElsewhere ? 'disabled' : ''}>${dtEscape(u.name)} — ${dtEscape(u.email)}${linkedElsewhere ? ' (already linked)' : ''}</option>`;
  }).join('');
}

function _hrClearForm() {
  HR_FIELDS.forEach(f => { const el = document.getElementById('hf_' + f); if (el) el.value = ''; });
  document.getElementById('hf_employment_status').value = 'Active';
  document.getElementById('hrErr').style.display = 'none';
}

function _hrFillForm(e) {
  HR_FIELDS.forEach(f => {
    const el = document.getElementById('hf_' + f); if (!el) return;
    let v = e[f];
    if (HR_DATE_FIELDS.includes(f)) v = hrYmd(v);
    el.value = (v === null || v === undefined) ? '' : v;
  });
  document.getElementById('hrErr').style.display = 'none';
}

async function openAddHr() {
  document.getElementById('hrModalTitle').textContent = 'Add Employee';
  document.getElementById('hrId').value = '';
  _hrClearForm();
  document.getElementById('hrModal').classList.add('open');
  loadHrLinkableUsers(null);
}

async function openEditHr(id) {
  const d = await api('/api/hr/employee?id=' + encodeURIComponent(id));
  if (d.error || d.notFound || !d.employee) { alert('Could not load this employee.'); return; }
  document.getElementById('hrModalTitle').textContent = 'Edit Employee';
  document.getElementById('hrId').value = id;
  _hrFillForm(d.employee);
  document.getElementById('hrModal').classList.add('open');
  loadHrLinkableUsers(d.employee.user_id);
}

async function saveHr() {
  const err = document.getElementById('hrErr'); err.style.display = 'none';
  const body = {};
  HR_FIELDS.forEach(f => { const el = document.getElementById('hf_' + f); if (el) body[f] = el.value; });
  if (!body.full_name || !body.full_name.trim()) { err.textContent = 'Full name is required'; err.style.display = 'block'; return; }
  const id = document.getElementById('hrId').value;
  const r = id ? await api('/api/hr/employees/' + id, 'PUT', body) : await api('/api/hr/employees', 'POST', body);
  if (r.error) { err.textContent = r.error; err.style.display = 'block'; return; }
  closeModal('hrModal');
  loadHr();
}

async function deleteHr(id) {
  const e = _hrMap[id];
  if (!confirm(`Delete employee record${e ? ' for ' + e.full_name : ''}? This cannot be undone.`)) return;
  const r = await api('/api/hr/employees/' + id, 'DELETE');
  if (r.error) return alert(r.error);
  closeModal('hrDetailModal');
  loadHr();
}

async function openHrDetail(id) {
  const body = document.getElementById('hrDetailBody');
  document.getElementById('hrDetailTitle').textContent = 'Employee';
  body.innerHTML = '<div class="empty" style="padding:20px">Loading…</div>';
  document.getElementById('hrDetailModal').classList.add('open');
  document.getElementById('hrDetailEditBtn').onclick = () => { closeModal('hrDetailModal'); openEditHr(id); };
  document.getElementById('hrDetailDelBtn').onclick = () => deleteHr(id);
  const d = await api('/api/hr/employee?id=' + encodeURIComponent(id));
  if (d.error || d.notFound || !d.employee) { body.innerHTML = '<div class="empty" style="padding:20px">Could not load this employee.</div>'; return; }
  const e = d.employee;
  document.getElementById('hrDetailTitle').textContent = `${dtEscape(e.full_name)}${e.employee_code ? ' · ' + dtEscape(e.employee_code) : ''}`;
  const row = (k, v) => (v === null || v === undefined || v === '') ? '' :
    `<div class="hr-drow"><div class="k">${k}</div><div class="v">${dtEscape(String(v))}</div></div>`;
  const money = v => (v === null || v === undefined || v === '' || Number(v) === 0) ? '' : inr(v);
  const sec = t => `<div class="hr-sec">${t}</div>`;
  const linked = e.login_name ? `${e.login_name} (${e.login_email || ''})` : '';
  const noteBlock = v => `<div class="hr-drow"><div class="v" style="white-space:pre-wrap">${dtEscape(v)}</div></div>`;
  const anyNotes = e.performance_remarks || e.record_log || e.notes;
  body.innerHTML =
    sec('Job') +
    row('Designation', e.designation) + row('Department', e.department) +
    row('Joining date', hrDateLabel(e.joining_date)) + row('Employment type', e.employment_type) +
    row('Status', e.employment_status) + row('Exit date', hrDateLabel(e.exit_date)) +
    row('Reporting manager', e.reporting_manager) + row('Work location', e.work_location) +
    row('Official email', e.official_email) + row('Linked login', linked) +
    (e.kra ? `<div class="hr-drow"><div class="k">KRA</div><div class="v" style="white-space:pre-wrap">${dtEscape(e.kra)}</div></div>` : '') +
    sec('Personal') +
    row('Gender', e.gender) + row('Date of birth', hrDateLabel(e.dob)) +
    row('Blood group', e.blood_group) + row('Marital status', e.marital_status) +
    row('Personal phone', e.personal_phone) + row('Personal email', e.personal_email) +
    row('Current address', e.current_address) + row('Permanent address', e.permanent_address) +
    row('Emergency contact', [e.emergency_contact_name, e.emergency_contact_relation && '(' + e.emergency_contact_relation + ')', e.emergency_contact_phone].filter(Boolean).join(' ')) +
    sec('Onboarding & Compliance') +
    row('Offer / expected DOJ', e.offer_letter_date) +
    row('Probation end', hrDateLabel(e.probation_end_date)) + row('Confirmation date', hrDateLabel(e.confirmation_date)) +
    row('Appointment / NDA', e.appointment_nda_status) + row('Code of conduct', e.code_of_conduct_status) +
    row('Policy handbook', e.policy_handbook_status) + row('BG verification', e.bg_verification_status) +
    sec('Statutory') +
    row('PAN', e.pan) + row('Aadhaar', e.aadhaar) + row('UAN', e.uan) + row('PF number', e.pf_number) + row('ESIC number', e.esic_number) +
    sec('Bank') +
    row('Bank name', e.bank_name) + row('Account holder', e.bank_holder_name) + row('Account number', e.bank_account) + row('IFSC', e.bank_ifsc) +
    sec('Salary') +
    row('CTC (annual)', money(e.ctc)) + row('Monthly salary', money(e.monthly_salary)) +
    (anyNotes ? sec('Notes & Log')
      + (e.performance_remarks ? `<div class="hr-drow"><div class="k">Performance</div><div class="v" style="white-space:pre-wrap">${dtEscape(e.performance_remarks)}</div></div>` : '')
      + (e.record_log ? `<div class="hr-drow"><div class="k">Record log</div><div class="v" style="white-space:pre-wrap">${dtEscape(e.record_log)}</div></div>` : '')
      + (e.notes ? noteBlock(e.notes) : '') : '');
}

// ══════════════════════════════════════════════════════
// PROFILE
// ══════════════════════════════════════════════════════
async function saveProfile() {
  const s=document.getElementById('profileSuccess'),e=document.getElementById('profileError');
  s.style.display='none'; e.style.display='none';
  const name=document.getElementById('pName').value.trim();
  const email=document.getElementById('pEmail').value.trim();
  const phone=document.getElementById('pPhone').value.trim();
  const currentPassword=document.getElementById('pCurrent').value;
  const newPassword=document.getElementById('pNew').value;
  const confirmPassword=document.getElementById('pConfirm').value;
  if (newPassword&&newPassword!==confirmPassword) { e.textContent='Passwords do not match'; e.style.display='block'; return; }
  const body={name,email,phone};
  if (currentPassword) { body.currentPassword=currentPassword; body.newPassword=newPassword; }
  const r=await api('/api/profile','PUT',body);
  if (r.error) { e.textContent=r.error; e.style.display='block'; return; }
  s.textContent='Profile updated!'; s.style.display='block';
  ME.name=name; ME.phone=phone;
  const initials=name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
  document.getElementById('sidebarName').textContent=name;
  document.getElementById('profileNameDisplay').textContent=name;
  if (!ME.profile_image) setAvatarDisplay(null, initials);
  document.getElementById('pCurrent').value='';
  document.getElementById('pNew').value='';
  document.getElementById('pConfirm').value='';
}

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════
// Escapes text before it goes into innerHTML. Named dt* because it started in
// the daily-task form; it outlived that feature and is used all over the app.
function dtEscape(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ══════════════════════════════════════════════════════
// SALES — order analytics from Vin eRetail order exports (admin only).
// Reads /api/sales, which reads the imported vin_orders table. Export-driven,
// not live — the freshness note keeps a stale batch from looking current.
// ══════════════════════════════════════════════════════
function inr(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }
function salesTile(label, value, note, tone) { return stockTile(label, value, note, tone); }

function salesNotice(kind, text) {
  const el = document.getElementById('salesNotice');
  if (!el) return;
  if (!text) { el.style.display = 'none'; return; }
  const skin = {
    ok:   ['#ECFDF3', '#A6F4C5', '#05603A'],
    busy: ['#FFF8E6', '#FDE68A', '#8A5A00'],
    bad:  ['#FEF3F2', '#FECDCA', '#B42318'],
  }[kind] || ['#F8FAFC', '#E2E8F0', '#334155'];
  el.style.background = skin[0];
  el.style.border = '1px solid ' + skin[1];
  el.style.color = skin[2];
  el.style.display = 'block';
  el.textContent = text;
}

// A labelled bar row list — used for status / channel / payment / state panels.
// Pass `dim` to make each row clickable → opens the matching orders in a popup.
function salesPanel(title, rows, dim) {
  const max = Math.max(1, ...rows.map(r => r.n));
  const body = rows.map(r => {
    const click = dim ? ` class="sales-row" data-dim="${dim}" data-val="${dtEscape(r.label)}" onclick="salesFilterBy(this.dataset.dim, this.dataset.val)"` : '';
    return `<div${click} style="display:flex;align-items:center;gap:8px;margin:4px 0;padding:3px 5px;border-radius:7px;${dim ? 'cursor:pointer' : ''}">
      <div style="flex:0 0 44%;font-size:12.5px;color:var(--foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${dtEscape(r.label)}</div>
      <div style="flex:1;background:var(--border);border-radius:6px;height:8px;overflow:hidden">
        <div style="width:${Math.round(r.n / max * 100)}%;height:100%;background:#6366f1"></div>
      </div>
      <div style="flex:0 0 auto;font-size:12px;color:var(--muted-foreground);font-variant-numeric:tabular-nums">${r.n}${r.sub ? ' · ' + r.sub : ''}</div>
    </div>`;
  }).join('');
  return `<div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 16px">
    <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);margin-bottom:8px">${title}</div>
    ${body || '<div class="empty">—</div>'}
  </div>`;
}

// Clicking a top product → popup of that SKU's orders, units, value and stock.
async function salesSkuDetail(sku) {
  const rangeSel = document.getElementById('salesRange');
  const fromI = document.getElementById('salesFrom'), toI = document.getElementById('salesTo');
  const params = new URLSearchParams({ sku });
  if (rangeSel && rangeSel.value !== 'all' && fromI.value && toI.value) { params.set('from', fromI.value); params.set('to', toI.value); }
  document.getElementById('salesDetailTitle').textContent = sku;
  document.getElementById('salesDetailSummary').textContent = 'Loading…';
  document.getElementById('salesDetailBody').innerHTML = '<tr><td colspan="9" class="empty">Loading…</td></tr>';
  document.getElementById('salesDetailModal').classList.add('open');
  const d = await api('/api/sales/sku?' + params.toString());
  if (d.error) { document.getElementById('salesDetailSummary').textContent = 'Error: ' + dtEscape(d.error); return; }
  const s = d.summary || {};
  document.getElementById('salesDetailTitle').textContent = `${sku}${s.name ? ' — ' + s.name : ''}`;
  document.getElementById('salesDetailSummary').textContent =
    `${Number(s.qty || 0).toLocaleString('en-IN')} units sold · ${inr(s.value)} · current stock ${d.stock != null ? Number(d.stock).toLocaleString('en-IN') : '—'} · ${Number(s.orders || 0)} orders`;
  salesRenderOrders(d.orders || [], 'salesDetailBody');
}

// Row click in a breakdown panel → full, paginated popup of orders matching
// that dimension value (channel / status / payment / state).
function salesFilterBy(dim, val) {
  if (!['channel', 'status', 'payment', 'state'].includes(dim)) return;
  salesModalOpen({ [dim]: val }, `${val} — orders`);
}

// A professional KPI card. With `filter`, it becomes clickable and filters the
// recent-orders table to that subset.
function salesKpi(label, value, sub, tone, filter) {
  const col = tone === 'good' ? '#16a34a' : tone === 'warn' ? '#dc2626' : 'var(--foreground)';
  const attr = filter ? ` class="sales-kpi" data-filter="${filter}" onclick="salesFilter('${filter}',this)"` : '';
  return `<div${attr} style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 18px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-foreground);margin-bottom:9px">${label}</div>
    <div style="font-size:25px;font-weight:800;letter-spacing:-.02em;line-height:1;color:${col}">${value}</div>
    ${sub ? `<div style="font-size:12px;color:var(--faint);margin-top:6px">${sub}</div>` : ''}
  </div>`;
}

// Daily-revenue bar chart — inline HTML bars, no chart library, theme-aware.
// Every bar is clickable (opens that day's orders) and shows a hover tooltip
// with the exact date, revenue and order count. Left axis carries value marks.
function salesTrendChart(daily) {
  if (!daily || !daily.length) return '';
  // Totals/avg/peak cover the WHOLE selected range so they agree with the
  // Revenue card; only the bars are capped, purely for readability.
  const total = daily.reduce((s, d) => s + (Number(d.revenue) || 0), 0);
  const avg = Math.round(total / daily.length);
  const peak = daily.reduce((a, b) => (Number(b.revenue) || 0) > (Number(a.revenue) || 0) ? b : a, daily[0]);
  const data = daily.length > 92 ? daily.slice(-92) : daily;
  const max = Math.max(1, ...data.map(d => Number(d.revenue) || 0));
  const fmtD = s => new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  const ymd = s => salesYmd(new Date(s));   // local YYYY-MM-DD for the day drilldown
  // Compact rupee for the axis marks: ₹1.9L / ₹95k / ₹40.
  const short = v => { v = Number(v) || 0; return v >= 1e5 ? '₹' + (v / 1e5).toFixed(v >= 1e6 ? 0 : 1).replace(/\.0$/, '') + 'L' : v >= 1e3 ? '₹' + Math.round(v / 1e3) + 'k' : '₹' + Math.round(v); };
  const peakYmd = ymd(peak.d);

  // Bars — each clickable (opens that day) and hover-tooltipped; peak highlighted.
  const bars = data.map(d => {
    const rev = Number(d.revenue) || 0;
    const h = rev > 0 ? Math.max(2, rev / max * 100) : 0;
    const isPeak = ymd(d.d) === peakYmd && rev > 0;
    return `<div class="sales-bar" data-d="${ymd(d.d)}" data-lbl="${fmtD(d.d)}" data-rev="${rev}" data-n="${d.n}"
        onmouseenter="salesBarTip(event,this)" onmousemove="salesBarTip(event,this)" onmouseleave="salesBarTipHide()"
        onclick="salesDayDetail(this.dataset.d)"
        style="flex:1;min-width:0;display:flex;align-items:flex-end;height:100%;cursor:pointer">
      <div style="width:100%;height:${h}%;background:${isPeak ? '#4338ca' : '#6366f1'};border-radius:2px 2px 0 0"></div>
    </div>`;
  }).join('');

  // Horizontal gridlines + left-axis value marks at 100/75/50/25 %.
  const marks = [1, .75, .5, .25].map(f => `
    <div style="position:absolute;left:0;right:0;bottom:${(f * 100).toFixed(2)}%;border-top:1px dashed var(--border);opacity:.7"></div>
    <div style="position:absolute;left:-46px;bottom:calc(${(f * 100).toFixed(2)}% - 6px);width:42px;text-align:right;font-size:9px;color:var(--faint)">${short(max * f)}</div>`).join('');

  // ~6 evenly spaced date labels along the bottom.
  const step = Math.max(1, Math.round(data.length / 6));
  const labels = data.map((d, i) =>
    (i % step === 0 || i === data.length - 1)
      ? `<span style="flex:1;text-align:center;font-size:9.5px;color:var(--faint);white-space:nowrap">${fmtD(d.d)}</span>`
      : '<span style="flex:1"></span>').join('');

  return `<div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 18px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;flex-wrap:wrap;gap:6px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground)">Daily revenue</div>
      <div style="font-size:11.5px;color:var(--muted-foreground)">Total <b>${inr(total)}</b> · avg <b>${inr(avg)}</b>/day · peak <b>${inr(peak.revenue)}</b> (${fmtD(peak.d)})</div>
    </div>
    <div style="padding-left:46px">
      <div style="position:relative;height:150px;border-bottom:1px solid var(--border)">
        ${marks}
        <div style="display:flex;align-items:flex-end;gap:2px;height:100%;position:relative;z-index:1">${bars}</div>
        <div id="salesChartTip" style="position:absolute;top:2px;display:none;pointer-events:none;z-index:5;background:#1e1b4b;color:#fff;padding:6px 9px;border-radius:8px;font-size:11px;line-height:1.35;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.28)"></div>
      </div>
      <div style="display:flex;gap:2px;margin-top:5px">${labels}</div>
    </div>
    <div style="font-size:10.5px;color:var(--faint);margin-top:9px;padding-left:46px">💡 Hover a bar for the day's figures · click a bar to see that day's orders</div>
  </div>`;
}

// Hover tooltip for a chart bar — filled from the bar's data-* and positioned
// over its centre (clamped inside the plot).
function salesBarTip(e, el) {
  const tip = document.getElementById('salesChartTip');
  if (!tip) return;
  const d = el.dataset;
  tip.innerHTML = `<div style="font-weight:700;margin-bottom:1px">${dtEscape(d.lbl)}</div>
    <div style="font-size:12.5px;font-weight:600">₹${Number(d.rev).toLocaleString('en-IN')}</div>
    <div style="color:#c7d2fe">${d.n} order${d.n === '1' ? '' : 's'}</div>
    <div style="color:#a5b4fc;font-size:9.5px;margin-top:2px">click for orders →</div>`;
  tip.style.display = 'block';
  const plot = tip.parentElement.getBoundingClientRect();
  const bar = el.getBoundingClientRect();
  let left = bar.left - plot.left + bar.width / 2;
  const tw = tip.offsetWidth;
  left = Math.max(tw / 2, Math.min(plot.width - tw / 2, left));
  tip.style.left = left + 'px';
  tip.style.transform = 'translateX(-50%)';
}
function salesBarTipHide() { const t = document.getElementById('salesChartTip'); if (t) t.style.display = 'none'; }

// Clicking a bar → popup listing that single day's orders (uses the paginated
// /sales/orders endpoint scoped to that one date).
async function salesDayDetail(ymd) {
  if (!ymd) return;
  const [Y, M, D] = ymd.split('-').map(Number);
  const title = new Date(Y, M - 1, D).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('salesDetailTitle').textContent = title + ' — orders';
  document.getElementById('salesDetailSummary').textContent = 'Loading…';
  document.getElementById('salesDetailBody').innerHTML = '<tr><td colspan="9" class="empty">Loading…</td></tr>';
  document.getElementById('salesDetailModal').classList.add('open');
  const d = await api('/api/sales/orders?from=' + ymd + '&to=' + ymd + '&page=1');
  if (d.error) { document.getElementById('salesDetailSummary').textContent = 'Error: ' + dtEscape(d.error); return; }
  const list = d.orders || [];
  const total = list.reduce((s, o) => s + Number(o.order_amount || 0), 0);
  const note = (d.pages > 1) ? ` · first ${list.length} shown` : '';
  document.getElementById('salesDetailSummary').textContent =
    `${Number(d.total || list.length).toLocaleString('en-IN')} orders · ${inr(Math.round(total))}${note}`;
  salesRenderOrders(list, 'salesDetailBody');
}

// Top products sold, by units, with a value column and a mini bar.
function salesTopSkus(rows) {
  if (!rows || !rows.length) return '';
  const max = Math.max(1, ...rows.map(r => Number(r.qty) || 0));
  const body = rows.map((r, i) => `<tr class="sales-row" style="cursor:pointer" data-sku="${dtEscape(r.sku)}" onclick="salesSkuDetail(this.dataset.sku)">
    <td style="color:var(--faint)">${i + 1}</td>
    <td style="font-family:var(--font-mono);font-size:11.5px;white-space:nowrap">${dtEscape(r.sku)}</td>
    <td>${dtEscape(r.sku_name || '')}</td>
    <td style="width:120px"><div style="background:var(--border);border-radius:5px;height:7px"><div style="width:${Math.round((Number(r.qty) || 0) / max * 100)}%;height:100%;background:#6366f1;border-radius:5px"></div></div></td>
    <td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${Number(r.qty).toLocaleString('en-IN')}</td>
    <td style="text-align:right;font-variant-numeric:tabular-nums;color:var(--muted-foreground)">${inr(r.value)}</td>
  </tr>`).join('');
  return `<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);margin:0 2px 8px">Top products sold</div>
    <div class="table-container"><table>
      <thead><tr><th style="width:24px">#</th><th>SKU</th><th>Product</th><th>Units</th><th style="text-align:right">Qty</th><th style="text-align:right">Value</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
}

// Date-range controls for the Sales page.
function salesYmd(dt) { const p = n => String(n).padStart(2, '0'); return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()); }
function salesSetRange(days) {
  const to = new Date(), from = new Date(to.getTime() - days * 86400000);
  document.getElementById('salesFrom').value = salesYmd(from);
  document.getElementById('salesTo').value = salesYmd(to);
}
function salesPreset(v) {
  const fromI = document.getElementById('salesFrom'), toI = document.getElementById('salesTo');
  if (v === 'all') { fromI.value = ''; toI.value = ''; }
  else if (v !== 'custom') salesSetRange(Number(v));
  loadSales();
}
function salesCustom() { document.getElementById('salesRange').value = 'custom'; loadSales(); }

async function loadSales() {
  const rangeSel = document.getElementById('salesRange');
  const fromI = document.getElementById('salesFrom'), toI = document.getElementById('salesTo');
  // First open: default to the 45-day preset.
  if (rangeSel && rangeSel.value === '45' && !fromI.value && !toI.value) salesSetRange(45);

  const tilesEl = document.getElementById('salesTiles');
  const trendEl = document.getElementById('salesTrend');
  const breakdownEl = document.getElementById('salesBreakdown');
  const topEl = document.getElementById('salesTopSkus');
  const body = document.getElementById('salesRecentBody');
  const spanEl = document.getElementById('salesSpan');
  tilesEl.innerHTML = ''; trendEl.innerHTML = ''; breakdownEl.innerHTML = ''; topEl.innerHTML = '';
  body.innerHTML = '<tr><td colspan="7" class="empty">Loading…</td></tr>';

  const params = new URLSearchParams();
  if (rangeSel && rangeSel.value !== 'all' && fromI.value && toI.value) { params.set('from', fromI.value); params.set('to', toI.value); }
  const d = await api('/api/sales' + (params.toString() ? '?' + params : ''));
  if (d.notConfigured) {
    salesNotice('busy', 'No orders synced on this server yet — run the Vin order sync to populate this page.');
    body.innerHTML = `<tr><td colspan="7" class="empty">No orders synced yet.</td></tr>`;
    return;
  }
  if (d.error) { body.innerHTML = `<tr><td colspan="7" class="empty">Could not load sales — ${dtEscape(d.error)}</td></tr>`; return; }

  const t = d.totals || {};
  const cancelPct = t.orders ? Math.round(t.cancelled / t.orders * 100) : 0;
  tilesEl.innerHTML =
    salesKpi('Revenue', inr(t.revenue), 'delivered + shipped, excl. cancelled', 'good', 'live') +
    salesKpi('Orders', Number(t.orders || 0).toLocaleString('en-IN'), `${Number(t.live_orders || 0).toLocaleString('en-IN')} live`, null, 'all') +
    salesKpi('Units sold', Number(t.units || 0).toLocaleString('en-IN'), null, null, 'live') +
    salesKpi('Avg order', inr(t.aov), null, null, 'live') +
    salesKpi('Cancelled', Number(t.cancelled || 0).toLocaleString('en-IN'), cancelPct + '% of orders', 'warn', 'cancelled');

  trendEl.innerHTML = salesTrendChart(d.daily);

  breakdownEl.innerHTML =
    salesPanel('By channel', (d.byChannel || []).map(c => ({ label: c.channel, n: c.n, sub: inr(c.revenue) })), 'channel') +
    salesPanel('By status', (d.byStatus || []).map(s => ({ label: s.status, n: s.n })), 'status') +
    salesPanel('Payment', (d.byPayment || []).map(p => ({ label: p.payment, n: p.n, sub: inr(p.revenue) })), 'payment') +
    salesPanel('Top ship-to states', (d.topStates || []).map(s => ({ label: s.state, n: s.n, sub: inr(s.revenue) })), 'state');

  topEl.innerHTML = salesTopSkus(d.topSkus);

  // Echo the chosen filter range so the side text matches what was picked; fall
  // back to the data's actual span only when no explicit range is set.
  const fmtD = ts => ts ? new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '?';
  if (rangeSel && rangeSel.value !== 'all' && fromI.value && toI.value) {
    spanEl.textContent = `${fmtD(fromI.value)} → ${fmtD(toI.value)}`;
  } else if (d.span) {
    spanEl.textContent = `${fmtD(d.span.first_order)} → ${fmtD(d.span.last_order)}`;
  }
  if (d.lastSync && d.lastSync.started_at) {
    const mins = Math.round((Date.now() - new Date(d.lastSync.started_at).getTime()) / 60000);
    const ago = mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} hr ago` : `${Math.round(mins / 1440)} days ago`;
    salesNotice('ok', `Live from Vin eRetail · last synced ${ago} · ${Number(d.lastSync.orders_seen || 0).toLocaleString('en-IN')} orders`);
  } else {
    salesNotice('busy', 'Orders loaded. Set up the daily order sync to keep this live.');
  }

  window._salesRecent = d.recent || [];
  loadSalesOrders(1);   // paginated full list for the chosen range
}

let _salesOrderSearchTimer = null;
function salesOrderSearchDebounced() {
  clearTimeout(_salesOrderSearchTimer);
  _salesOrderSearchTimer = setTimeout(() => loadSalesOrders(1), 300);
}

// The full, paginated + searchable orders list for the selected range.
async function loadSalesOrders(page) {
  const rangeSel = document.getElementById('salesRange');
  const fromI = document.getElementById('salesFrom'), toI = document.getElementById('salesTo');
  const q = (document.getElementById('salesOrderSearch') || {}).value || '';
  const params = new URLSearchParams({ page: String(page || 1) });
  if (rangeSel && rangeSel.value !== 'all' && fromI.value && toI.value) { params.set('from', fromI.value); params.set('to', toI.value); }
  if (q.trim()) params.set('q', q.trim());

  const body = document.getElementById('salesRecentBody');
  body.innerHTML = '<tr><td colspan="9" class="empty">Loading…</td></tr>';
  const d = await api('/api/sales/orders?' + params.toString());
  if (d.error) { body.innerHTML = `<tr><td colspan="9" class="empty">Could not load orders — ${dtEscape(d.error)}</td></tr>`; return; }

  const lbl = document.getElementById('salesOrdersLabel');
  if (lbl) lbl.textContent = `Orders (${Number(d.total || 0).toLocaleString('en-IN')})`;
  salesRenderOrders(d.orders || [], 'salesRecentBody');

  const pager = document.getElementById('salesOrdersPager');
  if (pager) {
    const p = d.page || 1, pages = d.pages || 1;
    pager.innerHTML = `
      <span>Page ${p} of ${pages} · ${Number(d.total || 0).toLocaleString('en-IN')} orders</span>
      <span style="display:flex;gap:6px">
        <button class="btn btn-sm" ${p <= 1 ? 'disabled' : ''} onclick="loadSalesOrders(${p - 1})">‹ Prev</button>
        <button class="btn btn-sm" ${p >= pages ? 'disabled' : ''} onclick="loadSalesOrders(${p + 1})">Next ›</button>
      </span>`;
  }
}

// Renders an orders list into the given table body.
function salesRenderOrders(list, bodyId) {
  const body = document.getElementById(bodyId || 'salesRecentBody');
  if (!body) return;
  const statusPill = s => {
    const tone = /cancel/i.test(s) ? '#dc2626' : /deliver|shipped|complete/i.test(s) ? '#16a34a' : '#d97706';
    return `<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;color:${tone};background:${tone}1a">${dtEscape(s || '—')}</span>`;
  };
  const fmtDT = ts => ts ? new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '';
  body.innerHTML = (list || []).map(o => `<tr class="sales-row" style="cursor:pointer" data-id="${dtEscape(o.order_id)}" onclick="openOrderDetail(this.dataset.id)">
    <td style="font-family:var(--font-mono);font-size:11.5px;white-space:nowrap">${dtEscape(o.order_id)}</td>
    <td style="white-space:nowrap">${dtEscape(o.customer_name || '—')}</td>
    <td style="white-space:nowrap">${dtEscape(o.customer_phone || '')}</td>
    <td style="white-space:nowrap">${fmtDT(o.order_date)}</td>
    <td>${dtEscape(o.channel_name || '—')}</td>
    <td>${dtEscape(o.payment_method || '')}</td>
    <td>${statusPill(o.status)}</td>
    <td style="text-align:right;font-variant-numeric:tabular-nums">${inr(o.order_amount)}</td>
    <td>${dtEscape([o.ship_city, o.ship_state].filter(Boolean).join(', '))}</td>
  </tr>`).join('') || '<tr><td colspan="9" class="empty">No orders in this view.</td></tr>';
}

// Full detail for one order — every stored field plus its line items.
async function openOrderDetail(id) {
  const bodyEl = document.getElementById('orderDetailBody');
  document.getElementById('orderDetailTitle').textContent = id;
  bodyEl.innerHTML = '<div class="empty" style="padding:20px">Loading…</div>';
  document.getElementById('orderDetailModal').classList.add('open');
  const d = await api('/api/sales/order?id=' + encodeURIComponent(id));
  if (d.error || d.notFound) { bodyEl.innerHTML = '<div class="empty" style="padding:20px">Could not load this order.</div>'; return; }
  const o = d.order || {};
  document.getElementById('orderDetailTitle').textContent = `Order ${dtEscape(o.order_id)}`;
  const dt = v => v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const money = v => Number(v) ? inr(v) : '';
  const row = (label, val) => (val === null || val === undefined || val === '') ? '' :
    `<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
       <div style="flex:0 0 40%;font-size:12px;color:var(--muted-foreground)">${label}</div>
       <div style="flex:1;font-size:12.5px;word-break:break-word">${dtEscape(String(val))}</div></div>`;
  const fields = [
    ['Order date', dt(o.order_date)], ['Status', o.status], ['Channel', o.channel_name],
    ['Order type', o.order_type], ['Payment', o.payment_method],
    ['Order amount', money(o.order_amount)], ['Discount', money(o.discount_amount)],
    ['Tax', money(o.tax_amount)], ['Shipping', money(o.shipping_charges)], ['COD charge', money(o.cod_charge)],
    ['Collectible', money(o.collectible_amount)], ['Store credit', money(o.store_credit)],
    ['Voucher', o.voucher_code], ['Promo', o.promo_name],
    ['Customer', o.customer_name], ['Phone', o.customer_phone], ['Email', o.customer_email], ['GSTIN', o.customer_gstin],
    ['Ship address', o.ship_address], ['Ship city', o.ship_city], ['Ship state', o.ship_state],
    ['Pincode', o.ship_pincode], ['Country', o.ship_country],
    ['Bill name', o.bill_name], ['Bill city', o.bill_city], ['Bill state', o.bill_state],
    ['Ext order no', o.ext_order_no], ['Fulfillment', o.fulfillment_loc],
    ['Ship by', dt(o.ship_by_date)], ['Shipped', dt(o.ship_date)], ['Delivered', dt(o.delivery_date)], ['Updated', dt(o.updated_date)],
    ['On hold', Number(o.is_on_hold) ? 'Yes' : ''], ['Replacement', Number(o.is_replacement) ? 'Yes' : ''], ['Verified', Number(o.is_verified) ? 'Yes' : ''],
    ['Remarks', o.order_remarks], ['Cancel remark', o.cancel_remark],
  ];
  const items = d.items || [];
  const itemsHtml = items.length ? `
    <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);margin:16px 0 6px">Items (${items.length})</div>
    <div class="table-container"><table>
      <thead><tr><th>SKU</th><th>Product</th><th style="text-align:right">Qty</th><th style="text-align:right">Price</th><th>Status</th></tr></thead>
      <tbody>${items.map(it => `<tr>
        <td style="font-family:var(--font-mono);font-size:11px;white-space:nowrap">${dtEscape(it.sku || '')}</td>
        <td>${dtEscape(it.sku_name || '')}</td>
        <td style="text-align:right">${Number(it.order_qty)}</td>
        <td style="text-align:right">${inr(it.unit_price)}</td>
        <td>${dtEscape(it.status || '')}</td></tr>`).join('')}</tbody>
    </table></div>` : '';
  // Every scalar field the API returned — covers all the Vin export columns and
  // then some. Collapsed by default so the curated view stays clean.
  const rawHtml = d.raw ? `<details style="margin-top:16px">
    <summary style="cursor:pointer;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground)">All fields (${Object.keys(d.raw).length})</summary>
    <div style="margin-top:8px">${Object.entries(d.raw).filter(([, v]) => v != null && v !== '' && typeof v !== 'object').map(([k, v]) => row(k, String(v))).join('')}</div>
  </details>` : '';
  bodyEl.innerHTML = `<div>${fields.map(f => row(f[0], f[1])).join('')}</div>${itemsHtml}${rawHtml}`;
}

// Shared loader for the orders popup (KPI cards + breakdown rows). Pulls the
// FULL filtered set from the server, paginated — so the count/revenue are exact
// and match the cards, instead of the old "latest 100" cached subset.
function salesModalOpen(base, title) {
  window._salesModal = { base: base || {}, title };
  document.getElementById('salesDetailTitle').textContent = title;
  document.getElementById('salesDetailModal').classList.add('open');
  salesModalLoad(1);
}
async function salesModalLoad(page) {
  const st = window._salesModal; if (!st) return;
  const params = new URLSearchParams(st.base);
  // Apply the page's chosen date range, same as the rest of the Sales view.
  const rangeSel = document.getElementById('salesRange');
  const fromI = document.getElementById('salesFrom'), toI = document.getElementById('salesTo');
  if (rangeSel && rangeSel.value !== 'all' && fromI.value && toI.value) { params.set('from', fromI.value); params.set('to', toI.value); }
  params.set('page', String(page || 1));
  document.getElementById('salesDetailSummary').textContent = 'Loading…';
  document.getElementById('salesDetailBody').innerHTML = '<tr><td colspan="9" class="empty">Loading…</td></tr>';
  const pagerEl = document.getElementById('salesDetailPager'); if (pagerEl) pagerEl.innerHTML = '';
  const d = await api('/api/sales/orders?' + params.toString());
  if (d.error) { document.getElementById('salesDetailSummary').textContent = 'Error: ' + dtEscape(d.error); return; }
  const total = Number(d.total || 0), pages = d.pages || 1, p = d.page || 1;
  const lo = total ? (p - 1) * (d.per || 100) + 1 : 0, hi = Math.min(total, (p - 1) * (d.per || 100) + (d.orders || []).length);
  document.getElementById('salesDetailSummary').textContent =
    `${total.toLocaleString('en-IN')} orders · ${inr(d.revenue || 0)}` + (pages > 1 ? ` · showing ${lo}–${hi}` : '');
  salesRenderOrders(d.orders || [], 'salesDetailBody');
  if (pagerEl && pages > 1) {
    pagerEl.innerHTML =
      `<button class="btn btn-sm" ${p <= 1 ? 'disabled' : ''} onclick="salesModalLoad(${p - 1})">‹ Prev</button>
       <span>Page ${p} / ${pages}</span>
       <button class="btn btn-sm" ${p >= pages ? 'disabled' : ''} onclick="salesModalLoad(${p + 1})">Next ›</button>`;
  }
}

// Clicking a KPI card opens the full, paginated list of matching orders.
function salesFilter(kind) {
  const titles = { all: 'All orders', live: 'Live orders (delivered + shipped)', cancelled: 'Cancelled orders' };
  const base = kind === 'live' ? { flag: 'live' } : kind === 'cancelled' ? { flag: 'cancelled' } : {};
  salesModalOpen(base, titles[kind] || 'Orders');
}

// ══════════════════════════════════════════════════════
// RETURNS — Return / RTO analytics (admin only). Reads /api/returns*, filled
// by returns-sync.js (v1/order/orderreturn). Mirrors the Sales page.
// ══════════════════════════════════════════════════════
function returnsNotice(kind, msg) {
  const el = document.getElementById('returnsNotice'); if (!el) return;
  const map = { ok: ['#059669', '#ecfdf5', '#a7f3d0'], busy: ['#b45309', '#fffbeb', '#fde68a'] };
  const [c, bg, bd] = map[kind] || map.busy;
  el.style.display = 'block'; el.style.color = c; el.style.background = bg; el.style.border = '1px solid ' + bd; el.textContent = msg;
}
function returnsSetRange(days) { const to = new Date(), from = new Date(to.getTime() - days * 86400000); document.getElementById('returnsFrom').value = salesYmd(from); document.getElementById('returnsTo').value = salesYmd(to); }
function returnsPreset(v) { const f = document.getElementById('returnsFrom'), t = document.getElementById('returnsTo'); if (v === 'all') { f.value = ''; t.value = ''; } else if (v !== 'custom') returnsSetRange(Number(v)); loadReturns(); }
function returnsCustom() { document.getElementById('returnsRange').value = 'custom'; loadReturns(); }

function returnsTile(label, value, sub, tone, filter) {
  const col = tone === 'warn' ? '#dc2626' : tone === 'good' ? '#16a34a' : 'var(--foreground)';
  const attr = filter ? ` class="sales-kpi" data-filter="${filter}" onclick="returnsFilter('${filter}')"` : '';
  return `<div${attr} style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 18px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-foreground);margin-bottom:9px">${label}</div>
    <div style="font-size:25px;font-weight:800;letter-spacing:-.02em;line-height:1;color:${col}">${value}</div>
    ${sub ? `<div style="font-size:12px;color:var(--faint);margin-top:6px">${sub}</div>` : ''}</div>`;
}

// Daily returns bar chart — interactive: each bar hover-tips (date, count,
// value) and is clickable (opens that day's returns). Left axis marks counts.
function returnsTrendChart(daily) {
  if (!daily || !daily.length) return '';
  const totalN = daily.reduce((s, d) => s + (Number(d.n) || 0), 0);
  const totalAmt = daily.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const avg = Math.round(totalN / daily.length);
  const peak = daily.reduce((a, b) => (Number(b.n) || 0) > (Number(a.n) || 0) ? b : a, daily[0]);
  const data = daily.length > 92 ? daily.slice(-92) : daily;
  const max = Math.max(1, ...data.map(d => Number(d.n) || 0));
  const fmtD = s => new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  const ymd = s => salesYmd(new Date(s));
  const peakYmd = ymd(peak.d);
  const bars = data.map(d => {
    const n = Number(d.n) || 0; const h = n > 0 ? Math.max(2, n / max * 100) : 0;
    const isPeak = ymd(d.d) === peakYmd && n > 0;
    return `<div class="returns-bar" data-d="${ymd(d.d)}" data-lbl="${fmtD(d.d)}" data-n="${n}" data-amt="${Number(d.amount) || 0}"
        onmouseenter="returnsBarTip(event,this)" onmousemove="returnsBarTip(event,this)" onmouseleave="returnsBarTipHide()"
        onclick="returnsDayDetail(this.dataset.d)"
        style="flex:1;min-width:0;display:flex;align-items:flex-end;height:100%;cursor:pointer">
      <div style="width:100%;height:${h}%;background:${isPeak ? '#9f1239' : '#e11d48'};border-radius:2px 2px 0 0"></div></div>`;
  }).join('');
  const marks = [1, .75, .5, .25].map(f => `
    <div style="position:absolute;left:0;right:0;bottom:${(f * 100).toFixed(2)}%;border-top:1px dashed var(--border);opacity:.7"></div>
    <div style="position:absolute;left:-42px;bottom:calc(${(f * 100).toFixed(2)}% - 6px);width:38px;text-align:right;font-size:9px;color:var(--faint)">${Math.round(max * f)}</div>`).join('');
  const step = Math.max(1, Math.round(data.length / 6));
  const labels = data.map((d, i) => (i % step === 0 || i === data.length - 1)
    ? `<span style="flex:1;text-align:center;font-size:9.5px;color:var(--faint);white-space:nowrap">${fmtD(d.d)}</span>` : '<span style="flex:1"></span>').join('');
  return `<div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 18px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;flex-wrap:wrap;gap:6px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground)">Daily returns</div>
      <div style="font-size:11.5px;color:var(--muted-foreground)">Total <b>${totalN}</b> · <b>${inr(totalAmt)}</b> · avg <b>${avg}</b>/day · peak <b>${peak.n}</b> (${fmtD(peak.d)})</div>
    </div>
    <div style="padding-left:42px">
      <div style="position:relative;height:130px;border-bottom:1px solid var(--border)">
        ${marks}
        <div style="display:flex;align-items:flex-end;gap:2px;height:100%;position:relative;z-index:1">${bars}</div>
        <div id="returnsChartTip" style="position:absolute;top:2px;display:none;pointer-events:none;z-index:5;background:#4c0519;color:#fff;padding:6px 9px;border-radius:8px;font-size:11px;line-height:1.35;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.28)"></div>
      </div>
      <div style="display:flex;gap:2px;margin-top:5px">${labels}</div>
    </div>
    <div style="font-size:10.5px;color:var(--faint);margin-top:9px;padding-left:42px">💡 Hover a bar for the day's figures · click a bar to see that day's returns</div>
  </div>`;
}
function returnsBarTip(e, el) {
  const tip = document.getElementById('returnsChartTip'); if (!tip) return;
  const d = el.dataset;
  tip.innerHTML = `<div style="font-weight:700;margin-bottom:1px">${dtEscape(d.lbl)}</div>
    <div style="font-size:12.5px;font-weight:600">${d.n} return${d.n === '1' ? '' : 's'}</div>
    <div style="color:#fecdd3">₹${Number(d.amt).toLocaleString('en-IN')}</div>
    <div style="color:#fda4af;font-size:9.5px;margin-top:2px">click for returns →</div>`;
  tip.style.display = 'block';
  const plot = tip.parentElement.getBoundingClientRect();
  const bar = el.getBoundingClientRect();
  let left = bar.left - plot.left + bar.width / 2;
  const tw = tip.offsetWidth;
  left = Math.max(tw / 2, Math.min(plot.width - tw / 2, left));
  tip.style.left = left + 'px';
  tip.style.transform = 'translateX(-50%)';
}
function returnsBarTipHide() { const t = document.getElementById('returnsChartTip'); if (t) t.style.display = 'none'; }
async function returnsDayDetail(ymd) {
  if (!ymd) return;
  const [Y, M, D] = ymd.split('-').map(Number);
  const title = new Date(Y, M - 1, D).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  returnsModalOpen({ from: ymd, to: ymd }, title + ' — returns');
}

// Breakdown panel; rows clickable when `dim` is a list filter (type / status).
function returnsPanel(title, rows, dim) {
  const max = Math.max(1, ...rows.map(r => r.n));
  const body = rows.map(r => {
    const click = dim ? ` class="sales-row" style="cursor:pointer" data-val="${dtEscape(r.label)}" onclick="returnsFilterBy('${dim}', this.dataset.val)"` : '';
    return `<div${click} style="display:flex;align-items:center;gap:8px;margin:4px 0;padding:3px 5px;border-radius:7px">
      <div style="flex:0 0 46%;font-size:12.5px;color:var(--foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${dtEscape(r.label)}">${dtEscape(r.label)}</div>
      <div style="flex:1;background:var(--border);border-radius:6px;height:8px;overflow:hidden"><div style="width:${Math.round(r.n / max * 100)}%;height:100%;background:#e11d48"></div></div>
      <div style="flex:0 0 auto;font-size:12px;color:var(--muted-foreground);font-variant-numeric:tabular-nums">${r.n}${r.sub ? ' · ' + r.sub : ''}</div>
    </div>`;
  }).join('');
  return `<div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 16px">
    <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);margin-bottom:8px">${title}</div>
    ${body || '<div class="empty">—</div>'}</div>`;
}
// Breakdown row → popup of matching returns (type / status / channel).
function returnsFilterBy(dim, val) {
  returnsModalOpen({ [dim]: val }, `${val} — returns`);
}
// KPI card → popup of that subset.
function returnsFilter(kind) {
  const titles = { all: 'All returns', rto: 'RTO — courier returns', delivered: 'Delivered returns — customer' };
  const base = kind === 'rto' ? { type: 'RTO' } : kind === 'delivered' ? { type: 'Delivered Return' } : {};
  returnsModalOpen(base, titles[kind] || 'Returns');
}
// Shared loader for the returns popup — pulls the full filtered set, paginated,
// so counts match the cards. `base` may carry from/to (day drill-down) or a
// dimension filter; the page's date range fills in when no from/to is given.
function returnsModalOpen(base, title) {
  window._returnsModal = { base: base || {}, title };
  document.getElementById('returnsModalTitle').textContent = title;
  document.getElementById('returnsListModal').classList.add('open');
  returnsModalLoad(1);
}
async function returnsModalLoad(page) {
  const st = window._returnsModal; if (!st) return;
  const params = new URLSearchParams(st.base);
  if (!params.has('from')) {
    const rangeSel = document.getElementById('returnsRange');
    const fromI = document.getElementById('returnsFrom'), toI = document.getElementById('returnsTo');
    if (rangeSel && rangeSel.value !== 'all' && fromI.value && toI.value) { params.set('from', fromI.value); params.set('to', toI.value); }
  }
  params.set('page', String(page || 1));
  document.getElementById('returnsModalSummary').textContent = 'Loading…';
  document.getElementById('returnsModalBody').innerHTML = '<tr><td colspan="9" class="empty">Loading…</td></tr>';
  const pagerEl = document.getElementById('returnsModalPager'); if (pagerEl) pagerEl.innerHTML = '';
  const d = await api('/api/returns/list?' + params.toString());
  if (d.error) { document.getElementById('returnsModalSummary').textContent = 'Error: ' + dtEscape(d.error); return; }
  const total = Number(d.total || 0), pages = d.pages || 1, p = d.page || 1;
  const lo = total ? (p - 1) * (d.per || 100) + 1 : 0, hi = Math.min(total, (p - 1) * (d.per || 100) + (d.returns || []).length);
  document.getElementById('returnsModalSummary').textContent =
    `${total.toLocaleString('en-IN')} returns · ${inr(d.amount || 0)}` + (pages > 1 ? ` · showing ${lo}–${hi}` : '');
  returnsRenderList(d.returns || [], 'returnsModalBody');
  if (pagerEl && pages > 1) {
    pagerEl.innerHTML =
      `<button class="btn btn-sm" ${p <= 1 ? 'disabled' : ''} onclick="returnsModalLoad(${p - 1})">‹ Prev</button>
       <span>Page ${p} / ${pages}</span>
       <button class="btn btn-sm" ${p >= pages ? 'disabled' : ''} onclick="returnsModalLoad(${p + 1})">Next ›</button>`;
  }
}

function returnsTopSkus(rows) {
  if (!rows || !rows.length) return '';
  const max = Math.max(1, ...rows.map(r => Number(r.qty) || 0));
  const body = rows.map((r, i) => `<tr>
    <td style="color:var(--faint)">${i + 1}</td>
    <td style="font-family:var(--font-mono);font-size:11.5px;white-space:nowrap">${dtEscape(r.sku)}</td>
    <td>${dtEscape(r.sku_name || '')}</td>
    <td style="width:120px"><div style="background:var(--border);border-radius:5px;height:7px"><div style="width:${Math.round((Number(r.qty) || 0) / max * 100)}%;height:100%;background:#e11d48;border-radius:5px"></div></div></td>
    <td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${Number(r.qty).toLocaleString('en-IN')}</td>
  </tr>`).join('');
  return `<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);margin:0 2px 8px">Most returned products</div>
    <div class="table-container"><table><thead><tr><th style="width:24px">#</th><th>SKU</th><th>Product</th><th>Returned</th><th style="text-align:right">Qty</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

async function loadReturns() {
  const rangeSel = document.getElementById('returnsRange');
  const fromI = document.getElementById('returnsFrom'), toI = document.getElementById('returnsTo');
  if (rangeSel && rangeSel.value === '45' && !fromI.value && !toI.value) returnsSetRange(45);
  const tiles = document.getElementById('returnsTiles'), trend = document.getElementById('returnsTrend'),
    bd = document.getElementById('returnsBreakdown'), top = document.getElementById('returnsTopSkus'),
    span = document.getElementById('returnsSpan');
  tiles.innerHTML = ''; trend.innerHTML = ''; bd.innerHTML = ''; top.innerHTML = '';
  const params = new URLSearchParams();
  if (rangeSel && rangeSel.value !== 'all' && fromI.value && toI.value) { params.set('from', fromI.value); params.set('to', toI.value); }
  const d = await api('/api/returns' + (params.toString() ? '?' + params : ''));
  if (d.notConfigured) { returnsNotice('busy', 'No returns synced on this server yet — run the Vin returns sync.'); document.getElementById('returnsBody').innerHTML = '<tr><td colspan="9" class="empty">No returns synced yet.</td></tr>'; return; }
  if (d.error) { document.getElementById('returnsBody').innerHTML = `<tr><td colspan="9" class="empty">Could not load returns — ${dtEscape(d.error)}</td></tr>`; return; }
  const t = d.totals || {};
  tiles.innerHTML =
    returnsTile('Returns', Number(t.returns || 0).toLocaleString('en-IN'), 'RTO + delivered', null, 'all') +
    returnsTile('Return value', inr(t.amount), null, 'warn', 'all') +
    returnsTile('Units returned', Number(t.units || 0).toLocaleString('en-IN'), null, null, 'all') +
    returnsTile('RTO', Number(t.rto || 0).toLocaleString('en-IN'), 'courier returns', null, 'rto') +
    returnsTile('Delivered returns', Number(t.delivered || 0).toLocaleString('en-IN'), 'customer returns', null, 'delivered');
  trend.innerHTML = returnsTrendChart(d.daily);
  bd.innerHTML =
    returnsPanel('By type', (d.byType || []).map(x => ({ label: x.type, n: x.n, sub: inr(x.amount) })), 'type') +
    returnsPanel('By status', (d.byStatus || []).map(x => ({ label: x.status, n: x.n })), 'status') +
    returnsPanel('Top return reasons', (d.byReason || []).map(x => ({ label: x.reason, n: x.n })), null) +
    returnsPanel('By channel', (d.byChannel || []).map(x => ({ label: x.channel, n: x.n, sub: inr(x.amount) })), null);
  top.innerHTML = returnsTopSkus(d.topSkus);
  const fmtD = ts => ts ? new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '?';
  if (rangeSel && rangeSel.value !== 'all' && fromI.value && toI.value) span.textContent = `${fmtD(fromI.value)} → ${fmtD(toI.value)}`;
  else if (d.span) span.textContent = `${fmtD(d.span.first_return)} → ${fmtD(d.span.last_return)}`;
  if (d.lastSync && d.lastSync.started_at) {
    const mins = Math.round((Date.now() - new Date(d.lastSync.started_at).getTime()) / 60000);
    const ago = mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} hr ago` : `${Math.round(mins / 1440)} days ago`;
    returnsNotice('ok', `Live from Vin eRetail · last synced ${ago} · ${Number(d.lastSync.returns_seen || 0).toLocaleString('en-IN')} returns`);
  } else returnsNotice('busy', 'Returns loaded. Set up the daily returns sync to keep this live.');
  loadReturnsList(1);
}

async function loadReturnsList(page) {
  const rangeSel = document.getElementById('returnsRange');
  const fromI = document.getElementById('returnsFrom'), toI = document.getElementById('returnsTo');
  const q = (document.getElementById('returnsSearch') || {}).value || '';
  const type = (document.getElementById('returnsTypeFilter') || {}).value || '';
  const status = (document.getElementById('returnsStatusFilter') || {}).value || '';
  const params = new URLSearchParams({ page: String(page || 1) });
  if (rangeSel && rangeSel.value !== 'all' && fromI.value && toI.value) { params.set('from', fromI.value); params.set('to', toI.value); }
  if (q.trim()) params.set('q', q.trim());
  if (type) params.set('type', type);
  if (status) params.set('status', status);
  const body = document.getElementById('returnsBody');
  body.innerHTML = '<tr><td colspan="9" class="empty">Loading…</td></tr>';
  const d = await api('/api/returns/list?' + params.toString());
  if (d.error) { body.innerHTML = `<tr><td colspan="9" class="empty">Could not load returns — ${dtEscape(d.error)}</td></tr>`; return; }
  document.getElementById('returnsListLabel').textContent = `Returns (${Number(d.total || 0).toLocaleString('en-IN')})`;
  returnsRenderList(d.returns || []);
  const pager = document.getElementById('returnsPager');
  const p = d.page || 1, pages = d.pages || 1;
  pager.innerHTML = `<span>Page ${p} of ${pages} · ${Number(d.total || 0).toLocaleString('en-IN')} returns · ${inr(d.amount || 0)}</span>
    <span style="display:flex;gap:6px">
      <button class="btn btn-sm" ${p <= 1 ? 'disabled' : ''} onclick="loadReturnsList(${p - 1})">‹ Prev</button>
      <button class="btn btn-sm" ${p >= pages ? 'disabled' : ''} onclick="loadReturnsList(${p + 1})">Next ›</button></span>`;
}
let _returnsTimer = null;
function returnsSearchDebounced() { clearTimeout(_returnsTimer); _returnsTimer = setTimeout(() => loadReturnsList(1), 300); }

function returnsRenderList(list, bodyId) {
  const body = document.getElementById(bodyId || 'returnsBody');
  if (!body) return;
  const pill = s => { const t = /closed/i.test(s) ? '#16a34a' : '#d97706'; return `<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;color:${t};background:${t}1a">${dtEscape(s || '—')}</span>`; };
  const typeb = ty => { const t = /rto/i.test(ty) ? '#dc2626' : '#7c3aed'; return `<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;color:${t};background:${t}14">${dtEscape(ty || '—')}</span>`; };
  const fmtDT = ts => ts ? new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '';
  body.innerHTML = (list || []).map(o => `<tr class="sales-row" style="cursor:pointer" data-id="${dtEscape(o.return_no)}" onclick="openReturnDetail(this.dataset.id)">
    <td style="font-family:var(--font-mono);font-size:11.5px;white-space:nowrap">${dtEscape(o.return_no)}</td>
    <td>${typeb(o.return_type)}</td>
    <td style="font-family:var(--font-mono);font-size:11px;white-space:nowrap">${dtEscape(o.eretail_order_no || '—')}</td>
    <td style="white-space:nowrap">${fmtDT(o.return_date)}</td>
    <td>${dtEscape(o.channel_name || '—')}</td>
    <td style="white-space:nowrap">${dtEscape(o.customer_name || '—')}</td>
    <td>${dtEscape([o.customer_city, o.customer_state].filter(Boolean).join(', '))}</td>
    <td>${pill(o.status)}</td>
    <td style="text-align:right;font-variant-numeric:tabular-nums">${inr(o.return_amount)}</td>
  </tr>`).join('') || '<tr><td colspan="9" class="empty">No returns in this view.</td></tr>';
}

async function openReturnDetail(id) {
  const bodyEl = document.getElementById('returnDetailBody');
  document.getElementById('returnDetailTitle').textContent = id;
  bodyEl.innerHTML = '<div class="empty" style="padding:20px">Loading…</div>';
  document.getElementById('returnDetailModal').classList.add('open');
  const d = await api('/api/returns/detail?id=' + encodeURIComponent(id));
  if (d.error || d.notFound) { bodyEl.innerHTML = '<div class="empty" style="padding:20px">Could not load this return.</div>'; return; }
  const o = d.ret || {};
  document.getElementById('returnDetailTitle').textContent = `Return ${dtEscape(o.return_no)}`;
  const dt = v => v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const money = v => Number(v) ? inr(v) : '';
  const row = (l, val) => (val === null || val === undefined || val === '') ? '' :
    `<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)"><div style="flex:0 0 40%;font-size:12px;color:var(--muted-foreground)">${l}</div><div style="flex:1;font-size:12.5px;word-break:break-word">${dtEscape(String(val))}</div></div>`;
  const fields = [
    ['Type', o.return_type], ['Status', o.status], ['Return date', dt(o.return_date)], ['Confirmed', dt(o.return_confirmdate)], ['Closed', dt(o.return_closedate)],
    ['Return amount', money(o.return_amount)], ['Order no', o.eretail_order_no], ['Order type', o.order_type], ['Channel', o.channel_name],
    ['Return location', o.return_location_name], ['Invoice', o.invoice_no], ['Delivery', o.delivery_no], ['Tracking', o.tracking_no], ['Return tracking', o.return_tracking_no],
    ['Refund status', o.refund_status], ['Refund date', dt(o.refund_date)], ['Credit note', o.credit_note_no],
    ['Customer', o.customer_name], ['Phone', o.customer_phone], ['Email', o.customer_email], ['Address', o.customer_address], ['City', o.customer_city], ['State', o.customer_state], ['Pincode', o.customer_pincode],
    ['Remarks', o.remarks], ['Refund remarks', o.refund_remarks], ['Ext return no', o.ext_return_no], ['Ext invoice', o.ext_invoice_no],
  ];
  const items = d.items || [];
  const itemsHtml = items.length ? `<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);margin:16px 0 6px">Items (${items.length})</div>
    <div class="table-container"><table><thead><tr><th>SKU</th><th>Product</th><th style="text-align:right">Ret qty</th><th style="text-align:right">Price</th><th>Reason</th></tr></thead>
    <tbody>${items.map(it => `<tr><td style="font-family:var(--font-mono);font-size:11px;white-space:nowrap">${dtEscape(it.sku || '')}</td><td>${dtEscape(it.sku_name || '')}</td><td style="text-align:right">${Number(it.return_qty)}</td><td style="text-align:right">${inr(it.unit_price)}</td><td>${dtEscape(it.return_reason || '')}</td></tr>`).join('')}</tbody></table></div>` : '';
  const rawHtml = d.raw ? `<details style="margin-top:16px"><summary style="cursor:pointer;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground)">All fields (${Object.keys(d.raw).length})</summary><div style="margin-top:8px">${Object.entries(d.raw).filter(([, v]) => v != null && v !== '' && typeof v !== 'object').map(([k, v]) => row(k, String(v))).join('')}</div></details>` : '';
  bodyEl.innerHTML = `<div>${fields.map(f => row(f[0], f[1])).join('')}</div>${itemsHtml}${rawHtml}`;
}

async function api(url,method='GET',body=null) {
  const token = localStorage.getItem('authToken');
  const opts={method, headers:{'Content-Type':'application/json'}, credentials:'include'};
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body) opts.body=JSON.stringify(body);
  const r=await fetch(url,opts);
  if (r.status===401) {
    localStorage.removeItem('authToken');
    window.location.replace('/');
    return {};
  }
  try {
    const data = await r.json();
    return data;
  } catch(e) {
    console.error('API error:', url, r.status, e);
    return { error: `HTTP ${r.status}` };
  }
}

function closeModal(id) { dismissModal(document.getElementById(id)); }

// Single exit path for every dialog, so ×, Esc and Cancel all behave alike.
function dismissModal(ov) {
  if (!ov) return;
  ov.classList.remove('open');
  // A password left revealed shouldn't still be readable the next time the
  // dialog opens — put any toggled field back to masked on the way out.
  ov.querySelectorAll('input[type="text"][data-pw-toggle]').forEach(inp => {
    inp.type = 'password';
    const b = inp.parentNode.querySelector('.pw-toggle');
    if (b) { b.classList.remove('is-on'); b.setAttribute('aria-pressed','false'); b.setAttribute('aria-label','Show password'); }
  });
}

// Modals close only via Cancel/Close/Esc — not by clicking outside, so a stray
// click can't wipe out a half-filled form.
// document.querySelectorAll('.modal-overlay').forEach(m=>{
//   m.addEventListener('click',e=>{ if(e.target===m) m.classList.remove('open'); });
// });

// ══════════════════════════════════════════════════════
// DIALOG AFFORDANCES — close button, Esc, password reveal
// Injected at runtime instead of hand-added to all 21 dialogs, so the markup
// stays clean and any dialog added later gets the same behaviour for free.
// ══════════════════════════════════════════════════════
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_EYE = '<svg class="pw-icon-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF = '<svg class="pw-icon-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function initModalCloseButtons() {
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    const modal = ov.querySelector('.modal');
    if (!modal || modal.querySelector('.modal-close')) return;
    const bar = document.createElement('div');
    bar.className = 'modal-close-bar';
    const btn = document.createElement('button');
    btn.type = 'button';                    // not "submit" — some sit inside forms
    btn.className = 'modal-close';
    btn.setAttribute('aria-label', 'Close');
    btn.innerHTML = ICON_X;
    btn.addEventListener('click', () => dismissModal(ov));
    bar.appendChild(btn);
    modal.prepend(bar);
  });
}

function initPasswordToggles(root) {
  (root || document).querySelectorAll('input[type="password"]').forEach(inp => {
    if (inp.dataset.pwToggle) return;       // already wired
    inp.dataset.pwToggle = '1';
    const wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    inp.parentNode.insertBefore(wrap, inp); // wrap in place — the input node itself
    wrap.appendChild(inp);                  // is kept, so getElementById still works
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.setAttribute('aria-label', 'Show password');
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = ICON_EYE + ICON_EYE_OFF;
    btn.addEventListener('click', ev => {
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.classList.toggle('is-on', show);
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      // Mouse click hands focus back to the field with the caret at the end.
      // Keyboard activation reports detail === 0 — there focus stays on the
      // button, else Tab users get thrown out the moment they press it.
      if (ev.detail !== 0) {
        const end = inp.value.length;
        inp.focus();
        try { inp.setSelectionRange(end, end); } catch (_) {}
      }
    });
    wrap.appendChild(btn);
  });
}

// Esc closes the top-most open dialog; with none open it closes the mobile drawer.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = document.querySelectorAll('.modal-overlay.open');
  if (open.length) { dismissModal(open[open.length - 1]); return; }
  const sb = document.getElementById('sidebar');
  if (sb && sb.classList.contains('open')) closeSidebar();
});

async function logout() {
  await fetch('/api/logout',{method:'POST', credentials:'include'});
  localStorage.removeItem('authToken');
  window.location.replace('/');
}

function showToast(msg,type='success') {
  const t=document.createElement('div');
  const bg=type==='error'?'#dc2626':'var(--foreground)';
  t.style.cssText=`position:fixed;bottom:24px;right:24px;background:${bg};color:#fff;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:500;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.2);animation:fadeIn .3s ease`;
  t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(),3000);
}

// ══════════════════════════════════════════════════════
// ── DATE FORMAT HELPER ──────────────────────────────
// Converts YYYY-MM-DD → DD-MM-YYYY for display only
function fmtDate(d) {
  if (!d) return '';
  const parts = d.split('-');
  if (parts.length !== 3) return d;
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}
// ── SET WEEK PLAN ───────────────────────────────────
async function openSetPlanModal() {
  document.getElementById('setPlanErr').style.display = 'none';
  document.getElementById('setPlanErr').textContent = '';
  document.getElementById('planEmpSelect').innerHTML = '<option value="">Select Employee</option>';
  document.getElementById('planStartDate').value = '';
  document.getElementById('planImprovementPct').value = '';
  document.getElementById('planPctPreview').textContent = '';

  // Live preview for improvement pct
  document.getElementById('planImprovementPct').oninput = function() {
    const v = parseInt(this.value);
    const preview = document.getElementById('planPctPreview');
    if (isNaN(v)) { preview.textContent = ''; return; }
    const color = v < 0 ? '#dc2626' : '#16a34a';
    const arrow = v < 0 ? '📉' : '📈';
    preview.innerHTML = `<span style="color:${color};font-weight:600">${arrow} Next week target: ${v > 0 ? '+' : ''}${v}% improvement</span>`;
  };

  // Load department employees
  const allUsers = await api('/api/users');
  const deptUsers = ME.role === 'admin'
    ? allUsers.filter(u => u.role === 'user' || u.role === 'employee')
    : allUsers.filter(u => u.department === ME.department && u.id !== ME.id);
  deptUsers.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = u.name + ' (' + u.email + ')';
    document.getElementById('planEmpSelect').appendChild(opt);
  });

  document.getElementById('setPlanModal').classList.add('open');
}

async function saveWeekPlan() {
  const empId = document.getElementById('planEmpSelect').value;
  const startDate = document.getElementById('planStartDate').value;
  const improvementPct = document.getElementById('planImprovementPct').value;
  const err = document.getElementById('setPlanErr');
  err.style.display = 'none';

  if (!empId) { err.textContent = 'Please select an employee'; err.style.display = 'block'; return; }
  if (!startDate) { err.textContent = 'Please select start date of week'; err.style.display = 'block'; return; }

  const payload = {
    employeeId: parseInt(empId),
    startDate,
    targetCount: 0,
    hodId: ME.id
  };
  if (improvementPct !== '' && !isNaN(parseInt(improvementPct))) {
    payload.improvementPct = parseInt(improvementPct);
  }

  const res = await api('/api/week-plan', 'POST', payload);

  if (res.error) { err.textContent = res.error; err.style.display = 'block'; return; }
  closeModal('setPlanModal');
  showToast('✅ Week plan saved successfully!');
}



// MIS REPORT
// ══════════════════════════════════════════════════════
let misType = 'delegation';
let misData = {};
let misFMSData = [];
let misAllData = [];

function switchMisTab(type, el) {
  misType = type;
  document.querySelectorAll('#page-mis .tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  if (type === 'fms') {
    if (misFMSData.length) renderFMSMIS(misFMSData);
    else document.getElementById('misResults').innerHTML = `<div class="empty" style="background:var(--card);border-radius:var(--radius);border:1px solid var(--border);box-shadow:var(--shadow-xs);">Click Generate to load FMS MIS</div>`;
  } else if (type === 'all') {
    if (misAllData.length) renderAllMIS(misAllData, misFMSData);
    else document.getElementById('misResults').innerHTML = `<div class="empty" style="background:var(--card);border-radius:var(--radius);border:1px solid var(--border);box-shadow:var(--shadow-xs);">Click Generate to load All MIS</div>`;
  } else {
    if (Object.keys(misData).length) renderMIS(misData);
  }
}

async function generateMIS() {
  const start = document.getElementById('misStart').value;
  const end   = document.getElementById('misEnd').value;
  if (!start || !end) { showToast('Please select start and end date','error'); return; }
  if (start > end) { showToast('Start date must be before end date','error'); return; }

  document.getElementById('misResults').innerHTML = `<div class="empty" style="background:var(--card);border-radius:var(--radius);border:1px solid var(--border);box-shadow:var(--shadow-xs);">Loading…</div>`;

  if (misType === 'fms') {
    const data = await api(`/api/mis/fms?start=${start}&end=${end}`);
    if (data.error) { showToast(data.error,'error'); return; }
    misFMSData = data;
    renderFMSMIS(data);
  } else if (misType === 'all') {
    document.getElementById('misResults').innerHTML = `<div class="empty" style="background:var(--card);border-radius:var(--radius);border:1px solid var(--border);box-shadow:var(--shadow-xs);">Loading…</div>`;
    const [data, fmsData] = await Promise.all([
      api(`/api/mis/all?start=${start}&end=${end}`),
      api(`/api/mis/fms?start=${start}&end=${end}`)
    ]);
    if (data.error) { showToast(data.error,'error'); return; }
    misAllData = data;
    misFMSData = Array.isArray(fmsData) ? fmsData : [];
    renderAllMIS(data, misFMSData);
  } else {
    const data = await api(`/api/mis?start=${start}&end=${end}`);
    if (data.error) { showToast(data.error,'error'); return; }
    misData = data;
    renderMIS(data);
  }
}

function renderMIS(data) {
  const container = document.getElementById('misResults');
  const key = misType === 'delegation' ? 'delegation' : 'checklist';
  const rows = data[key] || [];

  if (!rows.length) {
    container.innerHTML = `<div class="empty" style="background:var(--card);border-radius:var(--radius);border:1px solid var(--border);box-shadow:var(--shadow-xs);">No data found for this date range</div>`;
    return;
  }

  const tableRows = rows.map((r,i) => {
    const score = parseFloat(r.score);
    const scoreClass = score === 0 ? 'score-zero' : score < 0 ? 'score-negative' : 'score-positive';
    const barWidth = Math.abs(score);
    const barColor = score === 0 ? 'var(--faint)' : score < 0 ? '#ef4444' : '#10b981';
    const scoreLabel = score === 0 ? '✅ Perfect' : score < 0 ? '⚠️ Needs Improvement' : '✅ Good';

    return `<tr style="cursor:pointer" onclick="openMISDetail('${r.userId||r.id}','${r.name}')" title="Click to see task details">
      <td>
        <span style="font-weight:600;color:var(--brand-deep);text-decoration:underline dotted">${r.name}</span>
      </td>
      <td style="font-weight:700">${r.total}</td>
      <td style="color:#ef4444;font-weight:600">${r.pending}</td>
      <td style="color:#10b981;font-weight:600">${r.completed}</td>
      ${misType==='delegation' ? `<td style="color:#f59e0b;font-weight:600">${r.revised||0}</td>` : ''}
      <td style="color:#dc2626;font-weight:600">${r.delayed||0}</td>
      <td>
        <div class="${scoreClass}" style="font-size:14px;font-weight:700">${score.toFixed(1)}%</div>
        <div style="font-size:10px;color:var(--faint);margin-top:1px">${scoreLabel}</div>
        <div class="mis-score-bar">
          <div class="mis-score-fill" style="width:${barWidth}%;background:${barColor}"></div>
        </div>
      </td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="mis-table-wrap">
      <table>
        <thead><tr>
          <th>Name <span style="font-weight:400;color:var(--faint);font-size:10px">(click for details)</span></th>
          <th>Total</th><th>Pending</th><th>Completed</th>${misType==='delegation'?'<th>Revised</th>':''}<th>Delayed</th><th>Score %</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div style="font-size:12px;color:var(--faint);margin-top:10px;padding:0 4px">
      * Score: 0% = All completed | Negative = Pending/delayed tasks reduce score
    </div>`;
}

// Open MIS detail modal for a user
async function openMISDetail(userId, userName) {
  const key = misType === 'delegation' ? 'delegation' : 'checklist';
  // Find row by userId
  const row = (misData[key] || []).find(r => String(r.userId||r.id) === String(userId));
  if (!row) { showToast('Data not found, please Generate again', 'error'); return; }

  const start = document.getElementById('misStart').value;
  const end   = document.getElementById('misEnd').value;

  const data = await api(`/api/mis/detail?userId=${userId}&type=${misType}&start=${start}&end=${end}`);

  const score = parseFloat(row.score);
  const scoreColor = score === 0 ? 'var(--muted-foreground)' : score < 0 ? '#dc2626' : '#16a34a';

  let scoreReason = '';
  if (score === 0) scoreReason = '✅ All tasks completed on time — perfect score!';
  else {
    const parts = [];
    if (parseInt(row.pending) > 0) parts.push(`${row.pending} task(s) still pending`);
    if (parseInt(row.delayed) > 0) parts.push(`${row.delayed} task(s) past due date`);
    if (parseInt(row.revised) > 0) parts.push(`${row.revised} task(s) revised/rejected`);
    scoreReason = '⚠️ Score reduced because: ' + parts.join(', ');
  }

  const taskRows = (data.tasks||[]).map(t => `
    <tr>
      <td>${t.description}</td>
      <td style="color:var(--muted-foreground);font-size:12px">${t.assigned_by_name||'—'}</td>
      <td style="white-space:nowrap;font-size:12px">${fmtDate(t.due_date)}</td>
      <td><span class="status-badge ${t.status}">${t.status==='revised'?'Revision Requested':t.status.charAt(0).toUpperCase()+t.status.slice(1)}</span></td>
      ${(t.status==='pending'||t.status==='revised') && t.due_date < new Date().toISOString().split('T')[0]
        ? `<td style="color:#dc2626;font-size:11px;font-weight:600">⏰ Overdue</td>`
        : `<td></td>`}
    </tr>`).join('');

  document.getElementById('misDetailTitle').textContent = `${row.name} — ${misType === 'delegation' ? 'Delegation' : 'Checklist'} Tasks`;
  document.getElementById('misDetailScore').innerHTML = `
    <div style="font-size:28px;font-weight:800;color:${scoreColor}">${score.toFixed(1)}%</div>
    <div style="font-size:13px;color:var(--muted-foreground);margin-top:4px">${scoreReason}</div>
    <div style="display:flex;gap:16px;margin-top:12px;font-size:13px;flex-wrap:wrap">
      <span>📋 Total: <strong>${row.total}</strong></span>
      <span style="color:#10b981">✅ Done: <strong>${row.completed}</strong></span>
      <span style="color:#ef4444">⏳ Pending: <strong>${row.pending}</strong></span>
      <span style="color:#dc2626">⏰ Delayed: <strong>${row.delayed||0}</strong></span>
      ${misType==='delegation'?`<span style="color:#f59e0b">🔄 Revised: <strong>${row.revised||0}</strong></span>`:''}
    </div>`;
  document.getElementById('misDetailBody').innerHTML = taskRows || `<tr><td colspan="5" class="empty">No tasks found</td></tr>`;
  document.getElementById('misDetailModal').classList.add('open');
}

function exportMIS() {
  if (misType === 'fms') {
    if (!misFMSData || !misFMSData.length) { showToast('Generate FMS report first','error'); return; }
    const rows = [];
    misFMSData.forEach(fms => {
      rows.push([fms.fmsName, 'Total', fms.total, fms.pending, fms.done]);
      (fms.steps||[]).forEach(s => rows.push([fms.fmsName, s.stepName, s.total, s.pending, s.done]));
    });
    const csv = ['FMS Name,Step,Total,Pending,Done', ...rows.map(r=>r.join(','))].join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
    a.download = `FMS_MIS_${document.getElementById('misStart').value}_to_${document.getElementById('misEnd').value}.csv`;
    a.click();
    showToast('CSV exported!');
    return;
  }
  if (misType === 'all') {
    const lines = ['Type,Name,Total,Pending,Completed,Revised,Delayed,Score%'];
    ['delegation','checklist'].forEach(type => {
      (misData[type]||[]).forEach(r => lines.push(`${type},${r.name},${r.total},${r.pending},${r.completed},${r.revised||0},${r.delayed||0},${r.score}%`));
    });
    (misFMSData||[]).forEach(fms => {
      lines.push(`fms,${fms.fmsName},${fms.total},${fms.pending},${fms.done},0,0,—`);
    });
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(lines.join('\n'));
    a.download = `All_MIS_${document.getElementById('misStart').value}_to_${document.getElementById('misEnd').value}.csv`;
    a.click();
    showToast('CSV exported!');
    return;
  }
  if (!misData || !misData[misType]?.length) { showToast('Generate report first','error'); return; }
  const rows = misData[misType];
  const csv = ['Name,Total,Pending,Completed,Revised,Delayed,Score%',
    ...rows.map(r=>`${r.name},${r.total},${r.pending},${r.completed},${r.revised},${r.delayed},${r.score}%`)
  ].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = `MIS_${misType}_${document.getElementById('misStart').value}_to_${document.getElementById('misEnd').value}.csv`;
  a.click();
  showToast('CSV exported!');
}

function renderFMSMIS(data) {
  const container = document.getElementById('misResults');
  if (!data || !data.length) {
    container.innerHTML = `<div class="empty" style="background:var(--card);border-radius:var(--radius);border:1px solid var(--border);box-shadow:var(--shadow-xs);">No FMS data found</div>`;
    return;
  }
  const sections = data.map(fms => {
    const hasError = fms.error;
    const fmsScore = parseFloat(fms.score)||0;
    const fmsScoreClass = fmsScore === 0 ? 'score-zero' : fmsScore < 0 ? 'score-negative' : 'score-positive';
    const stepRows = (fms.steps||[]).map(s => {
      const score = parseFloat(s.score)||0;
      const scoreClass = score === 0 ? 'score-zero' : score < 0 ? 'score-negative' : 'score-positive';
      const barWidth = Math.min(Math.abs(score), 100);
      const barColor = score === 0 ? 'var(--faint)' : score < 0 ? '#ef4444' : '#10b981';
      return `
      <tr>
        <td style="padding-left:24px;color:var(--muted-foreground);font-size:12px">Step ${s.stepOrder}: ${s.stepName}</td>
        <td style="font-size:12px;color:var(--muted-foreground)">${s.doers}</td>
        <td style="font-weight:600;color:var(--brand-deep)">${s.total}</td>
        <td style="color:#ef4444;font-weight:600">${s.pending}</td>
        <td style="color:#10b981;font-weight:600">${s.done}</td>
        <td style="color:#f59e0b;font-weight:600">${s.delayed||0}</td>
        <td>
          ${s.total > 0 ? `
          <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;width:80px">
            <div style="height:100%;background:#10b981;border-radius:3px;width:${Math.round((s.done/s.total)*100)}%"></div>
          </div>
          <div style="font-size:11px;color:var(--muted-foreground);margin-top:2px">${Math.round((s.done/s.total)*100)}% done</div>` : '—'}
        </td>
        <td>
          ${s.total > 0 ? `
          <div class="${scoreClass}" style="font-size:13px;font-weight:700">${score.toFixed(1)}%</div>
          <div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden;width:70px;margin-top:2px">
            <div style="height:100%;background:${barColor};border-radius:2px;width:${barWidth}%"></div>
          </div>` : '—'}
        </td>
      </tr>`;
    }).join('');

    return `
      <div class="mis-table-wrap" style="margin-bottom:16px">
        <div style="background:var(--muted);padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div style="font-size:14px;font-weight:700;color:var(--foreground)">📊 ${fms.fmsName}</div>
          <div style="display:flex;gap:16px;font-size:13px;align-items:center">
            <span>Total: <strong style="color:var(--brand-deep)">${fms.total}</strong></span>
            <span>Pending: <strong style="color:#ef4444">${fms.pending}</strong></span>
            <span>Done: <strong style="color:#10b981">${fms.done}</strong></span>
            <span>Delayed: <strong style="color:#f59e0b">${fms.delayed||0}</strong></span>
            <span>Score: <strong class="${fmsScoreClass}">${fmsScore.toFixed(1)}%</strong></span>
            ${hasError ? `<span style="color:#dc2626;font-size:11px">⚠️ ${fms.error}</span>` : ''}
          </div>
        </div>
        <table>
          <thead><tr><th>Step</th><th>Doer(s)</th><th>Total</th><th>Pending</th><th>Done</th><th>Delayed</th><th>Progress</th><th>Score</th></tr></thead>
          <tbody>${stepRows || `<tr><td colspan="8" class="empty">No step data</td></tr>`}</tbody>
        </table>
      </div>`;
  }).join('');

  container.innerHTML = sections + `
    <div style="font-size:12px;color:var(--faint);margin-top:10px;padding:0 4px">
      * Score: 0% = All done on time | Negative = Pending/delayed steps reduce score
    </div>`;
  return;
}

function renderAllMIS(data, fmsData) {
  const container = document.getElementById('misResults');
  if (!data || !data.length) {
    container.innerHTML = `<div class="empty" style="background:var(--card);border-radius:var(--radius);border:1px solid var(--border);box-shadow:var(--shadow-xs);">No data found for this date range. Click Generate.</div>`;
    return;
  }

  const tableRows = data.map(emp => {
    const score = emp.overallScore;
    const scoreClass = score === null ? 'score-zero' : score === 0 ? 'score-zero' : score < 0 ? 'score-negative' : 'score-positive';
    const scoreDisplay = score === null ? '—' : `${score > 0 ? '+' : ''}${score.toFixed(1)}%`;
    const barColor = score === null ? 'var(--faint)' : score < 0 ? '#ef4444' : '#10b981';
    const barWidth = score === null ? 0 : Math.min(Math.abs(score), 100);
    const scoreLabel = score === null ? '—' : score === 0 ? '✅ Perfect' : score < 0 ? '⚠️ Needs Work' : '✅ Good';

    const delScore = emp.delegation.score;
    const chlScore = emp.checklist.score;
    const fmsObj = emp.fms || { total: 0, pending: 0, done: 0, delayed: 0, score: null };
    const completedAll = (emp.delegation.completed||0) + (emp.checklist.completed||0) + (fmsObj.done||0);

    // Mini breakdown badges — Delegation, Checklist, FMS sab
    const delBadge = emp.delegation.total > 0
      ? `<span style="font-size:10px;padding:1px 7px;border-radius:8px;background:${delScore<0?'#fef2f2':'#f0fdf4'};color:${delScore<0?'#dc2626':'#16a34a'};font-weight:600;border:1px solid ${delScore<0?'#fecaca':'#bbf7d0'}">Del: ${delScore>0?'+':''}${delScore.toFixed(0)}%</span>` : '';
    const chlBadge = emp.checklist.total > 0
      ? `<span style="font-size:10px;padding:1px 7px;border-radius:8px;background:${chlScore<0?'#fef2f2':'#f0fdf4'};color:${chlScore<0?'#dc2626':'#16a34a'};font-weight:600;border:1px solid ${chlScore<0?'#fecaca':'#bbf7d0'}">CL: ${chlScore>0?'+':''}${chlScore.toFixed(0)}%</span>` : '';
    const fmsBadge = (fmsObj.total > 0 && fmsObj.score !== null)
      ? `<span title="${fmsObj.delayed||0} delayed task(s)" style="font-size:10px;padding:1px 7px;border-radius:8px;background:${fmsObj.score<0?'#fef2f2':'#f0fdf4'};color:${fmsObj.score<0?'#dc2626':'#16a34a'};font-weight:600;border:1px solid ${fmsObj.score<0?'#fecaca':'#bbf7d0'}">FMS: ${fmsObj.score>0?'+':''}${fmsObj.score.toFixed(0)}%${fmsObj.delayed?` ⏱${fmsObj.delayed}`:''}</span>` : '';

    // Next Week Plan column
    let planHtml = '<span style="color:var(--faint);font-size:12px">—</span>';
    if (emp.plan) {
      const weekDate = fmtDate(emp.plan.start_date);

      let improvBadge = '<span style="font-size:11px;color:var(--faint)">No improvement goal set</span>';
      if (emp.plan.improvement_pct !== null && emp.plan.improvement_pct !== undefined) {
        const ip = emp.plan.improvement_pct;
        const ipColor = ip < 0 ? '#dc2626' : '#16a34a';
        const ipBg = ip < 0 ? '#fef2f2' : '#f0fdf4';
        const ipBorder = ip < 0 ? '#fecaca' : '#bbf7d0';
        const ipArrow = ip < 0 ? '📉' : '📈';
        improvBadge = `<span style="font-size:11px;padding:2px 8px;border-radius:8px;background:${ipBg};color:${ipColor};font-weight:700;border:1px solid ${ipBorder}">${ipArrow} ${ip > 0 ? '+' : ''}${ip}% improvement</span>`;
      }

      planHtml = `
        <div style="font-size:11px;color:var(--muted-foreground);margin-bottom:4px">📅 Week: <strong>${weekDate}</strong></div>
        <div>${improvBadge}</div>`;
    }

    return `<tr style="cursor:pointer" onclick="openAllMISDetail('${emp.userId}','${emp.name.replace(/'/g,"\\'")}')">
      <td>
        <div style="font-weight:600;color:var(--brand-deep);text-decoration:underline dotted">${emp.name}</div>
        <div style="font-size:11px;color:var(--faint);margin-top:2px">${emp.department||'—'}</div>
      </td>
      <td style="font-weight:700">${emp.totalAll}</td>
      <td style="color:#ef4444;font-weight:600">${emp.pendingAll}</td>
      <td style="color:#10b981;font-weight:600">${completedAll}</td>
      <td style="color:#f59e0b;font-weight:600">${emp.revisedAll}</td>
      <td style="color:#dc2626;font-weight:600">${emp.overdueAll}</td>
      <td>${planHtml}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px">${delBadge}${chlBadge}${fmsBadge}</div>
        <div class="${scoreClass}" style="font-size:15px;font-weight:800">${scoreDisplay}</div>
        <div style="font-size:10px;color:var(--faint)">${scoreLabel}</div>
        <div class="mis-score-bar" style="margin-top:3px">
          <div class="mis-score-fill" style="width:${barWidth}%;background:${barColor}"></div>
        </div>
      </td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="mis-table-wrap" style="overflow-x:auto">
      <table style="min-width:900px">
        <thead><tr>
          <th>Employee <span style="font-weight:400;color:var(--faint);font-size:10px">(click for breakdown)</span></th>
          <th>Total</th><th>Pending</th><th>Completed</th><th>Revised</th><th>Delayed</th>
          <th>📅 Next Week Plan</th><th>Overall Score</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div style="font-size:12px;color:var(--faint);margin-top:10px;padding:0 4px">
      * Score combines Delegation + Checklist + FMS. Click employee name to see full breakdown.
    </div>`;

  // Append FMS section if data exists
  if (fmsData && fmsData.length) {
    const fmsRows = fmsData.map(f => {
      const pct = f.total > 0 ? Math.round((f.done/f.total)*100) : 0;
      const barColor = pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
      return `<tr>
        <td style="font-weight:600;color:var(--foreground)">${f.fmsName}</td>
        <td style="font-weight:700">${f.total}</td>
        <td style="color:#ef4444;font-weight:600">${f.pending}</td>
        <td style="color:#10b981;font-weight:600">${f.done}</td>
        <td>
          <div style="font-size:13px;font-weight:700;color:${barColor}">${pct}%</div>
          <div style="height:5px;border-radius:3px;background:var(--border);margin-top:3px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${barColor};border-radius:3px"></div>
          </div>
        </td>
      </tr>`;
    }).join('');

    container.innerHTML += `
      <div style="margin-top:18px">
        <div style="font-size:13px;font-weight:700;color:var(--foreground);margin-bottom:8px">📊 FMS Overview</div>
        <div class="mis-table-wrap">
          <table>
            <thead><tr>
              <th>FMS Name</th><th>Total</th><th>Pending</th><th>Done</th><th>Completion %</th>
            </tr></thead>
            <tbody>${fmsRows}</tbody>
          </table>
        </div>
      </div>`;
  }
}

// Open All MIS detail modal for employee
async function openAllMISDetail(userId, userName) {
  const emp = (misAllData || []).find(e => String(e.userId) === String(userId));
  if (!emp) { showToast('Generate report first', 'error'); return; }

  const start = document.getElementById('misStart').value;
  const end   = document.getElementById('misEnd').value;

  // Fetch task details for both types
  const [delDetail, chlDetail] = await Promise.all([
    emp.delegation.total > 0 ? api(`/api/mis/detail?userId=${userId}&type=delegation&start=${start}&end=${end}`) : Promise.resolve({ tasks: [] }),
    emp.checklist.total > 0  ? api(`/api/mis/detail?userId=${userId}&type=checklist&start=${start}&end=${end}`)  : Promise.resolve({ tasks: [] })
  ]);

  const today = new Date().toISOString().split('T')[0];

  const makeTaskRows = (tasks, showRevised) => tasks.map(t => `
    <tr>
      <td style="font-size:12px">${t.description}</td>
      <td style="color:var(--muted-foreground);font-size:11px;white-space:nowrap">${fmtDate(t.due_date)}</td>
      <td><span class="status-badge ${t.status}">${t.status === 'revised' ? 'Revision' : t.status.charAt(0).toUpperCase()+t.status.slice(1)}</span></td>
      <td>${(t.status==='pending'||t.status==='revised') && t.due_date < today ? '<span style="font-size:10px;color:#dc2626;font-weight:600">⏰ Overdue</span>' : ''}</td>
    </tr>`).join('') || `<tr><td colspan="4" class="empty" style="font-size:12px">No tasks</td></tr>`;

  const score = emp.overallScore;
  const scoreColor = score === null ? 'var(--muted-foreground)' : score < 0 ? '#dc2626' : '#16a34a';

  document.getElementById('misDetailTitle').textContent = `${userName} — All Tasks`;
  const fms = emp.fms || { total: 0, pending: 0, done: 0, score: null };
  const completedTotal = (emp.delegation.completed||0) + (emp.checklist.completed||0) + (fms.done||0);
  document.getElementById('misDetailScore').innerHTML = `
    <div style="font-size:28px;font-weight:800;color:${scoreColor}">${score !== null ? (score>0?'+':'')+ score.toFixed(1)+'%' : '—'}</div>
    <div style="display:flex;gap:16px;margin-top:10px;font-size:13px;flex-wrap:wrap">
      <span>📋 Total: <strong>${emp.totalAll}</strong></span>
      <span style="color:#10b981">✅ Done: <strong>${completedTotal}</strong></span>
      <span style="color:#ef4444">⏳ Pending: <strong>${emp.pendingAll}</strong></span>
      <span style="color:#dc2626">⏰ Delayed: <strong>${emp.overdueAll}</strong></span>
      <span style="color:#f59e0b">🔄 Revised: <strong>${emp.revisedAll}</strong></span>
    </div>

    ${emp.delegation.total > 0 ? `
    <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px">
      <div style="font-size:13px;font-weight:700;color:#1d4ed8;margin-bottom:8px">📋 Delegation (${emp.delegation.total} tasks) — Score: ${emp.delegation.score > 0 ? '+' : ''}${emp.delegation.score.toFixed(1)}%</div>
      <div style="overflow-x:auto">
        <table style="font-size:12px">
          <thead><tr><th>Task</th><th>Date</th><th>Status</th><th></th></tr></thead>
          <tbody>${makeTaskRows(delDetail.tasks || [], true)}</tbody>
        </table>
      </div>
    </div>` : ''}

    ${emp.checklist.total > 0 ? `
    <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px">
      <div style="font-size:13px;font-weight:700;color:#16a34a;margin-bottom:8px">✅ Checklist (${emp.checklist.total} tasks) — Score: ${emp.checklist.score > 0 ? '+' : ''}${emp.checklist.score.toFixed(1)}%</div>
      <div style="overflow-x:auto">
        <table style="font-size:12px">
          <thead><tr><th>Task</th><th>Date</th><th>Status</th><th></th></tr></thead>
          <tbody>${makeTaskRows(chlDetail.tasks || [], false)}</tbody>
        </table>
      </div>
    </div>` : ''}

    ${fms.total > 0 ? `
    <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px">
      <div style="font-size:13px;font-weight:700;color:#7c3aed;margin-bottom:8px">📊 FMS (${fms.total} entries) — Score: ${fms.score !== null ? (fms.score>0?'+':'')+fms.score.toFixed(1) : 0}%</div>
      <div style="display:flex;gap:14px;font-size:12px;flex-wrap:wrap;padding:8px 10px;background:#faf5ff;border-radius:8px">
        <span>Total entries: <strong>${fms.total}</strong></span>
        <span style="color:#10b981">Done: <strong>${fms.done}</strong></span>
        <span style="color:#ef4444">Pending: <strong>${fms.pending}</strong></span>
        <span style="color:#f59e0b">Delayed: <strong>${fms.delayed||0}</strong></span>
        <span style="color:var(--muted-foreground)">Completion: <strong>${Math.round((fms.done/fms.total)*100)}%</strong></span>
      </div>
    </div>` : ''}`;

  // Reuse existing misDetailBody (blank it since we put everything in score div)
  document.getElementById('misDetailBody').innerHTML = '';
  document.getElementById('misDetailModal').classList.add('open');
}

// Set default MIS dates (current week)
function setDefaultMISDates() {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - today.getDay() + 1);
  document.getElementById('misStart').value = monday.toISOString().split('T')[0];
  document.getElementById('misEnd').value = today.toISOString().split('T')[0];
}

// ══════════════════════════════════════════════════════
// FMS ADMIN
// ══════════════════════════════════════════════════════
let fmsData = { fmsName:'', sheetName:'', sheetId:'', headerRow:1, totalSteps:1 };
let fmsSteps = [];
let fmsDeleteMode = false;
let fmsDupMode = false;
let fmsAllSheets = [];
let fmsActiveId = null;
let fmsActiveStep = 0;
let fmsAllUsers = [];
let fmsSheetHeaders = [];

async function loadFMSAdmin() {
  const usersRes = await api('/api/users');
  fmsAllUsers = Array.isArray(usersRes) ? usersRes : [];
  const sheets = await api('/api/fms');
  fmsAllSheets = sheets;

  const tabsEl = document.getElementById('fmsListTabs');
  const emptyEl = document.getElementById('fmsEmpty');
  const detailEl = document.getElementById('fmsDetailView');

  if (!sheets.length) {
    tabsEl.innerHTML = '';
    emptyEl.style.display = 'block';
    detailEl.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  // ✅ Use fms_name if available, else sheet_name
  tabsEl.innerHTML = sheets.map(s => `
    <div class="fms-name-tab ${fmsActiveId===s.id?'active':''}" onclick="loadFMSDetail(${s.id})">${s.fms_name||s.sheet_name}</div>
  `).join('');

  if (!fmsActiveId && sheets.length) loadFMSDetail(sheets[0].id);
  else if (fmsActiveId) loadFMSDetail(fmsActiveId);
}

async function loadFMSDetail(id) {
  fmsActiveId = id;
  const sheet_data = fmsAllSheets.find(s=>s.id===id);
  document.querySelectorAll('.fms-name-tab').forEach(t => {
    t.classList.toggle('active', sheet_data && t.textContent.trim() === (sheet_data.fms_name||sheet_data.sheet_name));
  });

  const data = await api(`/api/fms/${id}`);
  const { sheet, steps } = data;
  document.getElementById('fmsDetailView').style.display = 'block';
  document.getElementById('fmsEmpty').style.display = 'none';

  // Sheet info bar
  document.getElementById('fmsSheetInfoText').innerHTML =
    `<strong>${sheet.sheet_name}</strong> &nbsp;·&nbsp; Sheet ID: <code style="background:var(--muted);padding:1px 6px;border-radius:4px;font-size:12px">${sheet.sheet_id}</code> &nbsp;·&nbsp; Header Row: ${sheet.header_row}`;

  // Step tabs
  const stepTabsEl = document.getElementById('fmsStepTabs');
  stepTabsEl.innerHTML = steps.map((s,i) => `
    <div class="fms-step-tab ${i===0?'active':''}" onclick="showFMSStep(${i})" id="fmsStepTab${i}">${s.step_name}</div>
  `).join('');

  fmsActiveStep = 0;
  showFMSStepData(steps, 0);
  document.getElementById('fmsDetailView').dataset.steps = JSON.stringify(steps);
  document.getElementById('fmsSyncResult').style.display = 'none';
}

function showFMSStep(idx) {
  fmsActiveStep = idx;
  document.querySelectorAll('.fms-step-tab').forEach((t,i) => t.classList.toggle('active', i===idx));
  const steps = JSON.parse(document.getElementById('fmsDetailView').dataset.steps || '[]');
  showFMSStepData(steps, idx);
}

function showFMSStepData(steps, idx) {
  const s = steps[idx];
  if (!s) return;
  const doerNames = (s.doers||[]).map(d=>d.name).join(', ') || '—';
  const extraRowsHtml = s.extraInput==='yes' ? `
    <div style="margin-top:12px">
      <div style="font-size:12px;font-weight:600;color:var(--muted-foreground);margin-bottom:6px">Extra Input Rows:</div>
      ${(s.extraRows||[]).map(r=>`<div style="font-size:13px;padding:4px 0;color:var(--foreground)">• ${r.row_label||'(unnamed)'}</div>`).join('')}
    </div>` : '';

  document.getElementById('fmsStepContent').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.4px">Step Name</div>
        <div style="font-size:15px;font-weight:600;color:var(--foreground);margin-top:4px">${s.step_name}</div>
      </div>
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.4px">Step Doer(s)</div>
        <div style="font-size:14px;color:var(--foreground);margin-top:4px">${doerNames}</div>
      </div>
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.4px">Plan Column</div>
        <div style="font-size:14px;color:var(--foreground);margin-top:4px">${s.plan_col||'—'} <span style="color:var(--faint);font-size:12px">(Plan ${idx+1})</span></div>
      </div>
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.4px">Actual Column</div>
        <div style="font-size:14px;color:var(--foreground);margin-top:4px">${s.actual_col||'—'} <span style="color:var(--faint);font-size:12px">(Actual ${idx+1})</span></div>
      </div>
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.4px">Extra Input</div>
        <div style="font-size:14px;color:var(--foreground);margin-top:4px">${s.extra_input==='yes'?'Yes (Col: '+s.extra_col+')':'No'}</div>
      </div>
    </div>
    ${extraRowsHtml}
    <div style="display:flex;gap:8px;margin-top:16px;border-top:1px solid var(--border);padding-top:14px">
      ${idx>0?`<button class="btn btn-outline btn-sm" onclick="showFMSStep(${idx-1})">← Prev Step</button>`:''}
      ${idx<steps.length-1?`<button class="btn btn-primary btn-sm" onclick="showFMSStep(${idx+1})">Next Step →</button>`:''}
    </div>`;
}

async function deleteFMSSheet(id) {
  if (!confirm('Delete this FMS? This cannot be undone!')) return;
  await api(`/api/fms/${id}`,'DELETE');
  fmsActiveId = null;
  document.getElementById('fmsDetailView').style.display='none';
  showToast('FMS deleted!');
  loadFMSAdmin();
}

// ── Edit FMS ──
async function openEditFMS() {
  if (!fmsActiveId) return;
  const usersRes = await api('/api/users');
  fmsAllUsers = Array.isArray(usersRes) ? usersRes : [];
  const data = await api(`/api/fms/${fmsActiveId}`);
  const { sheet, steps } = data;

  document.getElementById('editFmsFmsName').value = sheet.fms_name || sheet.sheet_name;
  document.getElementById('editFmsSheetName').value = sheet.sheet_name;
  document.getElementById('editFmsSheetId').value = sheet.sheet_id;
  document.getElementById('editFmsHeaderRow').value = sheet.header_row;
  document.getElementById('fmsEditErr').style.display='none';

  fmsSteps = steps.map(s => ({
    stepName: s.step_name,
    doers: (s.doers||[]).map(d=>parseInt(d.user_id)),
    planCol: s.plan_col||'',
    actualCol: s.actual_col||'',
    extraInput: s.extra_input||'no',
    extraCol: s.extra_col||'',
    extraRows: (s.extraRows||[]).map(r=>({col_letter:r.col_letter||'', field_type:r.field_type||'text', label:r.row_label||r.label||r.col_letter||'', dropdown_options:r.dropdown_options||'', required: r.required==null?1:(r.required?1:0)})),
    showCols: s.show_cols_parsed || [],
    delayReasonCol: s.delay_reason_col||'',
    doerNameCol: s.doer_name_col||'',
    completeCol: s.complete_col||''
  }));

  fmsDeleteMode = false;
  fmsDupMode = false;
  document.getElementById('editFmsDeleteModeBtn').textContent = '🗑 Select to Delete';
  document.getElementById('fmsConfirmDeleteBtn').style.display='none';
  const dupBtn = document.getElementById('editFmsDupModeBtn');
  const dupConfBtn = document.getElementById('editFmsDupConfirmBtn');
  if (dupBtn) dupBtn.textContent = '📋 Duplicate';
  if (dupConfBtn) dupConfBtn.style.display = 'none';

  // Open modal first — show loading
  document.getElementById('fmsEditModal').classList.add('open');
  const container = document.getElementById('fmsEditStepsContainer');
  container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--muted-foreground)">⏳ Loading headers...</div>`;

  // Fetch headers
  fmsSheetHeaders = [];
  try {
    const payload = { sheetId: sheet.sheet_id, sheetName: sheet.sheet_name, headerRow: sheet.header_row };
    console.log('Fetching headers:', payload);
    const hRes = await api('/api/fms/fetch-headers','POST', payload);
    console.log('Headers response:', hRes);
    fmsSheetHeaders = hRes.headers || [];
    if (fmsSheetHeaders.length) showToast(`✅ ${fmsSheetHeaders.length} headers loaded!`);
    else showToast(`⚠️ ${hRes.error || 'No headers found'}`, 'error');
  } catch(e) {
    console.error('Headers fetch error:', e);
    showToast('⚠️ Headers fetch failed','error');
  }

  // Render steps with or without headers
  container.innerHTML = '';
  fmsSteps.forEach((_,i) => appendFMSStepBox(i, 'fmsEditStepsContainer'));
  updateEditStepNav();
}

function updateEditStepNav() {
  const nav = document.getElementById('editFmsStepNav');
  if (!nav) return;
  nav.innerHTML = fmsSteps.map((s,i)=>`
    <div class="fms-step-tab active" onclick="scrollToStep(${i})" style="font-size:11px;padding:4px 10px">${s.stepName||'Step '+(i+1)}</div>
  `).join('');
}

function scrollToStep(idx) {
  const boxes = document.querySelectorAll('.fms-step-box');
  if (boxes[idx]) boxes[idx].scrollIntoView({behavior:'smooth', block:'center'});
}

async function saveEditFMS() {
  const fmsName    = document.getElementById('editFmsFmsName')?.value.trim() || document.getElementById('editFmsSheetName').value.trim();
  const sheetName  = document.getElementById('editFmsSheetName').value.trim();
  const sheetId    = document.getElementById('editFmsSheetId').value.trim();
  const headerRow  = parseInt(document.getElementById('editFmsHeaderRow').value)||1;
  const err = document.getElementById('fmsEditErr');
  err.style.display='none';

  if (!sheetName) { err.textContent='Sheet Tab Name required'; err.style.display='block'; return; }

  // ✅ Read latest values from DOM (same as saveFMS does)
  const boxes = document.querySelectorAll('#fmsEditStepsContainer .fms-step-box');
  boxes.forEach((box, i) => {
    if (!fmsSteps[i]) return;
    const nameInput = box.querySelector('input[type=text]');
    if (nameInput) fmsSteps[i].stepName = nameInput.value.trim() || `Step ${i+1}`;
    fmsSteps[i].step_order = i+1;
    // Flush dropdown_options and labels for all extraRows from DOM
    (fmsSteps[i].extraRows||[]).forEach((_, ri) => {
      const el = document.getElementById(`fmsDropOpt_${i}_${ri}`);
      if (el) fmsSteps[i].extraRows[ri].dropdown_options = el.value;
      const labelEl = document.getElementById(`fmsExtraLabel_${i}_${ri}`);
      if (labelEl) fmsSteps[i].extraRows[ri].label = labelEl.value;
    });
  });

  console.log('Saving steps count:', fmsSteps.length); // debug

  const r = await api(`/api/fms/${fmsActiveId}`,'PUT',{
    fmsName: fmsName || sheetName,
    sheetName, sheetId, headerRow,
    steps: fmsSteps.map(s=>({...s, showCols:s.showCols||[], delayReasonCol:s.delayReasonCol||'', doerNameCol:s.doerNameCol||s.doer_name_col||'', completeCol:s.completeCol||s.complete_col||'', extraRows:(s.extraRows||[]).map(r=>({...r,dropdown_options:r.dropdown_options||''}))}))
  });
  if (r.error) { err.textContent=r.error; err.style.display='block'; return; }

  closeModal('fmsEditModal');
  showToast('✅ FMS updated! Steps: ' + fmsSteps.length);
  fmsSheetHeaders = [];
  loadFMSAdmin();
}

// ── Sync Data ──
async function syncFMSData() {
  const syncBtn = document.querySelector('[onclick="syncFMSData()"]');
  if (syncBtn) { syncBtn.textContent='⏳ Syncing...'; syncBtn.disabled=true; }

  const r = await api(`/api/fms/${fmsActiveId}/sync`);

  if (syncBtn) { syncBtn.textContent='🔄 Sync Data'; syncBtn.disabled=false; }

  const syncEl = document.getElementById('fmsSyncResult');

  if (r.error) {
    syncEl.style.cssText='display:block;background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:16px;margin-top:14px';
    syncEl.innerHTML=`<strong style="color:#dc2626">❌ Error:</strong> <span style="color:var(--foreground)">${r.error}</span>`;
    return;
  }

  const headerBadges = r.headers.map(h=>
    `<span style="background:#eff6ff;color:#1d4ed8;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:600">${h}</span>`
  ).join(' ');

  syncEl.style.cssText='display:block;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px;margin-top:14px';
  syncEl.innerHTML=`
    <div style="font-weight:600;color:#16a34a;margin-bottom:10px;font-size:14px">✅ Sync Successful!</div>
    <div style="font-size:13px;color:var(--foreground);margin-bottom:6px">
      📊 Header Row: <strong>${r.headerRow}</strong> &nbsp;·&nbsp; Total Data Rows: <strong>${r.totalRows}</strong>
    </div>
    <div style="font-size:12px;font-weight:600;color:var(--muted-foreground);margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px">
      Headers Found (${r.headers.length}):
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:${r.sample?.length?'12px':'0'}">
      ${headerBadges}
    </div>
    ${r.sample?.length ? `
    <div style="font-size:12px;font-weight:600;color:var(--muted-foreground);margin-bottom:6px;margin-top:8px;text-transform:uppercase;letter-spacing:.4px">All Data (${r.sample.length} rows):</div>
    <div style="overflow-x:auto;max-height:300px;overflow-y:auto">
      <table style="font-size:12px;border-collapse:collapse;width:100%">
        <thead><tr>${r.headers.map(h=>`<th style="padding:4px 8px;background:#e8f5e9;border:1px solid #bbf7d0;text-align:left;font-weight:600;white-space:nowrap">${h}</th>`).join('')}</tr></thead>
        <tbody>${r.sample.map(row=>`<tr>${r.headers.map((_,ci)=>`<td style="padding:4px 8px;border:1px solid var(--border);color:var(--foreground);white-space:nowrap">${row[ci]||'—'}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>` : ''}
  `;
}

// ── Add New FMS Flow ──
function openAddFMS() {
  document.getElementById('fmsFmsName').value='';
  document.getElementById('fmsSheetName').value='';
  document.getElementById('fmsSheetId').value='';
  document.getElementById('fmsHeaderRow').value='1';
  document.getElementById('fmsTotalSteps').value='1';
  document.getElementById('fmsAddErr').style.display='none';
  fmsActiveId = null; // ✅ Reset so saveFMS doesn't PUT on wrong ID
  document.getElementById('fmsAddModal').classList.add('open');
}

function proceedToShareNotice() {
  const fmsName = document.getElementById('fmsFmsName').value.trim();
  const name = document.getElementById('fmsSheetName').value.trim();
  const id   = document.getElementById('fmsSheetId').value.trim();
  const err  = document.getElementById('fmsAddErr');
  if (!fmsName) { err.textContent='FMS Name required'; err.style.display='block'; return; }
  if (!name) { err.textContent='Sheet Tab Name required'; err.style.display='block'; return; }
  if (!id)   { err.textContent='Sheet ID required'; err.style.display='block'; return; }

  fmsData = {
    fmsName,
    sheetName: name,
    sheetId: id,
    headerRow: parseInt(document.getElementById('fmsHeaderRow').value)||1,
    totalSteps: parseInt(document.getElementById('fmsTotalSteps').value)||1
  };

  closeModal('fmsAddModal');
  startShareCountdown();
}

function startShareCountdown() {
  // Set email via JS to avoid Cloudflare masking
  const emailEl = document.getElementById('fmsShareEmail');
  if (emailEl) emailEl.textContent = 'your-service-account' + '@' + 'your-project.iam.gserviceaccount.com';

  document.getElementById('fmsShareModal').classList.add('open');
  const btn = document.getElementById('fmsSkipBtn');
  const cd  = document.getElementById('fmsCountdown');
  let sec = 7;
  btn.style.pointerEvents='none'; btn.style.opacity='.6';
  btn.innerHTML = `Skip (<span id="fmsCountdown">${sec}</span>s)`;
  const timer = setInterval(()=>{
    sec--;
    const cdEl = document.getElementById('fmsCountdown');
    if (cdEl) cdEl.textContent = sec;
    if (sec<=0) {
      clearInterval(timer);
      btn.style.pointerEvents='auto'; btn.style.opacity='1';
      btn.innerHTML = 'Skip & Continue →';
    }
  }, 1000);
}

function copyFMSEmail() {
  const email = 'your-service-account' + '@' + 'your-project.iam.gserviceaccount.com';
  navigator.clipboard.writeText(email).then(()=>showToast('Email copied!')).catch(()=>{
    const el = document.createElement('textarea');
    el.value = email; document.body.appendChild(el);
    el.select(); document.execCommand('copy');
    document.body.removeChild(el); showToast('Email copied!');
  });
}

async function proceedToStepsConfig() {
  closeModal('fmsShareModal');
  if (!fmsAllUsers.length) { const ur = await api('/api/users'); fmsAllUsers = Array.isArray(ur) ? ur : []; }

  // Build default steps
  fmsSteps = [];
  const container = document.getElementById('fmsStepsContainer');
  container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted-foreground)">⏳ Loading headers...</div>';
  for (let i=0; i<fmsData.totalSteps; i++) {
    fmsSteps.push({ stepName:`Step ${i+1}`, doers:[], planCol:'', actualCol:'', extraInput:'no', extraCol:'', extraRows:[], showCols:[], delayReasonCol:'', doerNameCol:'', completeCol:'' }); // extraRows items: {col_letter, field_type, label}
  }

  fmsDeleteMode = false;
  const addDelBtn = document.getElementById('fmsAddDeleteModeBtn');
  const addDelConfBtn = document.getElementById('fmsAddConfirmDeleteBtn');
  if (addDelBtn) addDelBtn.textContent = '🗑 Select to Delete';
  if (addDelConfBtn) addDelConfBtn.style.display='none';
  document.getElementById('fmsStepsModal').classList.add('open');

  // Read the sheet and propose the whole configuration. Everything it fills in
  // is editable right here before saving, so a wrong guess costs nothing — but
  // a silent one would, which is why the server leaves unclear fields empty.
  fmsSheetHeaders = [];
  let detection = null;
  let readError = null;
  try {
    detection = await api('/api/fms/detect-steps', 'POST', {
      sheetId: fmsData.sheetId,
      sheetName: fmsData.sheetName,
      headerRow: fmsData.headerRow
    });
    // api() resolves with the body even on a 4xx, so an error field is the
    // failure — not just a thrown exception.
    if (detection && detection.error) { readError = detection; detection = null; }
    else fmsSheetHeaders = (detection && detection.headers) || [];
  } catch(e) {
    readError = { error: e.message || 'Request failed' };
  }

  if (!detection) {
    // Fall back to headers alone; the admin then fills the steps by hand as before.
    try {
      const hRes = await api('/api/fms/fetch-headers', 'POST', {
        sheetId: fmsData.sheetId, sheetName: fmsData.sheetName, headerRow: fmsData.headerRow
      });
      if (hRes && !hRes.error && (hRes.headers || []).length) {
        fmsSheetHeaders = hRes.headers;
        readError = null;
        showToast('⚠️ Could not auto-detect steps — headers loaded, fill the steps manually','error');
      } else if (hRes && hRes.error && !readError) {
        readError = hRes;
      }
    } catch(e2) {
      if (!readError) readError = { error: e2.message || 'Sheet could not be read' };
    }
  }

  // The server may have found the headers on a different row than the one that
  // was typed. Carry that back into the form: it is saved with the FMS, and
  // every later read of this sheet depends on it being right.
  if (detection && detection.headerRow) {
    fmsData.headerRow = detection.headerRow;
    const hrInput = document.getElementById('fmsHeaderRow');
    if (hrInput) hrInput.value = detection.headerRow;
  }

  if (detection && detection.steps && detection.steps.length) {
    fmsSteps = detection.steps.map(fmsStepFromDetection);
    fmsData.totalSteps = fmsSteps.length;
    showToast(`✅ ${fmsSteps.length} steps detected from the sheet`);
  } else if (fmsSheetHeaders.length) {
    showToast(`✅ ${fmsSheetHeaders.length} headers loaded`);
  }

  // Re-render steps with headers
  container.innerHTML = '';
  renderFMSDetectionNote(detection, readError);
  fmsSteps.forEach((_, i) => appendFMSStepBox(i, 'fmsStepsContainer'));
}

// The server's suggestion, in the shape the step boxes edit.
function fmsStepFromDetection(d) {
  return {
    stepName: d.stepName || '',
    doers: d.doers || [],
    planCol: d.planCol || '',
    actualCol: d.actualCol || '',
    extraInput: d.extraInput || 'no',
    extraCol: '',
    extraRows: (d.extraRows || []).map(r => ({
      col_letter: r.col_letter || '',
      field_type: r.field_type || 'text',
      label: r.label || '',
      dropdown_options: r.dropdown_options || '',
      required: r.required === 1 ? 1 : 0,
    })),
    showCols: d.showCols || [],
    delayReasonCol: d.delayReasonCol || '',
    doerNameCol: d.doerNameCol || '',
    completeCol: d.completeCol || '',
    _detected: true,
    _doerUnmatched: d.doerUnmatched || [],
    _doerSheetNames: d.doerSheetNames || [],
    _doerMatchedNames: (d.doerMatches || []).map(m => m.sheetName),
  };
}

// What the detector filled in, and — just as importantly — what it left out.
// A column dropped without a word is how a doer ends up typing into a cell that
// a formula overwrites an hour later.
function renderFMSDetectionNote(detection, readError) {
  const box = document.getElementById('fmsDetectNote');
  if (!box) return;

  // A sheet that cannot be read used to fail into a toast that disappeared,
  // leaving blank fields and no explanation. The reason stays on screen now.
  if (readError) {
    box.style.background = '#fef2f2';
    box.style.borderColor = '#fecaca';
    box.style.color = '#991b1b';
    box.innerHTML = `<b>The sheet could not be read.</b><div style="margin-top:6px">${dtEscape(readError.error || 'Unknown error')}</div>`
      + (readError.serviceAccount
        ? `<div style="margin-top:6px">Share the sheet with <b>${dtEscape(readError.serviceAccount)}</b> (Viewer is enough), then reopen this screen.</div>`
        : '')
      + `<div style="margin-top:6px;color:#7f1d1d">Until then the columns below are plain text boxes — you can still fill them in by hand.</div>`;
    box.style.display = 'block';
    return;
  }
  box.style.background = '#f0fdf4';
  box.style.borderColor = '#bbf7d0';
  box.style.color = '#166534';

  if (!detection || !detection.steps || !detection.steps.length) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  const skipped = detection.skipped || [];
  const unmatched = [...new Set((detection.steps || []).flatMap(s => s.doerUnmatched || []))];
  const parts = [
    `<b>${detection.steps.length} step${detection.steps.length === 1 ? '' : 's'}</b> read from the sheet — check each one before saving.`,
  ];
  if (detection.headerRowAdjusted) {
    parts.push(`<div style="margin-top:6px">Headers were found on <b>row ${detection.headerRow}</b>, not the row you entered — the form has been updated to match.</div>`);
  }
  const warnings = detection.warnings || [];
  if (warnings.length) {
    // Columns that were mapped or skipped for a reason worth seeing: a formula
    // the app would otherwise overwrite.
    const seen = new Set();
    const lines = warnings.filter(w => { const k = w.name + w.reason; if (seen.has(k)) return false; seen.add(k); return true; });
    parts.push(`<div style="margin-top:6px;color:#92400e">` +
      lines.map(w => `<div>⚠ <b>${dtEscape(w.name)}</b> — ${dtEscape(w.reason)}</div>`).join('') + `</div>`);
  }
  if (skipped.length) {
    parts.push(`<div style="margin-top:6px">Left out (the sheet fills these itself): ` +
      skipped.map(k => `<span style="background:#fff;border:1px solid var(--border);border-radius:5px;padding:1px 6px;margin-right:4px;display:inline-block">${dtEscape(k.name)} <span style="color:var(--faint)">${dtEscape(k.reason)}</span></span>`).join('') + `</div>`);
  }
  if (unmatched.length) {
    parts.push(`<div style="margin-top:6px">No user matches these names, so no doer was assigned: ` +
      unmatched.map(n => `<span style="background:#fff;border:1px solid var(--border);border-radius:5px;padding:1px 6px;margin-right:4px;display:inline-block">${dtEscape(n)}</span>`).join('') + `</div>`);
  }
  box.innerHTML = parts.join('');
  box.style.display = 'block';
}

function appendFMSStepBox(idx, containerId) {
  const cid = containerId || 'fmsStepsContainer';
  const container = document.getElementById(cid);
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'fms-step-box';
  div.dataset.idx = idx;
  div.draggable = true;
  div.innerHTML = buildStepBoxHTML(idx);
  container.appendChild(div);
  setupDragEvents(div);
  setupMultiSelect(idx);
  // Show existing doer tags
  updateFMSDoerTags(idx);
}

function buildStepBoxHTML(idx) {
  const s = fmsSteps[idx];
  const userOptions = fmsAllUsers.map(u=>`
    <div class="multi-select-item" data-uid="${u.id}" data-name="${dtEscape((u.name||'').toLowerCase())}" onclick="toggleFMSDoer(event,${idx},${u.id})">
      <input type="checkbox" ${(s.doers||[]).map(d=>parseInt(d)).includes(parseInt(u.id))?'checked':''}/> ${u.name}
    </div>`).join('');

  // The sheet named somebody this step could not be assigned to — two people
  // share the name, or nobody in the app is called that. Naming them here beats
  // a silent blank: the admin can see who was meant and pick them in one click.
  const doerLeftover = (s._doerSheetNames || []).filter(n => !(s._doerMatchedNames || []).includes(n));
  const doerHintHTML = doerLeftover.length ? `
    <div style="margin-top:5px;font-size:11px;color:var(--faint);line-height:1.5">
      Sheet says <b style="color:#92400e">${doerLeftover.map(dtEscape).join(', ')}</b> —
      ${(s.doers||[]).length ? 'not matched to a user' : 'no matching user, so nobody was assigned'}
    </div>` : '';


  // Build header options for selects — MUST be declared BEFORE extraRowsHTML
  const headers = fmsSheetHeaders || [];

  const extraRowsHTML = (s.extraRows||[]).map((r,ri)=>{
    return `<div class="extra-row-item" id="fmsExtraRow_${idx}_${ri}" style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:10px">
      ${buildExtraRowHTML(idx, ri, headers)}
    </div>`;
  }).join('');
  const blankOpt = `<option value="">-- Select Column --</option>`;
  const hdrOpts = headers.map(h=>`<option value="${h.col}" title="${h.name}">${h.name} (COL ${h.col})</option>`).join('');

  // Show cols — multi-select badges
  const showColsSelected = s.showCols || [];
  const showColsBadges = showColsSelected.map(ci=>{
    const hdr = headers[ci] || { name:`COL ${ci}`, col:'' };
    return `<span class="hdr-tag" onclick="removeFMSShowCol(${idx},${ci})">${hdr.name} <span class="rm">✕</span></span>`;
  }).join('');
  const unusedHeaders = headers.filter(h=>!showColsSelected.includes(h.index));
  const showColsOpts = `<option value="">+ Add column to show</option>`+unusedHeaders.map(h=>`<option value="${h.index}">${h.name} (COL ${h.col})</option>`).join('');

  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <div class="fms-step-num">Step ${idx+1}</div>
      ${fmsDeleteMode?`<input type="checkbox" class="fms-del-check" style="margin-left:auto" data-idx="${idx}"/>`:''}
      ${fmsDupMode?`<input type="checkbox" class="fms-dup-check" style="margin-left:auto;accent-color:#7c3aed" data-idx="${idx}"/>`:''}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="form-group" style="margin:0">
        <label>Step Name</label>
        <input type="text" value="${s.stepName||''}" placeholder="Step Name"
          oninput="fmsSteps[${idx}].stepName=this.value;updateStepNum(${idx},this.value)"
          style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:var(--font-sans);outline:none"/>
      </div>
      <div class="form-group" style="margin:0">
        <label>Step Doer(s)</label>
        <div class="multi-select-wrap" id="fmsDoerWrap_${idx}">
          <div class="selected-tags" id="fmsDoerTags_${idx}" onclick="toggleFMSDropdown(${idx})">
            <span style="color:var(--faint);font-size:12px">Select users...</span>
          </div>
          <div class="multi-select-dropdown" id="fmsDoerDrop_${idx}">
            <div class="multi-select-search">
              <input type="text" id="fmsDoerSearch_${idx}" placeholder="Search users…" autocomplete="off"
                onclick="event.stopPropagation()"
                oninput="filterFMSDoers(${idx},this.value)"
                onkeydown="fmsDoerSearchKey(event,${idx})"/>
            </div>
            <div class="multi-select-list">${userOptions}</div>
            <div class="multi-select-empty" id="fmsDoerEmpty_${idx}" style="display:none">No user by that name</div>
          </div>
        </div>
        ${doerHintHTML}
      </div>
      <div class="form-group" style="margin:0">
        <label>Plan <span style="color:var(--faint);font-weight:400;font-size:11px">(Plan ${idx+1})</span></label>
        ${headers.length ? `
        <select class="header-select" onchange="fmsSteps[${idx}].planCol=this.value">
          ${blankOpt}${headers.map(h=>`<option value="${h.col}" ${s.planCol===h.col?'selected':''}>${h.name} (COL ${h.col})</option>`).join('')}
        </select>` : `
        <input type="text" value="${s.planCol||''}" placeholder="Column e.g. I"
          oninput="fmsSteps[${idx}].planCol=this.value"
          style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:var(--font-sans);outline:none"/>`}
      </div>
      <div class="form-group" style="margin:0">
        <label>Actual <span style="color:var(--faint);font-weight:400;font-size:11px">(Actual ${idx+1})</span></label>
        ${headers.length ? `
        <select class="header-select" onchange="fmsSteps[${idx}].actualCol=this.value">
          ${blankOpt}${headers.map(h=>`<option value="${h.col}" ${s.actualCol===h.col?'selected':''}>${h.name} (COL ${h.col})</option>`).join('')}
        </select>` : `
        <input type="text" value="${s.actualCol||''}" placeholder="Column e.g. J"
          oninput="fmsSteps[${idx}].actualCol=this.value"
          style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:var(--font-sans);outline:none"/>`}
      </div>
    </div>

    <!-- Columns to show in FMS Tasks -->
    <div class="form-group" style="margin:10px 0 0">
      <label>Columns to Show in FMS Tasks <span style="color:var(--faint);font-weight:400;font-size:11px">(blank = show all)</span></label>
      ${headers.length ? `
      <div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px;border:1.5px solid var(--border);border-radius:8px;background:var(--muted);max-height:160px;overflow-y:auto">
        ${headers.map(h => `
          <label style="display:flex;align-items:center;gap:4px;font-size:11px;font-weight:500;cursor:pointer;text-transform:none;letter-spacing:0;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:3px 8px;white-space:nowrap">
            <input type="checkbox" ${showColsSelected.includes(h.index)?'checked':''}
              onchange="if(this.checked){if(!fmsSteps[${idx}].showCols.includes(${h.index}))fmsSteps[${idx}].showCols.push(${h.index})}else{fmsSteps[${idx}].showCols=fmsSteps[${idx}].showCols.filter(x=>x!==${h.index})}"
              style="accent-color:var(--brand-deep);width:12px;height:12px"/>
            ${h.name}
          </label>`).join('')}
      </div>` : '<span style="color:var(--faint);font-size:12px">Appears once the headers are loaded</span>'}
    </div>

    <!-- Delay Reason Column -->
    <div class="form-group" style="margin:10px 0 0">
      <label>Delay Reason Column <span style="color:var(--faint);font-weight:400;font-size:11px">(jahan delay reason save ho)</span></label>
      ${headers.length ? `
      <select class="header-select" onchange="fmsSteps[${idx}].delayReasonCol=this.value">
        <option value="">-- None (don't save delay reason) --</option>
        ${headers.map(h=>`<option value="${h.col}" ${s.delayReasonCol===h.col?'selected':''}>${h.name} (COL ${h.col})</option>`).join('')}
      </select>` : `
      <input type="text" value="${s.delayReasonCol||''}" placeholder="e.g. K"
        oninput="fmsSteps[${idx}].delayReasonCol=this.value"
        style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:var(--font-sans);outline:none"/>`}
    </div>

    <div class="form-group" style="margin:10px 0 0">
      <label>Doer Name Column <span style="color:var(--faint);font-weight:400;font-size:11px">(column where the doer's name is auto-saved on completion)</span></label>
      <div style="display:flex;gap:8px;align-items:stretch">
        ${headers.length ? `
        <select class="header-select" id="fmsDoerNameCol_${idx}" onchange="fmsSteps[${idx}].doerNameCol=this.value" style="flex:1">
          <option value="">-- None (don't save doer name) --</option>
          ${headers.map(h=>`<option value="${h.col}" ${(s.doerNameCol||s.doer_name_col||'')===h.col?'selected':''}>${h.name} (COL ${h.col})</option>`).join('')}
        </select>` : `
        <input type="text" id="fmsDoerNameCol_${idx}" value="${s.doerNameCol||s.doer_name_col||''}" placeholder="e.g. L"
          oninput="fmsSteps[${idx}].doerNameCol=this.value"
          style="flex:1;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:var(--font-sans);outline:none"/>`}
        <button class="btn btn-sm" type="button" onclick="loadDoersFromColumn(${idx})"
          style="background:#10b981;color:#fff;border:none;padding:0 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap"
          title="Auto-fill Step Doers from this column's unique values">
          🔄 Load Doers
        </button>
      </div>
      <div id="fmsLoadDoersResult_${idx}" style="margin-top:8px;font-size:12px;display:none"></div>
    </div>

    <div class="form-group" style="margin:10px 0 0">
      <label>Complete By Ticking <span style="color:var(--faint);font-weight:400;font-size:11px">(for sheets where a checkbox fills the Actual date itself — leave as None to write the date directly)</span></label>
      ${headers.length ? `
      <select class="header-select" onchange="fmsSteps[${idx}].completeCol=this.value">
        <option value="">-- None (write the timestamp into Actual) --</option>
        ${headers.map(h=>`<option value="${h.col}" ${(s.completeCol||'')===h.col?'selected':''}>${h.name} (COL ${h.col})</option>`).join('')}
      </select>` : `
      <input type="text" value="${s.completeCol||''}" placeholder="e.g. J"
        oninput="fmsSteps[${idx}].completeCol=this.value"
        style="width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:var(--font-sans);outline:none"/>`}
    </div>

    <div class="form-group" style="margin:10px 0 0">
      <label>Extra Input</label>
      <select onchange="toggleFMSExtra(${idx},this.value)"
        style="padding:7px 10px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-family:var(--font-sans);outline:none">
        <option value="no" ${s.extraInput==='no'?'selected':''}>No</option>
        <option value="yes" ${s.extraInput==='yes'?'selected':''}>Yes</option>
      </select>
    </div>
    <div id="fmsExtraSection_${idx}" style="display:${s.extraInput==='yes'?'block':'none'};margin-top:10px;background:#f0f4ff;border-radius:8px;padding:12px">
      <!-- Column selection moved to individual rows below -->
      <div id="fmsExtraRows_${idx}">${extraRowsHTML}</div>
      <button class="btn btn-outline btn-sm" style="margin-top:8px" onclick="addFMSExtraRow(${idx})">+ Add Row</button>
    </div>`;
}

function addFMSShowCol(idx, colIndex) {
  if (isNaN(colIndex)) return;
  if (!fmsSteps[idx].showCols) fmsSteps[idx].showCols = [];
  if (!fmsSteps[idx].showCols.includes(colIndex)) {
    fmsSteps[idx].showCols.push(colIndex);
    refreshStepBox(idx);
  }
}

function removeFMSShowCol(idx, colIndex) {
  if (!fmsSteps[idx].showCols) return;
  fmsSteps[idx].showCols = fmsSteps[idx].showCols.filter(c=>c!==colIndex);
  refreshStepBox(idx);
}

function updateStepNum(idx, val) {
  const boxes = document.querySelectorAll('.fms-step-box');
  boxes.forEach((b,i)=>{
    const numEl = b.querySelector('.fms-step-num');
    if (numEl) numEl.textContent = `Step ${i+1}`;
  });
}

function toggleFMSExtra(idx, val) {
  fmsSteps[idx].extraInput = val;
  document.getElementById(`fmsExtraSection_${idx}`).style.display = val==='yes'?'block':'none';
}

function addFMSExtraRow(idx) {
  if (!fmsSteps[idx].extraRows) fmsSteps[idx].extraRows=[];
  // Flush any dropdown_options values typed in DOM before re-render
  fmsSteps[idx].extraRows.forEach((_, ri) => {
    const el = document.getElementById(`fmsDropOpt_${idx}_${ri}`);
    if (el) fmsSteps[idx].extraRows[ri].dropdown_options = el.value;
    const labelEl = document.getElementById(`fmsExtraLabel_${idx}_${ri}`);
    if (labelEl) fmsSteps[idx].extraRows[ri].label = labelEl.value;
  });
  fmsSteps[idx].extraRows.push({col_letter:'', field_type:'text', label:'', dropdown_options:'', required:1});
  refreshStepBox(idx);
  setupMultiSelect(idx);
  updateFMSDoerTags(idx);
}

function buildExtraRowHTML(idx, ri, headers) {
  const r = (fmsSteps[idx].extraRows || [])[ri] || {};
  const colSel = headers.length
    ? `<select onchange="onFMSExtraColChange(${idx},${ri},this)"
        style="width:100%;padding:7px 10px;border:1.5px solid var(--border);border-radius:7px;font-size:12px;font-family:var(--font-sans);outline:none;background:var(--card)">
        <option value="">-- Select Column --</option>
        ${headers.map(h=>`<option value="${h.col}" data-name="${h.name}" ${r.col_letter===h.col?'selected':''}>${h.name} (COL ${h.col})</option>`).join('')}
      </select>`
    : `<input type="text" value="${r.col_letter||''}" placeholder="Col e.g. AS"
        oninput="fmsSteps[${idx}].extraRows[${ri}].col_letter=this.value"
        style="width:100%;padding:7px 10px;border:1.5px solid var(--border);border-radius:7px;font-size:12px;font-family:var(--font-sans);outline:none"/>`;
  const labelField = `<input type="text" value="${(r.label||'').replace(/"/g,'&quot;')}" placeholder="Label (auto-filled from header)"
    oninput="fmsSteps[${idx}].extraRows[${ri}].label=this.value"
    id="fmsExtraLabel_${idx}_${ri}"
    style="width:100%;padding:7px 10px;border:1.5px solid var(--border);border-radius:7px;font-size:12px;font-family:var(--font-sans);outline:none"/>`;
  const ftSel = `<select onchange="onFMSExtraTypeChange(${idx},${ri},this.value)"
    style="width:100%;padding:7px 10px;border:1.5px solid var(--border);border-radius:7px;font-size:12px;font-family:var(--font-sans);outline:none;background:var(--card)">
    <option value="text" ${(r.field_type||'text')==='text'?'selected':''}>📝 Text</option>
    <option value="number" ${r.field_type==='number'?'selected':''}>🔢 Number</option>
    <option value="date" ${r.field_type==='date'?'selected':''}>📅 Date</option>
    <option value="link" ${r.field_type==='link'?'selected':''}>🔗 Link</option>
    <option value="file" ${r.field_type==='file'?'selected':''}>📎 File</option>
    <option value="dropdown" ${r.field_type==='dropdown'?'selected':''}>🔽 Dropdown</option>
  </select>`;
  const dropOptsSection = r.field_type==='dropdown' ? buildDropdownOptionsHTML(idx, ri, r) : '';
  // required defaults to true (1) — explicit false / 0 means optional
  const isRequired = !(r.required === 0 || r.required === false || r.required === '0');
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px">
      <div>
        <div style="font-size:10px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.3px;margin-bottom:3px">Column</div>
        ${colSel}
      </div>
      <div>
        <div style="font-size:10px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.3px;margin-bottom:3px">Label</div>
        ${labelField}
      </div>
      <div>
        <div style="font-size:10px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.3px;margin-bottom:3px">Field Type</div>
        ${ftSel}
      </div>
      <div>
        <div style="font-size:10px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.3px;margin-bottom:3px">Required?</div>
        <label style="display:flex;align-items:center;gap:6px;padding:7px 10px;border:1.5px solid var(--border);border-radius:7px;font-size:12px;font-family:var(--font-sans);background:var(--card);cursor:pointer;height:34px;box-sizing:border-box">
          <input type="checkbox" ${isRequired?'checked':''}
            onchange="fmsSteps[${idx}].extraRows[${ri}].required=this.checked?1:0"
            style="accent-color:var(--brand-deep);width:14px;height:14px;cursor:pointer"/>
          <span style="font-weight:600;color:var(--foreground)">${isRequired?'Required':'Optional'}</span>
        </label>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:6px">
      <button class="action-btn delete" style="padding:4px 12px" onclick="removeFMSExtraRow(${idx},${ri})">✕ Remove Row</button>
    </div>
    <div id="fmsDropOptSection_${idx}_${ri}">${dropOptsSection}</div>`;
}

function buildDropdownOptionsHTML(idx, ri, r) {
  const opts = (r.dropdown_options || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<div style="margin-top:4px">
    <label style="font-size:11px;font-weight:600;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.3px">Dropdown Options <span style="color:var(--faint);font-weight:400">(comma separated, e.g. Yes,No,N/A)</span></label>
    <input type="text" value="${opts}" placeholder="Yes,No,N/A or Option1,Option2,Option3"
      oninput="fmsSteps[${idx}].extraRows[${ri}].dropdown_options=this.value"
      id="fmsDropOpt_${idx}_${ri}"
      style="width:100%;padding:7px 10px;border:1.5px solid var(--border);border-radius:7px;font-size:12px;font-family:var(--font-sans);outline:none;margin-top:4px"/>
  </div>`;
}

function onFMSExtraColChange(idx, ri, sel) {
  fmsSteps[idx].extraRows[ri].col_letter = sel.value;
  // Auto-fill label from header name
  const selectedOpt = sel.options[sel.selectedIndex];
  const headerName = selectedOpt.dataset.name || sel.value;
  fmsSteps[idx].extraRows[ri].label = headerName;
  const labelEl = document.getElementById(`fmsExtraLabel_${idx}_${ri}`);
  if (labelEl) labelEl.value = headerName;
}

function onFMSExtraTypeChange(idx, ri, val) {
  fmsSteps[idx].extraRows[ri].field_type = val;
  const section = document.getElementById(`fmsDropOptSection_${idx}_${ri}`);
  if (section) {
    section.innerHTML = val === 'dropdown' ? buildDropdownOptionsHTML(idx, ri, fmsSteps[idx].extraRows[ri]) : '';
  }
}

function removeFMSExtraRow(idx, ri) {
  // Flush all dropdown_options and labels from DOM before splice so data isn't lost
  fmsSteps[idx].extraRows.forEach((_, i) => {
    const el = document.getElementById(`fmsDropOpt_${idx}_${i}`);
    if (el) fmsSteps[idx].extraRows[i].dropdown_options = el.value;
    const labelEl = document.getElementById(`fmsExtraLabel_${idx}_${i}`);
    if (labelEl) fmsSteps[idx].extraRows[i].label = labelEl.value;
  });
  fmsSteps[idx].extraRows.splice(ri,1);
  refreshStepBox(idx);
  setupMultiSelect(idx);
  updateFMSDoerTags(idx);
}

// A company's whole user list scrolls past in a 240px box, so picking one out
// of it was the slow part of setting an FMS up. The list filters as you type.
function filterFMSDoers(idx, q) {
  const drop = document.getElementById(`fmsDoerDrop_${idx}`);
  if (!drop) return;
  // Each word has to appear somewhere in the name, so "pal swa" finds
  // "Palak Swami" without having to type it in order.
  const parts = String(q || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  let shown = 0;
  drop.querySelectorAll('.multi-select-item').forEach(item => {
    const hit = parts.every(part => (item.dataset.name || '').includes(part));
    item.style.display = hit ? '' : 'none';
    if (hit) shown++;
  });
  const empty = document.getElementById(`fmsDoerEmpty_${idx}`);
  if (empty) empty.style.display = shown ? 'none' : 'block';
}

// Clears whatever was typed and puts the full list back — every open starts
// from the same place rather than from the last search.
function resetFMSDoerSearch(idx) {
  const box = document.getElementById(`fmsDoerSearch_${idx}`);
  if (!box) return;
  box.value = '';
  filterFMSDoers(idx, '');
}

// Enter takes the top name and empties the box, so several doers can be added
// without reaching for the mouse. Escape closes the list.
function fmsDoerSearchKey(e, idx) {
  const drop = document.getElementById(`fmsDoerDrop_${idx}`);
  if (e.key === 'Escape') { if (drop) drop.classList.remove('open'); resetFMSDoerSearch(idx); return; }
  if (e.key !== 'Enter' || !drop) return;
  e.preventDefault();
  const first = Array.from(drop.querySelectorAll('.multi-select-item')).find(i => i.style.display !== 'none');
  if (!first) return;
  toggleFMSDoer(e, idx, first.dataset.uid);
  resetFMSDoerSearch(idx);
}

function toggleFMSDropdown(idx) {
  const drop = document.getElementById(`fmsDoerDrop_${idx}`);
  if (!drop) return;
  const opening = !drop.classList.contains('open');
  drop.classList.toggle('open', opening);
  resetFMSDoerSearch(idx);
  if (opening) setTimeout(() => { const b = document.getElementById(`fmsDoerSearch_${idx}`); if (b) b.focus(); }, 0);
}

function toggleFMSDoer(e, idx, uid) {
  e.stopPropagation();
  uid = parseInt(uid);
  if (!fmsSteps[idx].doers) fmsSteps[idx].doers=[];
  const i = fmsSteps[idx].doers.indexOf(uid);
  if (i===-1) fmsSteps[idx].doers.push(uid);
  else fmsSteps[idx].doers.splice(i,1);
  // Update checkbox state
  const drop = document.getElementById(`fmsDoerDrop_${idx}`);
  if (drop) {
    drop.querySelectorAll('.multi-select-item').forEach(item => {
      const itemUid = parseInt(item.dataset.uid);
      const cb = item.querySelector('input[type=checkbox]');
      if (cb) cb.checked = fmsSteps[idx].doers.includes(itemUid);
    });
  }
  updateFMSDoerTags(idx);
}

function updateFMSDoerTags(idx) {
  const tags = document.getElementById(`fmsDoerTags_${idx}`);
  const doers = fmsSteps[idx].doers||[];
  if (!doers.length) { tags.innerHTML=`<span style="color:var(--faint);font-size:12px">Select users...</span>`; return; }
  const names = doers.map(uid=>{ const u=fmsAllUsers.find(u=>parseInt(u.id)===parseInt(uid)); return u?u.name:''; }).filter(Boolean);
  tags.innerHTML = names.map(n=>`<span class="tag-badge">${n}</span>`).join('');
}

function setupMultiSelect(idx) {
  document.addEventListener('click', function(e) {
    const drop = document.getElementById(`fmsDoerDrop_${idx}`);
    const wrap = document.getElementById(`fmsDoerWrap_${idx}`);
    if (drop && wrap && !wrap.contains(e.target) && drop.classList.contains('open')) {
      drop.classList.remove('open');
      resetFMSDoerSearch(idx);
    }
  });
}

// 🔄 Load Step Doers from a Sheet column (uses doer_name_col)
async function loadDoersFromColumn(idx) {
  const step = fmsSteps[idx];
  const col = (step.doerNameCol || step.doer_name_col || '').trim().toUpperCase();
  const resultBox = document.getElementById(`fmsLoadDoersResult_${idx}`);
  resultBox.style.display = 'block';
  resultBox.innerHTML = '<i style="color:var(--muted-foreground)">Loading...</i>';

  if (!col) {
    resultBox.innerHTML = '<span style="color:#dc2626">⚠️ Please select the "Doer Name Column" first, then click this button.</span>';
    return;
  }

  // Get sheet ID + tab name + header row from whichever modal is open (new or edit)
  const isEdit = document.getElementById('fmsEditModal')?.classList.contains('open');
  const sheetId = isEdit
    ? document.getElementById('editFmsSheetId').value.trim()
    : document.getElementById('fmsSheetId').value.trim();
  const tabName = isEdit
    ? document.getElementById('editFmsSheetName').value.trim()
    : document.getElementById('fmsSheetName').value.trim();
  const headerRow = isEdit
    ? (parseInt(document.getElementById('editFmsHeaderRow').value)||1)
    : (parseInt(document.getElementById('fmsHeaderRow').value)||1);

  if (!sheetId) {
    resultBox.innerHTML = '<span style="color:#dc2626">⚠️ Please enter the Sheet ID above first.</span>';
    return;
  }

  try {
    const params = new URLSearchParams({ sheetId, tabName, col, headerRow });
    const r = await api('/api/fms/sheet-column-values?' + params.toString());
    if (r.error) throw new Error(r.error);

    // Auto-select matched users
    const matchedIds = r.matched.map(m => m.user_id);
    fmsSteps[idx].doers = matchedIds;

    // Update UI: refresh checkboxes & tags
    const drop = document.getElementById(`fmsDoerDrop_${idx}`);
    if (drop) {
      drop.querySelectorAll('.multi-select-item').forEach(item => {
        const itemUid = parseInt(item.dataset.uid);
        const cb = item.querySelector('input[type=checkbox]');
        if (cb) cb.checked = matchedIds.includes(itemUid);
      });
    }
    updateFMSDoerTags(idx);

    // Show result summary
    let html = `<div style="background:#f0fdf4;border:1px solid #86efac;color:#166534;padding:8px 12px;border-radius:6px;line-height:1.5">`;
    html += `<b>✅ Loaded ${r.total_unique} unique name${r.total_unique===1?'':'s'} from Col ${col}</b><br>`;
    html += `Matched & auto-selected: <b>${r.matched_count}</b>`;
    if (r.matched_count) {
      html += ` <span style="color:#475569">(${r.matched.map(m => dtEscape(m.user_name)).join(', ')})</span>`;
    }
    if (r.unmatched_count) {
      html += `<br><span style="color:#b45309">⚠️ Not in users DB (${r.unmatched_count}): ${r.unmatched.map(n => dtEscape(n)).join(', ')}</span>`;
      html += `<br><span style="color:var(--muted-foreground);font-size:11px">→ Add these names in the Users tab, then click Load Doers again.</span>`;
    }
    html += `</div>`;
    resultBox.innerHTML = html;
  } catch (e) {
    resultBox.innerHTML = `<span style="color:#dc2626">❌ ${e.message}</span>`;
  }
}

function getActiveFMSContainer() {
  if (document.getElementById('fmsEditModal')?.classList.contains('open')) return 'fmsEditStepsContainer';
  return 'fmsStepsContainer';
}

function addFMSStep() {
  const idx = fmsSteps.length;
  fmsSteps.push({stepName:`Step ${idx+1}`, doers:[], planCol:'', actualCol:'', extraInput:'no', extraCol:'', extraRows:[], showCols:[], delayReasonCol:'', doerNameCol:'', completeCol:''});
  appendFMSStepBox(idx, getActiveFMSContainer());
  updateEditStepNav();
}

// ── Delete mode (Edit modal) ──
function toggleFMSDeleteMode() {
  fmsDeleteMode = !fmsDeleteMode;
  const btn = document.getElementById('editFmsDeleteModeBtn');
  const delBtn = document.getElementById('fmsConfirmDeleteBtn');
  if (btn) btn.textContent = fmsDeleteMode ? '✕ Cancel' : '🗑 Select to Delete';
  if (delBtn) delBtn.style.display = fmsDeleteMode ? 'inline-block' : 'none';
  refreshAllStepBoxes();
  updateEditStepNav();
}

function confirmFMSDelete() {
  const checked = [...document.querySelectorAll('.fms-del-check:checked')].map(c=>parseInt(c.dataset.idx));
  if (!checked.length) { showToast('No steps selected','error'); return; }
  checked.sort((a,b)=>b-a).forEach(idx=>fmsSteps.splice(idx,1));
  fmsDeleteMode=false;
  const btn = document.getElementById('editFmsDeleteModeBtn');
  if (btn) btn.textContent='🗑 Select to Delete';
  document.getElementById('fmsConfirmDeleteBtn').style.display='none';
  refreshAllStepBoxes();
  updateEditStepNav();
}

// ── Duplicate mode (Edit modal) ──
function toggleFMSDupMode() {
  fmsDupMode = !fmsDupMode;
  const btn = document.getElementById('editFmsDupModeBtn');
  const confBtn = document.getElementById('editFmsDupConfirmBtn');
  if (btn) btn.textContent = fmsDupMode ? '✕ Cancel' : '📋 Duplicate';
  if (confBtn) confBtn.style.display = fmsDupMode ? 'inline-block' : 'none';
  refreshAllStepBoxes();
  updateEditStepNav();
}

function confirmFMSDup() {
  const checked = [...document.querySelectorAll('.fms-dup-check:checked')].map(c=>parseInt(c.dataset.idx));
  if (!checked.length) { showToast('No steps selected','error'); return; }
  // Deep copy selected steps and add at end
  checked.forEach(idx => {
    const orig = fmsSteps[idx];
    const copy = JSON.parse(JSON.stringify(orig));
    copy.stepName = orig.stepName + ' (Copy)';
    fmsSteps.push(copy);
  });
  fmsDupMode = false;
  const btn = document.getElementById('editFmsDupModeBtn');
  if (btn) btn.textContent = '📋 Duplicate';
  document.getElementById('editFmsDupConfirmBtn').style.display = 'none';
  refreshAllStepBoxes();
  updateEditStepNav();
  showToast(`✅ ${checked.length} step(s) duplicated!`);
}

// ── Delete mode (Add modal) ──
function toggleFMSDeleteModeAdd() {
  fmsDeleteMode = !fmsDeleteMode;
  const btn = document.getElementById('fmsAddDeleteModeBtn');
  const delBtn = document.getElementById('fmsAddConfirmDeleteBtn');
  if (btn) btn.textContent = fmsDeleteMode ? '✕ Cancel' : '🗑 Select to Delete';
  if (delBtn) delBtn.style.display = fmsDeleteMode ? 'inline-block' : 'none';
  refreshAllStepBoxes();
}

function confirmFMSDeleteAdd() {
  const checked = [...document.querySelectorAll('.fms-del-check:checked')].map(c=>parseInt(c.dataset.idx));
  if (!checked.length) { showToast('No steps selected','error'); return; }
  checked.sort((a,b)=>b-a).forEach(idx=>fmsSteps.splice(idx,1));
  fmsDeleteMode=false;
  const btn = document.getElementById('fmsAddDeleteModeBtn');
  if (btn) btn.textContent='🗑 Select to Delete';
  document.getElementById('fmsAddConfirmDeleteBtn').style.display='none';
  refreshAllStepBoxes();
}

function refreshAllStepBoxes() {
  const cid = getActiveFMSContainer();
  const container = document.getElementById(cid);
  if (!container) return;
  container.innerHTML='';
  fmsSteps.forEach((_,i) => appendFMSStepBox(i, cid));
  updateEditStepNav();
}

function refreshStepBox(idx) {
  const boxes = document.querySelectorAll('.fms-step-box');
  if (boxes[idx]) {
    boxes[idx].innerHTML = buildStepBoxHTML(idx);
    setupMultiSelect(idx);
  }
}

// ── Drag & Drop reorder ──
let dragSrcIdx = null;

function setupDragEvents(el) {
  el.addEventListener('dragstart', e => {
    dragSrcIdx = parseInt(el.dataset.idx);
    e.dataTransfer.effectAllowed='move';
  });
  el.addEventListener('dragover', e => {
    e.preventDefault();
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const destIdx = parseInt(el.dataset.idx);
    if (dragSrcIdx===null || dragSrcIdx===destIdx) return;
    // Swap
    const moved = fmsSteps.splice(dragSrcIdx,1)[0];
    fmsSteps.splice(destIdx,0,moved);
    dragSrcIdx=null;
    refreshAllStepBoxes();
  });
}

// ── Save FMS ──
async function saveFMS() {
  const boxes = document.querySelectorAll('#fmsStepsContainer .fms-step-box');
  boxes.forEach((box,i)=>{
    const nameInput = box.querySelector('input[type=text]');
    if (nameInput) fmsSteps[i].stepName = nameInput.value.trim() || `Step ${i+1}`;
    fmsSteps[i].step_order = i+1;
    // Flush dropdown_options and labels for all extraRows from DOM
    (fmsSteps[i].extraRows||[]).forEach((_, ri) => {
      const el = document.getElementById(`fmsDropOpt_${i}_${ri}`);
      if (el) fmsSteps[i].extraRows[ri].dropdown_options = el.value;
      const labelEl = document.getElementById(`fmsExtraLabel_${i}_${ri}`);
      if (labelEl) fmsSteps[i].extraRows[ri].label = labelEl.value;
    });
  });

  if (fmsSteps.some(s=>!s.stepName)) { showToast('Please enter a name for all steps','error'); return; }

  const body = {
    fmsName: fmsData.fmsName || fmsData.sheetName,
    sheetName: fmsData.sheetName,
    sheetId: fmsData.sheetId,
    headerRow: fmsData.headerRow,
    totalSteps: fmsSteps.length,
    steps: fmsSteps.map(s=>({...s, showCols: s.showCols||[], delayReasonCol: s.delayReasonCol||'', doerNameCol: s.doerNameCol||s.doer_name_col||'', completeCol: s.completeCol||s.complete_col||'', extraRows: (s.extraRows||[]).map(r=>({...r, dropdown_options: r.dropdown_options||''}))}))
  };

  const r = await api('/api/fms', 'POST', body);
  if (r.error) { showToast(r.error,'error'); return; }

  closeModal('fmsStepsModal');
  showToast('✅ FMS saved successfully!');
  fmsActiveId = r.id;
  fmsSheetHeaders = [];
  loadFMSAdmin();
}

// ══════════════════════════════════════════════════════
// FMS TASKS
// ══════════════════════════════════════════════════════
let fmsTasksActiveFmsId = null;
let fmsTasksActiveStepId = null;
let fmsTasksActiveStepData = null;
let fmsTrainPaused = false;

// ══════════════════════════════════════════════════════
// MERCH FMS — Production Merchandising FMS - Unit 1
// Data-entry form: SO NO, Party Name, SKU, No. of Pcs, Material Name,
// Material Type, Quantity, Unit, Quantity Required, Status — submit → sheet me row add
// ══════════════════════════════════════════════════════
const MERCH_STATUS_OPTIONS = ['Raise PO', 'Material Issue', 'Inhouse'];
const MERCH_UNIT_OPTIONS = ['PCS', 'MTR', 'GRS', 'KGS', 'ROLLS', 'BOX'];
const MERCH_MATERIALTYPE_OPTIONS = ['FABRIC', 'ACCESSORY'];

function mfUnitOptionsHtml(sel) {
  return `<option value="">-- Select --</option>` +
    MERCH_UNIT_OPTIONS.map(o => `<option value="${o}" ${sel===o?'selected':''}>${o}</option>`).join('');
}

function mfMaterialTypeOptionsHtml(sel) {
  return `<option value="">-- Select --</option>` +
    MERCH_MATERIALTYPE_OPTIONS.map(o => `<option value="${o}" ${sel===o?'selected':''}>${o}</option>`).join('');
}

function loadMerchFMS() {
  const tbody = document.getElementById('merchFmsRowsBody');
  if (tbody.children.length === 0) mfAddRow();
  const tbody2 = document.getElementById('merchFmsRowsBody2');
  if (tbody2 && tbody2.children.length === 0) mfAddRow2();
  const tbody3 = document.getElementById('merchFmsRowsBody3');
  if (tbody3 && tbody3.children.length === 0) mfAddRow3();

  // PO tab — only Production / Finance / Admin get to see it at all
  const poTabBtn = document.getElementById('mfTabForm3');
  const canSeePO = window.IS_PO_ADMIN || window.IS_PO_PROD || window.IS_PO_FINANCE;
  if (poTabBtn) poTabBtn.style.display = canSeePO ? '' : 'none';
  // Fill form — only Production / Admin (Finance only views + uploads doc)
  const poFormCard = document.getElementById('poFormCard');
  const canFillPO = window.IS_PO_ADMIN || window.IS_PO_PROD;
  if (poFormCard) poFormCard.style.display = canFillPO ? '' : 'none';
  const hint = document.getElementById('poEntriesHint');
  if (hint) {
    hint.textContent = window.IS_PO_FINANCE && !window.IS_PO_ADMIN
      ? 'For any PO without a document, upload the file in its "PO Document" column.'
      : (canFillPO ? 'The PO document uploaded by Finance appears here as a link — you can download it as well.' : '');
  }
}

function switchMerchFormTab(which, el) {
  document.querySelectorAll('#page-merchfms .tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('mfFormWrap1').style.display = which === 'form1' ? 'block' : 'none';
  document.getElementById('mfFormWrap2').style.display = which === 'form2' ? 'block' : 'none';
  document.getElementById('mfFormWrap3').style.display = which === 'form3' ? 'block' : 'none';
  document.getElementById('mfFormWrap4').style.display = which === 'form4' ? 'block' : 'none';
  if (which === 'form3') {
    const tbody = document.getElementById('poRowsBody');
    if (tbody.children.length === 0) poAddRow();
    loadPOEntries();
  }
}

function mfStatusOptionsHtml(sel) {
  return `<option value="">-- Select --</option>` +
    MERCH_STATUS_OPTIONS.map(o => `<option value="${o}" ${sel===o?'selected':''}>${o}</option>`).join('');
}

function mfAddRow(prefill) {
  const tbody = document.getElementById('merchFmsRowsBody');
  const tr = document.createElement('tr');
  tr.className = 'dt-row';
  tr.innerHTML = `
    <td><input type="text" class="mf-soNo" value="${prefill?.soNo||''}" placeholder="SO NO"/></td>
    <td><input type="text" class="mf-partyName" value="${prefill?.partyName||''}" placeholder="Party Name"/></td>
    <td><input type="text" class="mf-sku" value="${prefill?.sku||''}" placeholder="SKU"/></td>
    <td><input type="number" class="mf-noOfPcs" value="${prefill?.noOfPcs||''}" placeholder="0"/></td>
    <td><input type="text" class="mf-materialName" value="${prefill?.materialName||''}" placeholder="Material Name"/></td>
    <td><select class="mf-materialType">${mfMaterialTypeOptionsHtml(prefill?.materialType)}</select></td>
    <td><input type="text" class="mf-quantity" value="${prefill?.quantity||''}" placeholder="Quantity"/></td>
    <td><select class="mf-unit">${mfUnitOptionsHtml(prefill?.unit)}</select></td>
    <td><input type="text" class="mf-vendorName" value="${prefill?.vendorName||''}" placeholder="Vendor Name"/></td>
    <td><select class="mf-status">${mfStatusOptionsHtml(prefill?.status)}</select></td>
    <td><button class="dt-row-btn dt-btn-dup" onclick="mfDupRow(this)">Dup</button></td>
    <td><button class="dt-row-btn dt-btn-del" onclick="mfDelRow(this)">Del</button></td>
  `;
  tbody.appendChild(tr);
}

function mfDupRow(btn) {
  const tr = btn.closest('tr');
  mfAddRow({
    soNo: tr.querySelector('.mf-soNo').value,
    partyName: tr.querySelector('.mf-partyName').value,
    sku: tr.querySelector('.mf-sku').value,
    noOfPcs: tr.querySelector('.mf-noOfPcs').value,
    materialName: tr.querySelector('.mf-materialName').value,
    materialType: tr.querySelector('.mf-materialType').value,
    quantity: tr.querySelector('.mf-quantity').value,
    unit: tr.querySelector('.mf-unit').value,
    vendorName: tr.querySelector('.mf-vendorName').value,
    status: tr.querySelector('.mf-status').value
  });
}

function mfDelRow(btn) {
  const tbody = document.getElementById('merchFmsRowsBody');
  if (tbody.children.length <= 1) { showToast('At least 1 row required', 'error'); return; }
  btn.closest('tr').remove();
}

async function mfSubmit() {
  const errEl = document.getElementById('merchFmsErr');
  errEl.style.display = 'none';
  const rows = [];
  for (const tr of document.querySelectorAll('#merchFmsRowsBody tr')) {
    const soNo = tr.querySelector('.mf-soNo').value.trim();
    const status = tr.querySelector('.mf-status').value;
    if (!soNo || !status) {
      errEl.textContent = 'SO NO and Status are required in every row';
      errEl.style.display = 'block';
      return;
    }
    rows.push({
      soNo,
      partyName: tr.querySelector('.mf-partyName').value.trim(),
      sku: tr.querySelector('.mf-sku').value.trim(),
      noOfPcs: tr.querySelector('.mf-noOfPcs').value.trim(),
      materialName: tr.querySelector('.mf-materialName').value.trim(),
      materialType: tr.querySelector('.mf-materialType').value.trim(),
      quantity: tr.querySelector('.mf-quantity').value.trim(),
      unit: tr.querySelector('.mf-unit').value,
      vendorName: tr.querySelector('.mf-vendorName').value.trim(),
      status
    });
  }
  if (!rows.length) { errEl.textContent = 'At least 1 row required'; errEl.style.display = 'block'; return; }

  const btn = document.querySelector('#merchFmsActions .dt-btn-submit');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const r = await api('/api/merch-fms/submit', 'POST', { rows });
    if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; }
    else {
      showToast(`✅ ${r.count} row(s) sheet me add ho gaye!`);
      document.getElementById('merchFmsRowsBody').innerHTML = '';
      mfAddRow();
    }
  } catch (e) {
    errEl.textContent = 'Submit failed: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Submit All →';
  }
}

// ── Fourth form: Production Merchandising FMS - Unit 2 (alag sheet, "Form" tab, COL C-K, Row 616+) ──
function mfAddRow3(prefill) {
  const tbody = document.getElementById('merchFmsRowsBody3');
  const tr = document.createElement('tr');
  tr.className = 'dt-row';
  tr.innerHTML = `
    <td><input type="text" class="mf3-soNo" value="${prefill?.soNo||''}" placeholder="SO NO"/></td>
    <td><input type="text" class="mf3-partyName" value="${prefill?.partyName||''}" placeholder="Party Name"/></td>
    <td><input type="text" class="mf3-sku" value="${prefill?.sku||''}" placeholder="SKU"/></td>
    <td><input type="number" class="mf3-noOfPcs" value="${prefill?.noOfPcs||''}" placeholder="0"/></td>
    <td><input type="text" class="mf3-materialName" value="${prefill?.materialName||''}" placeholder="Material Name"/></td>
    <td><input type="text" class="mf3-materialType" value="${prefill?.materialType||''}" placeholder="Material Type"/></td>
    <td><input type="text" class="mf3-quantity" value="${prefill?.quantity||''}" placeholder="Quantity"/></td>
    <td><select class="mf3-unit">${mfUnitOptionsHtml(prefill?.unit)}</select></td>
    <td><input type="text" class="mf3-vendorName" value="${prefill?.vendorName||''}" placeholder="Vendor Name"/></td>
    <td><select class="mf3-status">${mfStatusOptionsHtml(prefill?.status)}</select></td>
    <td><button class="dt-row-btn dt-btn-dup" onclick="mfDupRow3(this)">Dup</button></td>
    <td><button class="dt-row-btn dt-btn-del" onclick="mfDelRow3(this)">Del</button></td>
  `;
  tbody.appendChild(tr);
}

function mfDupRow3(btn) {
  const tr = btn.closest('tr');
  mfAddRow3({
    soNo: tr.querySelector('.mf3-soNo').value,
    partyName: tr.querySelector('.mf3-partyName').value,
    sku: tr.querySelector('.mf3-sku').value,
    noOfPcs: tr.querySelector('.mf3-noOfPcs').value,
    materialName: tr.querySelector('.mf3-materialName').value,
    materialType: tr.querySelector('.mf3-materialType').value,
    quantity: tr.querySelector('.mf3-quantity').value,
    unit: tr.querySelector('.mf3-unit').value,
    vendorName: tr.querySelector('.mf3-vendorName').value,
    status: tr.querySelector('.mf3-status').value
  });
}

function mfDelRow3(btn) {
  const tbody = document.getElementById('merchFmsRowsBody3');
  if (tbody.children.length <= 1) { showToast('At least 1 row required', 'error'); return; }
  btn.closest('tr').remove();
}

async function mfSubmit3() {
  const errEl = document.getElementById('merchFmsErr3');
  errEl.style.display = 'none';
  const rows = [];
  for (const tr of document.querySelectorAll('#merchFmsRowsBody3 tr')) {
    const soNo = tr.querySelector('.mf3-soNo').value.trim();
    const status = tr.querySelector('.mf3-status').value;
    if (!soNo || !status) {
      errEl.textContent = 'SO NO and Status are required in every row';
      errEl.style.display = 'block';
      return;
    }
    rows.push({
      soNo,
      partyName: tr.querySelector('.mf3-partyName').value.trim(),
      sku: tr.querySelector('.mf3-sku').value.trim(),
      noOfPcs: tr.querySelector('.mf3-noOfPcs').value.trim(),
      materialName: tr.querySelector('.mf3-materialName').value.trim(),
      materialType: tr.querySelector('.mf3-materialType').value.trim(),
      quantity: tr.querySelector('.mf3-quantity').value.trim(),
      unit: tr.querySelector('.mf3-unit').value,
      vendorName: tr.querySelector('.mf3-vendorName').value.trim(),
      status
    });
  }
  if (!rows.length) { errEl.textContent = 'At least 1 row required'; errEl.style.display = 'block'; return; }

  const btn = document.querySelector('#merchFmsActions3 .dt-btn-submit');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const r = await api('/api/merch-fms-22godam/submit', 'POST', { rows });
    if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; }
    else {
      showToast(`✅ ${r.count} row(s) sheet me add ho gaye!`);
      document.getElementById('merchFmsRowsBody3').innerHTML = '';
      mfAddRow3();
    }
  } catch (e) {
    errEl.textContent = 'Submit failed: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Submit All →';
  }
}

// ── Second form: PRODUCTION MANAGMENT FMS - Unit 1 (Process FMS tab, COL A-F) ──
function mfNowTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function mfAddRow2(prefill) {
  const tbody = document.getElementById('merchFmsRowsBody2');
  const tr = document.createElement('tr');
  tr.className = 'dt-row';
  const ts = mfNowTimestamp();
  tr.innerHTML = `
    <td><span class="mf2-timestamp" style="font-size:12px;color:var(--muted-foreground);font-weight:600;white-space:nowrap">${ts}</span></td>
    <td><input type="text" class="mf2-docLink" value="${prefill?.docLink||''}" placeholder="Doc Link (URL)"/></td>
    <td><input type="number" class="mf2-actualQty" value="${prefill?.actualQty||''}" placeholder="0"/></td>
    <td><input type="text" class="mf2-designNumber" value="${prefill?.designNumber||''}" placeholder="Design Number"/></td>
    <td><input type="text" class="mf2-soNumber" value="${prefill?.soNumber||''}" placeholder="SO Number"/></td>
    <td><input type="text" class="mf2-partyName" value="${prefill?.partyName||''}" placeholder="Party Name"/></td>
    <td><button class="dt-row-btn dt-btn-dup" onclick="mfDupRow2(this)">Dup</button></td>
    <td><button class="dt-row-btn dt-btn-del" onclick="mfDelRow2(this)">Del</button></td>
  `;
  tbody.appendChild(tr);
}

function mfDupRow2(btn) {
  const tr = btn.closest('tr');
  mfAddRow2({
    docLink: tr.querySelector('.mf2-docLink').value,
    actualQty: tr.querySelector('.mf2-actualQty').value,
    designNumber: tr.querySelector('.mf2-designNumber').value,
    soNumber: tr.querySelector('.mf2-soNumber').value,
    partyName: tr.querySelector('.mf2-partyName').value
  });
}

function mfDelRow2(btn) {
  const tbody = document.getElementById('merchFmsRowsBody2');
  if (tbody.children.length <= 1) { showToast('At least 1 row required', 'error'); return; }
  btn.closest('tr').remove();
}

async function mfSubmit2() {
  const errEl = document.getElementById('merchFmsErr2');
  errEl.style.display = 'none';
  const rows = [];
  for (const tr of document.querySelectorAll('#merchFmsRowsBody2 tr')) {
    const soNumber = tr.querySelector('.mf2-soNumber').value.trim();
    if (!soNumber) {
      errEl.textContent = 'SO Number is required in every row';
      errEl.style.display = 'block';
      return;
    }
    rows.push({
      docLink: tr.querySelector('.mf2-docLink').value.trim(),
      actualQty: tr.querySelector('.mf2-actualQty').value.trim(),
      designNumber: tr.querySelector('.mf2-designNumber').value.trim(),
      soNumber,
      partyName: tr.querySelector('.mf2-partyName').value.trim()
    });
  }
  if (!rows.length) { errEl.textContent = 'At least 1 row required'; errEl.style.display = 'block'; return; }

  const btn = document.querySelector('#merchFmsActions2 .dt-btn-submit');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const r = await api('/api/process-fms/submit', 'POST', { rows });
    if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; }
    else {
      showToast(`✅ ${r.count} row(s) sheet me add ho gaye!`);
      document.getElementById('merchFmsRowsBody2').innerHTML = '';
      mfAddRow2();
    }
  } catch (e) {
    errEl.textContent = 'Submit failed: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Submit All →';
  }
}

// ── Third form: PO (same database/spreadsheet as Merch FMS, "PO" tab, COL C-M) ──
function poAddRow(prefill) {
  const tbody = document.getElementById('poRowsBody');
  const tr = document.createElement('tr');
  tr.className = 'dt-row';
  tr.innerHTML = `
    <td><input type="text" class="po-orderBy" value="${prefill?.orderBy||''}" placeholder="Order By"/></td>
    <td><input type="text" class="po-partyName" value="${prefill?.partyName||''}" placeholder="Party Name"/></td>
    <td><input type="text" class="po-vendorName" value="${prefill?.vendorName||''}" placeholder="Vendor Name"/></td>
    <td><input type="text" class="po-soNumber" value="${prefill?.soNumber||''}" placeholder="SO Number"/></td>
    <td><input type="text" class="po-materialType" value="${prefill?.materialType||''}" placeholder="Material Type"/></td>
    <td><input type="text" class="po-styleNo" value="${prefill?.styleNo||''}" placeholder="Style No"/></td>
    <td><input type="text" class="po-qtyRequired" value="${prefill?.qtyRequired||''}" placeholder="Qty"/></td>
    <td><input type="text" class="po-price" value="${prefill?.price||''}" placeholder="Price"/></td>
    <td><button class="dt-row-btn dt-btn-dup" onclick="poDupRow(this)">Dup</button></td>
    <td><button class="dt-row-btn dt-btn-del" onclick="poDelRow(this)">Del</button></td>
  `;
  tbody.appendChild(tr);
}

function poDupRow(btn) {
  const tr = btn.closest('tr');
  poAddRow({
    orderBy: tr.querySelector('.po-orderBy').value,
    partyName: tr.querySelector('.po-partyName').value,
    vendorName: tr.querySelector('.po-vendorName').value,
    soNumber: tr.querySelector('.po-soNumber').value,
    materialType: tr.querySelector('.po-materialType').value,
    styleNo: tr.querySelector('.po-styleNo').value,
    qtyRequired: tr.querySelector('.po-qtyRequired').value,
    price: tr.querySelector('.po-price').value
  });
}

function poDelRow(btn) {
  const tbody = document.getElementById('poRowsBody');
  if (tbody.children.length <= 1) { showToast('At least 1 row required', 'error'); return; }
  btn.closest('tr').remove();
}

async function poSubmit() {
  const errEl = document.getElementById('poErr');
  errEl.style.display = 'none';
  const rows = [];
  for (const tr of document.querySelectorAll('#poRowsBody tr')) {
    const partyName = tr.querySelector('.po-partyName').value.trim();
    if (!partyName) {
      errEl.textContent = 'Party Name is required in every row';
      errEl.style.display = 'block';
      return;
    }
    rows.push({
      orderBy: tr.querySelector('.po-orderBy').value.trim(),
      partyName,
      vendorName: tr.querySelector('.po-vendorName').value.trim(),
      soNumber: tr.querySelector('.po-soNumber').value.trim(),
      materialType: tr.querySelector('.po-materialType').value.trim(),
      styleNo: tr.querySelector('.po-styleNo').value.trim(),
      qtyRequired: tr.querySelector('.po-qtyRequired').value.trim(),
      price: tr.querySelector('.po-price').value.trim()
    });
  }
  if (!rows.length) { errEl.textContent = 'At least 1 row required'; errEl.style.display = 'block'; return; }

  const btn = document.querySelector('#poActions .dt-btn-submit');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const r = await api('/api/po/submit', 'POST', { rows });
    if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; }
    else {
      showToast(`✅ ${r.count} row(s) sheet me add ho gaye!`);
      document.getElementById('poRowsBody').innerHTML = '';
      poAddRow();
      loadPOEntries();
    }
  } catch (e) {
    errEl.textContent = 'Submit failed: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Submit All →';
  }
}

function poDocCellHtml(e) {
  const canUpload = window.IS_PO_ADMIN || window.IS_PO_FINANCE;
  const linkHtml = e.docUrl
    ? `<a href="${e.docUrl}" target="_blank" rel="noopener" class="btn btn-outline btn-sm" style="text-decoration:none">⬇ Download</a>
       <div style="font-size:10px;color:var(--faint);margin-top:2px">by ${e.uploadedBy||'—'} · ${e.uploadedAt||''}</div>`
    : `<span style="font-size:12px;color:var(--faint)">Not uploaded yet</span>`;
  if (!canUpload) return linkHtml;
  return `
    ${linkHtml}
    <div style="margin-top:6px;display:flex;gap:4px;align-items:center">
      <input type="file" class="po-doc-file" style="max-width:120px;font-size:11px"/>
      <button class="btn btn-outline btn-sm" onclick="poUploadDoc(${e.row}, this)">${e.docUrl?'Replace':'Upload'}</button>
    </div>
  `;
}

async function poUploadDoc(row, btn) {
  const wrap = btn.closest('td');
  const fileInput = wrap.querySelector('.po-doc-file');
  const file = fileInput.files[0];
  if (!file) { showToast('Please choose a file first', 'error'); return; }
  btn.disabled = true; btn.textContent = 'Uploading...';
  try {
    const token = localStorage.getItem('authToken');
    const fd = new FormData();
    fd.append('file', file);
    const opts = { method: 'POST', body: fd, credentials: 'include', headers: {} };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(`/api/po/${row}/upload-doc`, opts);
    const data = await r.json();
    if (data.error) { showToast(data.error, 'error'); }
    else { showToast('✅ PO document upload ho gaya!'); loadPOEntries(); }
  } catch (e) {
    showToast('Upload failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Upload';
  }
}

async function loadPOEntries() {
  const tbody = document.getElementById('poEntriesBody');
  const emptyEl = document.getElementById('poEntriesEmpty');
  try {
    const r = await api('/api/po/entries', 'GET');
    const entries = r.entries || [];
    if (!entries.length) {
      tbody.innerHTML = '';
      emptyEl.style.display = 'block';
      emptyEl.textContent = 'No PO entries yet.';
      return;
    }
    emptyEl.style.display = 'none';
    tbody.innerHTML = entries.map(e => `
      <tr>
        <td>${e.orderBy||''}</td>
        <td>${e.partyName||''}</td>
        <td>${e.vendorName||''}</td>
        <td>${e.soNumber||''}</td>
        <td>${e.materialType||''}</td>
        <td>${e.styleNo||''}</td>
        <td>${e.qtyRequired||''}</td>
        <td>${e.price||''}</td>
        <td>${poDocCellHtml(e)}</td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = '';
    emptyEl.style.display = 'block';
    emptyEl.textContent = 'Load failed: ' + e.message;
  }
}

async function loadFMSTasks() {
  document.getElementById('fmsTasksRefreshBtn').style.display = 'block';
  const sel = document.getElementById('fmsTasksSelect');
  const trainContainer = document.getElementById('fmsTrainContainer');
  const stepPanel = document.getElementById('fmsTaskStepPanel');
  const emptyEl = document.getElementById('fmsTasksEmpty');

  sel.innerHTML = '<option value="">Loading...</option>';
  trainContainer.style.display = 'none';
  stepPanel.style.display = 'none';
  emptyEl.style.display = 'none';

  const list = await api('/api/fms-tasks');
  if (!list.length) {
    sel.innerHTML = '<option value="">-- No FMS available --</option>';
    emptyEl.style.display = 'block';
    return;
  }

  sel.innerHTML = '<option value="">-- Select an FMS --</option>' +
    list.map(f => `<option value="${f.id}">${f.fms_name || f.sheet_name}</option>`).join('');

  // Auto-select first
  if (list.length === 1) {
    sel.value = list[0].id;
    onFMSTasksSelect();
  }
}

async function onFMSTasksSelect() {
  const fmsId = document.getElementById('fmsTasksSelect').value;
  const trainContainer = document.getElementById('fmsTrainContainer');
  const stepPanel = document.getElementById('fmsTaskStepPanel');

  if (!fmsId) {
    trainContainer.style.display = 'none';
    stepPanel.style.display = 'none';
    return;
  }

  fmsTasksActiveFmsId = parseInt(fmsId);
  fmsTasksActiveStepId = null;
  stepPanel.style.display = 'none';
  trainContainer.style.display = 'block';

  document.getElementById('fmsTrainInner').innerHTML = '<div style="color:var(--muted-foreground);font-size:12px;padding:20px">Loading steps...</div>';

  const data = await api(`/api/fms-tasks/${fmsId}`);
  buildFMSTrain(data.steps, data.sheet);
}

function buildFMSTrain(steps, sheet) {
  window._fmsAllSteps = steps; // Store all steps for modal use
  const isAdmin = ME.role === 'admin';
  const uid = ME.id;

  // Build double set for infinite scroll loop
  const buildCoaches = () => steps.map((s, i) => {
    const isMine = isAdmin || s.isMyStep;
    const doerNames = (s.doers || []).map(d => d.name).join(', ') || '—';
    return `
      <div class="fms-coach ${isMine ? 'mine' : 'not-mine'}" 
           onclick="${isMine ? `selectFMSStep(${s.id},'${s.step_name.replace(/'/g,"\\'")}','${doerNames.replace(/'/g,"\\'")}')` : ''}"
           title="${isMine ? 'Click to view tasks' : 'Not your step'}">
        <div class="fms-coach-num">Step ${s.step_order}</div>
        <div class="fms-coach-name">${s.step_name}</div>
        <div class="fms-coach-doers">👤 ${doerNames}</div>
        ${isMine ? '<div style="font-size:9px;margin-top:4px;opacity:.7">▶ Click to open</div>' : '<div style="font-size:9px;margin-top:4px;opacity:.5">🔒 Not assigned</div>'}
      </div>
      ${i < steps.length - 1 ? '<div class="fms-coach-connector"></div>' : ''}`;
  }).join('');

  const engine = `
    <div class="fms-train-engine">
      🚂
      <div style="font-size:9px;margin-top:4px;opacity:.7;max-width:70px;text-align:center;word-break:break-word">${(document.getElementById('fmsTasksSelect').selectedOptions[0]?.text || '').substring(0,12)}</div>
    </div>
    <div class="fms-coach-connector"></div>`;

  // Double the coaches for seamless loop
  const coaches = buildCoaches();
  document.getElementById('fmsTrainInner').innerHTML = engine + coaches + '<div style="width:30px;flex-shrink:0"></div>' + coaches;

  // Set initial speed
  setTrainSpeed(document.getElementById('fmsTrainSpeedSlider').value);
}

function selectFMSStep(stepId, stepName, doerNames) {
  fmsTasksActiveStepId = stepId;
  // Store active step data for modal
  window._fmsActiveStepData = (window._fmsAllSteps || []).find(s => s.id === stepId) || null;

  // Highlight selected coach
  document.querySelectorAll('.fms-coach').forEach(c => {
    c.classList.toggle('active', c.querySelector('.fms-coach-name')?.textContent === stepName);
  });

  document.getElementById('fmsTaskStepName').textContent = stepName;
  document.getElementById('fmsTaskStepDoers').textContent = '👤 ' + doerNames;
  document.getElementById('fmsTaskRowCount').textContent = '';
  document.getElementById('fmsTaskRowsContainer').innerHTML = `
    <div class="empty" style="background:var(--card);border-radius:var(--radius);border:1px solid var(--border);box-shadow:var(--shadow-xs);">
      Click "Load Tasks" to fetch pending rows for this step
    </div>`;
  document.getElementById('fmsTaskStepPanel').style.display = 'block';
  document.getElementById('fmsTaskStepPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadFMSTaskRows() {
  if (!fmsTasksActiveFmsId || !fmsTasksActiveStepId) return;
  const btn = document.getElementById('fmsTaskLoadBtn');
  btn.textContent = '⏳ Loading...';
  btn.disabled = true;

  const r = await api(`/api/fms-tasks/${fmsTasksActiveFmsId}/steps/${fmsTasksActiveStepId}/rows`);
  btn.textContent = 'Refresh';
  btn.disabled = false;

  if (r.error) {
    showToast(r.error, 'error');
    return;
  }

  document.getElementById('fmsTaskRowCount').textContent = r.total ? `${r.total} pending row(s)` : '✅ All done!';

  // Filter banner — show if doer-name filtering is applied (or if admin viewing all)
  let banner = '';
  if (r.filtered) {
    banner = `<div style="background:#dbeafe;border:1px solid #93c5fd;color:#1e3a8a;padding:10px 14px;border-radius:8px;margin-bottom:12px;font-size:13px;">
      🎯 <b>Showing only your assigned rows</b> — filtered by Col ${r.doerColumn} (Doer Name).
      ${r.totalPending > r.total ? ` <span style="color:#475569">${r.totalPending - r.total} other row(s) belong to other doers.</span>` : ''}
    </div>`;
  } else if (r.isAdmin && r.doerColumn) {
    banner = `<div style="background:#fef3c7;border:1px solid #fcd34d;color:#92400e;padding:10px 14px;border-radius:8px;margin-bottom:12px;font-size:13px;">
      👑 <b>Admin view</b> — showing all ${r.totalPending} pending rows across all doers (Col ${r.doerColumn}).
    </div>`;
  }

  if (!r.rows || !r.rows.length) {
    document.getElementById('fmsTaskRowsContainer').innerHTML = banner + `
      <div class="empty" style="background:var(--card);border-radius:var(--radius);border:1px solid var(--border);box-shadow:var(--shadow-xs);">
        ${r.filtered ? '✅ No rows assigned to you in this step!' : '✅ No pending rows — all actual values filled for this step!'}
      </div>`;
    return;
  }

  // Build table headers from first row's data keys
  const colKeys = Object.keys(r.rows[0].data);
  const tableRows = r.rows.map((row, ri) => `
    <tr ${row.isMine === false && r.isAdmin ? 'style="opacity:.85"' : ''}>
      <td>
        <button class="fms-done-btn" onclick="openFMSDoneModal(${ri})">✅ Done</button>
      </td>
      ${colKeys.map(k => `<td>${row.data[k] || '—'}</td>`).join('')}
      <td>
        <span class="fms-status-badge">⏳ Pending</span>
        ${row.rowDoerName && r.isAdmin ? `<br><span style="font-size:10px;color:var(--muted-foreground);margin-top:4px;display:inline-block">→ ${row.rowDoerName}</span>` : ''}
      </td>
    </tr>`).join('');

  document.getElementById('fmsTaskRowsContainer').innerHTML = banner + `
    <div class="fms-step-rows-table">
      <table>
        <thead><tr>
          <th>Action</th>
          ${colKeys.map(k => `<th>${k}</th>`).join('')}
          <th>Status</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;

  // Store rows in memory for modal
  window._fmsCurrentRows = r.rows;
}

function openFMSDoneModal(rowIdx) {
  const row = window._fmsCurrentRows[rowIdx];
  if (!row) return;

  document.getElementById('fmsDoneFmsId').value = fmsTasksActiveFmsId;
  document.getElementById('fmsDoneStepId').value = fmsTasksActiveStepId;
  document.getElementById('fmsDoneRowNum').value = row.sheetRowNumber;
  document.getElementById('fmsDonePlanVal').value = row.planValue;
  document.getElementById('fmsDoneErr').style.display = 'none';
  document.getElementById('fmsDoneDelaySection').style.display = 'none';
  document.getElementById('fmsDoneDelayReason').value = '';

  // Show row data
  const colKeys = Object.keys(row.data);
  document.getElementById('fmsDoneRowPreview').innerHTML = colKeys.map(k =>
    `<div style="display:flex;gap:8px;margin-bottom:4px"><span style="font-size:11px;font-weight:600;color:var(--muted-foreground);min-width:120px;flex-shrink:0">${k}</span><span style="color:var(--foreground)">${row.data[k]||'—'}</span></div>`
  ).join('');

  // Set plan display
  document.getElementById('fmsDonePlanDisplay').textContent = row.planValue || '—';

  // What saving will actually do. On a sheet that derives the actual date from a
  // checkbox, the app ticks that checkbox and the sheet fills the date — so
  // showing a timestamp here would promise something it does not write.
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const actualStr = `${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const completeCol = (window._fmsActiveStepData || {}).complete_col || '';
  document.getElementById('fmsDoneActualDisplay').textContent = completeCol
    ? `✓ tick "${completeCol}" — the sheet fills the date itself`
    : actualStr;

  // Check delay: actual > plan = delayed
  const planVal = (row.planValue || '').trim();
  let isDelayed = false;
  try {
    // Try various date formats: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, DD-MM-YYYY HH:MM:SS
    let planDate;
    const ddmmyyyy = planVal.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(.*)?$/);
    const yyyymmdd = planVal.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(.*)?$/);
    if (ddmmyyyy) {
      const [, d, m, y, time=''] = ddmmyyyy;
      planDate = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}${time.replace(' ','T')||'T23:59:59'}`);
    } else if (yyyymmdd) {
      planDate = new Date(planVal);
    }
    if (planDate && !isNaN(planDate.getTime()) && now > planDate) isDelayed = true;
  } catch(e) {}

  document.getElementById('fmsDoneDelaySection').style.display = isDelayed ? 'block' : 'none';
  document.getElementById('fmsDoneDelayReason').value = '';

  // Populate extra input fields based on step configuration
  const activeStep = window._fmsActiveStepData;
  const extraRows = (activeStep && activeStep.extraRows) ? activeStep.extraRows.filter(r => r.col_letter) : [];
  const extraSection = document.getElementById('fmsDoneExtraSection');
  const extraFieldsEl = document.getElementById('fmsDoneExtraFields');
  if (extraRows.length > 0) {
    const inputStyle = 'width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;font-family:var(--font-sans);outline:none;box-sizing:border-box';
    extraFieldsEl.innerHTML = extraRows.map((r, i) => {
      const label = r.label || r.row_label || r.col_letter || `Field ${i+1}`;
      let inputHtml;
      switch(r.field_type || 'text') {
        case 'number':
          inputHtml = `<input type="number" id="fmsExtra_${i}" placeholder="Enter number..." style="${inputStyle}"/>`;
          break;
        case 'date':
          inputHtml = `<input type="date" id="fmsExtra_${i}" style="${inputStyle}"/>`;
          break;
        case 'link':
          inputHtml = `<input type="url" id="fmsExtra_${i}" placeholder="https://..." style="${inputStyle}"/>`;
          break;
        case 'file':
          // Uploaded on save; the cell receives the Drive link.
          inputHtml = `<input type="file" id="fmsExtra_${i}" style="${inputStyle};padding:7px 10px"/>`;
          break;
        case 'dropdown': {
          const rawOpts = (r.dropdown_options || '').split(',').map(o => o.trim()).filter(Boolean);
          const optionsList = rawOpts.length
            ? rawOpts.map(o => `<option value="${o}">${o}</option>`).join('')
            : '<option value="">-- No options configured --</option>';
          inputHtml = `<select id="fmsExtra_${i}" style="${inputStyle};background:var(--card)"><option value="">-- Select --</option>${optionsList}</select>`;
          break;
        }
        default:
          inputHtml = `<input type="text" id="fmsExtra_${i}" placeholder="Enter value..." style="${inputStyle}"/>`;
      }
      const isRequired = !(r.required === 0 || r.required === false || r.required === '0');
      const requiredTag = isRequired
        ? '<span style="color:#ef4444">*</span>'
        : '<span style="color:var(--faint);font-size:10px;font-weight:600">(optional)</span>';
      return `<div style="margin-bottom:12px">
        <label style="font-size:12px;font-weight:600;color:var(--muted-foreground);display:block;margin-bottom:4px">${label} ${requiredTag} <span style="color:var(--faint);font-weight:400">(COL ${r.col_letter})</span></label>
        ${inputHtml}
      </div>`;
    }).join('');
    extraSection.style.display = 'block';
  } else {
    extraSection.style.display = 'none';
    extraFieldsEl.innerHTML = '';
  }

  document.getElementById('fmsDoneModal').classList.add('open');
}

// (delay reason is now a plain text input — no dropdown listener needed)

async function saveFMSDone() {
  const fmsId = document.getElementById('fmsDoneFmsId').value;
  const stepId = document.getElementById('fmsDoneStepId').value;
  const rowNum = document.getElementById('fmsDoneRowNum').value;
  const actualValue = document.getElementById('fmsDoneActualDisplay').textContent;
  const errEl = document.getElementById('fmsDoneErr');
  errEl.style.display = 'none';

  const delaySection = document.getElementById('fmsDoneDelaySection');
  let delayReason = '';
  if (delaySection.style.display !== 'none') {
    delayReason = document.getElementById('fmsDoneDelayReason').value.trim();
    if (!delayReason) { errEl.textContent = 'A delay reason is required!'; errEl.style.display = 'block'; return; }
  }

  const saveBtn = document.getElementById('fmsDoneSaveBtn') || document.querySelector('#fmsDoneModal .btn-green');
  saveBtn.textContent = '⏳ Saving...';
  saveBtn.disabled = true;

  // Collect extra input values — mandatory check only for `required` fields
  const activeStep = window._fmsActiveStepData;
  const extraRows = (activeStep && activeStep.extraRows) ? activeStep.extraRows.filter(r => r.col_letter) : [];
  for (let i = 0; i < extraRows.length; i++) {
    const r = extraRows[i];
    const isRequired = !(r.required === 0 || r.required === false || r.required === '0');
    const el = document.getElementById(`fmsExtra_${i}`);
    const val = el ? (el.type === 'file' ? (el.files && el.files.length ? 'file' : '') : el.value.trim()) : '';
    if (isRequired && !val) {
      const label = r.label || r.row_label || r.col_letter || `Field ${i+1}`;
      errEl.textContent = `"${label}" field is required!`;
      errEl.style.display = 'block';
      saveBtn.textContent = '💾 Save to Sheet';
      saveBtn.disabled = false;
      if (el) { el.style.border = '1.5px solid #ef4444'; el.focus(); }
      return;
    } else {
      if (el) el.style.border = '1.5px solid var(--border)';
    }
  }
  // rowId is what the server maps back to a column. The letter goes along only
  // so an older server still understands the request; the sheet may have moved
  // since this page loaded, and the row id survives that.
  const extraInputs = [];
  for (let i = 0; i < extraRows.length; i++) {
    const r = extraRows[i];
    const el = document.getElementById(`fmsExtra_${i}`);
    if (!el) continue;
    let value = '';
    if (el.type === 'file') {
      if (!el.files || !el.files.length) continue;
      saveBtn.textContent = '⏳ Uploading...';
      try {
        const fd = new FormData();
        fd.append('file', el.files[0]);
        const up = await fetch('/api/fms-tasks/upload', { method: 'POST', credentials: 'include', body: fd });
        const j = await up.json();
        if (!up.ok || j.error) throw new Error(j.error || 'Upload failed');
        value = j.url;
      } catch (err) {
        errEl.textContent = `Upload failed for "${r.label || r.col_letter}": ${err.message}`;
        errEl.style.display = 'block';
        saveBtn.textContent = '💾 Save to Sheet';
        saveBtn.disabled = false;
        return;
      }
    } else {
      value = el.value.trim();
    }
    if (value === '') continue;
    extraInputs.push({ rowId: r.id, colLetter: r.col_letter, value });
  }
  saveBtn.textContent = '⏳ Saving...';

  const r = await api(`/api/fms-tasks/${fmsId}/steps/${stepId}/done`, 'POST', {
    rowNumber: parseInt(rowNum),
    actualValue,
    delayReason,
    extraInputs
  });

  saveBtn.textContent = '💾 Save to Sheet';
  saveBtn.disabled = false;

  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }

  closeModal('fmsDoneModal');
  showToast('✅ Saved to Google Sheet!');
  // Reload rows
  loadFMSTaskRows();
}

function setTrainSpeed(val) {
  const dur = parseInt(val);
  document.getElementById('fmsTrainSpeedLabel').textContent = dur + 's';
  const scroll = document.getElementById('fmsTrainInner');
  if (scroll) {
    scroll.style.setProperty('--train-dur', dur + 's');
    scroll.style.animationDuration = dur + 's';
  }
  const track = document.getElementById('fmsTrainTrack');
  if (track) track.style.setProperty('--train-dur', dur + 's');
}

function toggleTrainPause() {
  fmsTrainPaused = !fmsTrainPaused;
  const scroll = document.getElementById('fmsTrainInner');
  const btn = document.getElementById('fmsTrainPauseBtn');
  if (scroll) scroll.style.animationPlayState = fmsTrainPaused ? 'paused' : 'running';
  if (btn) btn.textContent = fmsTrainPaused ? '▶ Play' : '⏸ Pause';
}

// ══════════════════════════════════════════════════════
// BULK DELETE
// ══════════════════════════════════════════════════════
let _bdFromUserId = null;
let _bdDateTasks = [];

async function openBulkDeleteModal() {
  document.getElementById('bulkDeleteErr').style.display = 'none';
  document.getElementById('bdStep1').style.display = 'none';
  document.getElementById('bdStep2').style.display = 'none';
  document.getElementById('bdStep3').style.display = 'none';
  document.getElementById('bdCancelBtn').style.display = 'block';
  document.getElementById('bdDate').value = '';
  document.getElementById('bdTasksList').innerHTML = '';
  _bdFromUserId = null;
  _bdDateTasks = [];

  const isAdmin = ME.role === 'admin';
  const isHod = ME.role === 'hod';

  if (isAdmin || isHod) {
    const allUsers = await api('/api/users');
    const eligible = isAdmin
      ? allUsers
      : allUsers.filter(u => u.department === ME.department);
    document.getElementById('bdFromUser').innerHTML =
      '<option value="">-- Select user --</option>' +
      eligible.map(u=>`<option value="${u.id}">${u.name} — ${u.email} (${u.department||u.role})</option>`).join('');
    document.getElementById('bdStep1').style.display = 'block';

    // Checklist series section: admin only
    if (isAdmin) {
      document.getElementById('bdYearSection').style.display = 'block';
      // Populate user dropdown
      document.getElementById('bdYearUser').innerHTML =
        '<option value="">-- Select Employee --</option>' +
        eligible.filter(u => u.role !== 'admin').map(u=>`<option value="${u.id}" data-email="${u.email}">${u.name}</option>`).join('');
      document.getElementById('bdYearUserEmail').style.display = 'none';
      // Series picker reset
      _bdChkGroups = [];
      _bdChkSel.clear();
      document.getElementById('bdChkSearch').value = '';
      document.getElementById('bdChkList').innerHTML = '';
      document.getElementById('bdChkScope').value = 'all';
      document.getElementById('bdChkWrap').style.display = 'none';
      document.getElementById('bdChkEmpty').style.display = 'none';
    } else {
      document.getElementById('bdYearSection').style.display = 'none';
    }
  } else {
    _bdFromUserId = ME.id;
    document.getElementById('bdStep2').style.display = 'block';
    document.getElementById('bdYearSection').style.display = 'none';
  }
  document.getElementById('bulkDeleteModal').classList.add('open');
}

async function onBdFromChange() {
  const val = document.getElementById('bdFromUser').value;
  if (!val) return;
  _bdFromUserId = parseInt(val);
  document.getElementById('bdStep2').style.display = 'block';
  document.getElementById('bdDate').value = '';
  document.getElementById('bdStep3').style.display = 'none';
}

async function onBdDateChange() {
  const date = document.getElementById('bdDate').value;
  if (!date || !_bdFromUserId) return;

  document.getElementById('bulkDeleteErr').style.display = 'none';
  document.getElementById('bdTasksList').innerHTML = '<div style="padding:10px;color:var(--faint);font-size:13px">Loading...</div>';
  document.getElementById('bdStep3').style.display = 'block';
  document.getElementById('bdCancelBtn').style.display = 'none';
  document.getElementById('bdDateLabel').textContent = date;

  // Fetch tasks for this user on this date
  const [delData, chlData] = await Promise.all([
    api('/api/tasks?type=delegation'),
    api('/api/tasks?type=checklist')
  ]);

  const allTasks = [];
  const pick = (data, type) => {
    const list = data.grouped
      ? (data.grouped.find(g => g.userId === _bdFromUserId)?.tasks || [])
      : (data.tasks || []);
    list.forEach(t => { if (t.due_date === date) allTasks.push({...t, taskType: type}); });
  };
  pick(delData, 'delegation');
  pick(chlData, 'checklist');
  _bdDateTasks = allTasks;

  if (!allTasks.length) {
    document.getElementById('bdTasksList').innerHTML =
      '<div style="padding:12px;color:var(--faint);font-size:13px;text-align:center">No tasks on this date</div>';
    return;
  }

  document.getElementById('bdTasksList').innerHTML = allTasks.map((t,i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border)">
      <input type="checkbox" class="bd-cb" data-idx="${i}" checked
        style="width:15px;height:15px;accent-color:#dc2626;cursor:pointer;flex-shrink:0"/>
      <span style="font-size:13px;flex:1">${t.description||'—'}</span>
      <span style="font-size:11px;background:${t.status==='pending'?'#fef2f2':'#f0fdf4'};color:${t.status==='pending'?'#dc2626':'#16a34a'};padding:2px 7px;border-radius:8px;font-weight:600">${t.status}</span>
      <span style="font-size:11px;background:#eff6ff;color:#1d4ed8;padding:2px 7px;border-radius:8px;font-weight:600">${t.taskType}</span>
    </div>`).join('');
}

async function _doBulkDelete(tasks) {
  if (!tasks.length) {
    document.getElementById('bulkDeleteErr').textContent = 'No tasks selected';
    document.getElementById('bulkDeleteErr').style.display = 'block';
    return;
  }
  if (!confirm(`Are you sure you want to permanently delete ${tasks.length} task(s)?`)) return;

  let deleted = 0;
  for (const t of tasks) {
    const r = await api(`/api/tasks/${t.id}?type=${t.taskType}`, 'DELETE');
    if (!r.error) deleted++;
  }

  closeModal('bulkDeleteModal');
  showToast(`🗑 ${deleted} task(s) deleted!`);
  loadAllTasks();
}

async function bulkDeleteAll() { await _doBulkDelete(_bdDateTasks); }

async function bulkDeleteSelected() {
  const checked = [...document.querySelectorAll('.bd-cb:checked')];
  await _doBulkDelete(checked.map(cb => _bdDateTasks[parseInt(cb.dataset.idx)]).filter(Boolean));
}

// ── Checklist series (grouped) delete ──────────────────
// One "checklist" = an entire recurring series sharing the same name. The admin
// picks which ones to delete — the rest are left untouched.
let _bdChkGroups = [];
const _bdChkSel = new Set();

function bdChkKey(g) { return (g.description || '') + '||' + (g.frequency || ''); }

const _bdFreqLabel = Object.fromEntries(CHECKLIST_FREQS.map(f => [f.value, f.value === 'alternative_week' ? 'Alt. Week' : f.label]));

async function onBdYearUserChange() {
  const sel = document.getElementById('bdYearUser');
  const opt = sel.options[sel.selectedIndex];
  const email = opt?.dataset?.email || '';
  const emailDiv = document.getElementById('bdYearUserEmail');
  const emailText = document.getElementById('bdYearUserEmailText');
  if (opt?.value && email) {
    emailText.textContent = email;
    emailDiv.style.display = 'block';
  } else {
    emailDiv.style.display = 'none';
  }

  _bdChkGroups = [];
  _bdChkSel.clear();
  document.getElementById('bdChkSearch').value = '';
  document.getElementById('bdChkWrap').style.display = 'none';
  document.getElementById('bdChkEmpty').style.display = 'none';

  const userId = sel.value;
  if (!userId) return;

  document.getElementById('bdChkList').innerHTML = '<div style="padding:10px;color:var(--faint);font-size:13px">Loading…</div>';
  document.getElementById('bdChkWrap').style.display = 'block';

  const data = await api(`/api/tasks/checklist-groups?userId=${userId}`);
  if (data.error) {
    document.getElementById('bdChkList').innerHTML =
      `<div style="padding:10px;color:#dc2626;font-size:13px">Error: ${dtEscape(data.error)}</div>`;
    return;
  }

  _bdChkGroups = data.groups || [];
  if (!_bdChkGroups.length) {
    document.getElementById('bdChkWrap').style.display = 'none';
    document.getElementById('bdChkEmpty').style.display = 'block';
    return;
  }
  renderBdChecklistGroups();
}

function renderBdChecklistGroups() {
  const q = (document.getElementById('bdChkSearch')?.value || '').toLowerCase().trim();
  const list = document.getElementById('bdChkList');

  const rows = _bdChkGroups
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => !q || (g.description || '').toLowerCase().includes(q));

  if (!rows.length) {
    list.innerHTML = '<div style="padding:12px;color:var(--faint);font-size:13px;text-align:center">No matches found</div>';
    updateBdChkCount();
    return;
  }

  list.innerHTML = rows.map(({ g, i }) => {
    const key = bdChkKey(g);
    const checked = _bdChkSel.has(key) ? 'checked' : '';
    const freq = g.frequency ? (_bdFreqLabel[g.frequency] || g.frequency) : '—';
    const endTxt = g.end_date ? `End: ${g.end_date}` : `Last: ${g.last_date || '—'}`;
    return `
    <div style="display:flex;align-items:flex-start;gap:9px;padding:9px 10px;border-bottom:1px solid var(--border)">
      <input type="checkbox" class="bd-chk-cb" data-idx="${i}" ${checked} onchange="bdChkToggle(this)"
        style="width:15px;height:15px;accent-color:#dc2626;cursor:pointer;flex-shrink:0;margin-top:2px"/>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--foreground);word-break:break-word">${dtEscape(g.description || '—')}</div>
        <div style="font-size:11px;color:var(--muted-foreground);margin-top:3px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <span style="background:#eff6ff;color:#1d4ed8;padding:1px 7px;border-radius:8px;font-weight:600">${freq}</span>
          <span>${g.start_date || '—'} → ${g.last_date || '—'}</span>
          <span style="color:var(--faint)">·</span>
          <span>${endTxt}</span>
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0;font-size:11px;line-height:1.6">
        <div style="font-weight:700;color:var(--foreground)">${g.total} tasks</div>
        <div style="color:#dc2626">${g.pending} pending</div>
        <div style="color:#16a34a">${g.completed} done</div>
      </div>
    </div>`;
  }).join('');

  updateBdChkCount();
}

function bdChkToggle(cb) {
  const g = _bdChkGroups[parseInt(cb.dataset.idx)];
  if (!g) return;
  const key = bdChkKey(g);
  if (cb.checked) _bdChkSel.add(key); else _bdChkSel.delete(key);
  updateBdChkCount();
}

function bdChkToggleAll(state) {
  // Applies only to the rows currently on screen (i.e. after the search filter)
  document.querySelectorAll('.bd-chk-cb').forEach(cb => {
    cb.checked = !!state;
    bdChkToggle(cb);
  });
}

function updateBdChkCount() {
  const el = document.getElementById('bdChkCount');
  if (!el) return;
  const selected = _bdChkGroups.filter(g => _bdChkSel.has(bdChkKey(g)));
  const tasks = selected.reduce((s, g) => s + (parseInt(g.total) || 0), 0);
  el.textContent = selected.length
    ? `${selected.length} selected (${tasks} tasks)`
    : `${_bdChkGroups.length} checklist mili`;
}

async function _runChecklistGroupDelete(groups) {
  const sel = document.getElementById('bdYearUser');
  const userId = sel.value;
  if (!userId) { alert('Please select an employee first!'); return; }
  if (!groups.length) { alert('Kam se kam ek checklist select karein!'); return; }

  const userName = sel.options[sel.selectedIndex].text;
  const scope = document.getElementById('bdChkScope').value;
  const scopeTxt = scope === 'future' ? 'Only pending tasks from today onward' : 'Entire checklist (history + future)';

  const names = groups.slice(0, 8).map(g => ` • ${g.description}`).join('\n')
    + (groups.length > 8 ? `\n • …aur ${groups.length - 8} aur` : '');
  const totalTasks = groups.reduce((s, g) => s + (parseInt(scope === 'future' ? g.upcoming : g.total) || 0), 0);

  const ok = confirm(
    `⚠️ CONFIRM DELETE\n\nEmployee: ${userName}\nScope: ${scopeTxt}\n\n${groups.length} checklists will be deleted:\n${names}\n\n≈ ${totalTasks} task rows will be permanently deleted!\n\nProceed?`
  );
  if (!ok) return;

  const result = await api('/api/tasks/checklist-group-delete', 'POST', {
    userId: parseInt(userId),
    scope,
    groups: groups.map(g => ({ description: g.description, frequency: g.frequency || '' }))
  });
  if (result.error) { alert('Error: ' + result.error); return; }

  showToast(`🗑 ${result.deleted} checklist task(s) deleted — ${userName}`);
  _bdChkSel.clear();
  await onBdYearUserChange();   // list refresh — baaki checklists dikhti rahengi
  loadAllTasks();
}

async function deleteSelectedChecklists() {
  await _runChecklistGroupDelete(_bdChkGroups.filter(g => _bdChkSel.has(bdChkKey(g))));
}

async function deleteAllChecklists() {
  if (!_bdChkGroups.length) { alert('No checklists found!'); return; }
  await _runChecklistGroupDelete(_bdChkGroups.slice());
}


// The admin "WhatsApp Reminder" preview/test panel was removed from All Tasks.
// The daily 10 AM job itself is untouched — it runs on the server's schedule,
// and /api/whatsapp/checklist-daily-preview and -run are still there for a
// manual trigger if one is ever needed again.

let _transferFromUserId = null;
let _transferDateTasks = [];

async function openNewTransferModal() {
  document.getElementById('transferErr').style.display = 'none';
  document.getElementById('transferStep1').style.display = 'none';
  document.getElementById('transferStep2').style.display = 'none';
  document.getElementById('transferStep3').style.display = 'none';
  document.getElementById('transferCancelBtn').style.display = 'block';
  document.getElementById('transferDate').value = '';
  document.getElementById('transferTasksListNew').innerHTML = '';
  document.getElementById('transferToUser').innerHTML = '<option value="">-- Select user --</option>';
  _transferFromUserId = null;
  _transferDateTasks = [];

  const isAdmin = ME.role === 'admin';
  const isHod = ME.role === 'hod';

  if (isAdmin || isHod) {
    const allUsers = await api('/api/users');
    const eligible = isAdmin
      ? allUsers
      : allUsers.filter(u => u.department === ME.department && u.id !== ME.id);
    document.getElementById('transferFromUser').innerHTML =
      '<option value="">-- Select user --</option>' +
      eligible.map(u=>`<option value="${u.id}">${u.name} (${u.department||u.role})</option>`).join('');
    document.getElementById('transferStep1').style.display = 'block';
  } else {
    _transferFromUserId = ME.id;
    document.getElementById('transferStep2').style.display = 'block';
  }
  document.getElementById('transferModal').classList.add('open');
}

async function onTransferFromChange() {
  const val = document.getElementById('transferFromUser').value;
  if (!val) return;
  _transferFromUserId = parseInt(val);
  document.getElementById('transferStep2').style.display = 'block';
  document.getElementById('transferDate').value = '';
  document.getElementById('transferStep3').style.display = 'none';
}

async function onTransferDateChange() {
  const date = document.getElementById('transferDate').value;
  if (!date || !_transferFromUserId) return;

  document.getElementById('transferErr').style.display = 'none';
  document.getElementById('transferTasksListNew').innerHTML =
    '<div style="padding:10px;color:var(--faint);font-size:13px">Loading...</div>';
  document.getElementById('transferStep3').style.display = 'block';
  document.getElementById('transferCancelBtn').style.display = 'none';
  document.getElementById('transferDateLabel').textContent = date;

  const [delData, chlData] = await Promise.all([
    api('/api/tasks?type=delegation'),
    api('/api/tasks?type=checklist')
  ]);

  const allTasks = [];
  const pick = (data, type) => {
    const list = data.grouped
      ? (data.grouped.find(g => g.userId === _transferFromUserId)?.tasks || [])
      : (data.tasks || []);
    // Anything not finished is transferable. Matching on status==='pending'
    // silently hid revised tasks, which are still open work someone has to do.
    list.forEach(t => { if (t.due_date === date && t.status !== 'completed') allTasks.push({...t, taskType: type}); });
  };
  pick(delData, 'delegation');
  pick(chlData, 'checklist');
  _transferDateTasks = allTasks;

  if (!allTasks.length) {
    document.getElementById('transferTasksListNew').innerHTML =
      '<div style="padding:12px;color:var(--faint);font-size:13px;text-align:center">No open tasks on this date</div>';
  } else {
    const pendingRes = await api('/api/transfers/pending-tasks');
    const pendingIds = new Set((pendingRes||[]).map(p=>`${p.task_type}_${p.task_id}`));
    document.getElementById('transferTasksListNew').innerHTML = allTasks.map((t,i) => {
      const isPending = pendingIds.has(`${t.taskType}_${t.id}`);
      return `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border)">
        ${isPending
          ? `<span style="font-size:10px;background:#fef9c3;color:#92400e;padding:2px 7px;border-radius:10px;font-weight:600;border:1px solid #fde68a;white-space:nowrap">⏳ Sent</span>`
          : `<input type="checkbox" class="tr-date-cb" data-idx="${i}" checked
              style="width:15px;height:15px;accent-color:#7c3aed;cursor:pointer;flex-shrink:0"/>`}
        <span style="font-size:13px;flex:1">${t.description||'—'}</span>
        <span style="font-size:11px;background:#eff6ff;color:#1d4ed8;padding:2px 7px;border-radius:8px;font-weight:600">${t.taskType}</span>
      </div>`;
    }).join('');
  }

  const allUsers = await api('/api/users');
  const eligible = (ME.role === 'hod')
    ? allUsers.filter(u => u.department === ME.department && u.id !== _transferFromUserId)
    : allUsers.filter(u => u.id !== _transferFromUserId);
  document.getElementById('transferToUser').innerHTML =
    '<option value="">-- Select user --</option>' +
    eligible.map(u=>`<option value="${u.id}">${u.name} (${u.department||u.role})</option>`).join('');
}

async function _doTransfer(tasks) {
  const err = document.getElementById('transferErr');
  err.style.display = 'none';
  const toUserId = document.getElementById('transferToUser').value;
  if (!toUserId) { err.textContent='Please select a "Transfer To" user'; err.style.display='block'; return; }
  if (!tasks.length) { err.textContent='No tasks selected'; err.style.display='block'; return; }
  const r = await api('/api/transfers','POST',{
    tasks: tasks.map(t => ({ taskId: t.id, taskType: t.taskType })),
    toUserId: parseInt(toUserId)
  });
  if (r.error) { err.textContent = r.error; err.style.display='block'; return; }
  closeModal('transferModal');
  if (r.count > 0) showToast(`✅ ${r.count} transfer request(s) sent for approval!`);
  else showToast('⚠️ All tasks already have a pending transfer request!', 'error');
  loadTransferBadge();
}

async function submitTransferAll() { await _doTransfer(_transferDateTasks); }
async function submitTransferSelected() {
  const checked = [...document.querySelectorAll('.tr-date-cb:checked')];
  await _doTransfer(checked.map(cb => _transferDateTasks[parseInt(cb.dataset.idx)]).filter(Boolean));
}

async function loadTransferBadge() {
  if (ME.role !== 'admin' && ME.role !== 'hod') return;
  try {
    const d = await api('/api/transfers/count');
    const badge = document.getElementById('transferBadge');
    if (badge) { badge.textContent = d.count||0; badge.style.display = d.count>0 ? 'flex' : 'none'; }
    const tabBadge = document.getElementById('apprTransferBadge');
    if (tabBadge) {
      if ((d.count||0) > 0) { tabBadge.textContent = d.count; tabBadge.style.display = 'inline-block'; }
      else tabBadge.style.display = 'none';
    }
  } catch(e) {}
}

async function loadTransferApprovals() {
  const container = document.getElementById('transferApprovalsContent');
  if (!container) return;
  const transfers = await api('/api/transfers');
  if (!transfers.length) { container.innerHTML=`<div class="empty">✅ No pending transfer requests!</div>`; return; }
  container.innerHTML = `
    <table>
      <thead><tr><th>Task</th><th>Type</th><th>From</th><th>To</th><th>Requested By</th><th>Date</th><th>Action</th></tr></thead>
      <tbody>
        ${transfers.map(t=>`<tr>
          <td style="font-size:12px;max-width:180px">${t.description}</td>
          <td><span class="status-badge pending" style="font-size:10px">${t.task_type}</span></td>
          <td style="font-weight:600">${t.fromUserName}</td>
          <td style="color:#7c3aed;font-weight:600">${t.toUserName}</td>
          <td style="color:var(--muted-foreground);font-size:12px">${t.requestedByName}</td>
          <td style="color:var(--muted-foreground);font-size:12px">${new Date(t.created_at).toLocaleDateString('en-IN')}</td>
          <td>
            <button class="action-btn done" onclick="handleTransfer(${t.id},'approved')">✅ Approve</button>
            <button class="action-btn delete" style="margin-left:4px" onclick="handleTransfer(${t.id},'rejected')">❌ Reject</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

async function handleTransfer(id, action) {
  const note = action === 'rejected' ? prompt('Reason (optional):') : '';
  await api(`/api/transfers/${id}`,'PUT',{ action, note: note||'' });
  showToast(action === 'approved' ? '✅ Transfer approved!' : '❌ Transfer rejected!');
  loadTransferApprovals();
  loadTransferBadge();
}

// ══════════════════════════════════════════════════════
// 🏢 CLIENT MASTER (admin)
// ══════════════════════════════════════════════════════

async function loadClients(){
  const wrap = document.getElementById('cmListWrap');
  wrap.innerHTML = '<div class="empty">Loading projects…</div>';
  CM_OPEN_ID = null;
  try {
    const clients = await api('/api/clients');
    if (!clients || !clients.length) {
      wrap.innerHTML = '<div class="empty">No projects yet — add one above.</div>';
      return;
    }
    let html = '';
    for (const c of clients) {
      const safeName = dtEscape(c.name);
      html += `<div class="cm-client-row" data-cm-id="${c.id}">
        <div class="cm-client-info">
          <span class="cm-client-name">${safeName}</span>
        </div>
        <button class="cm-client-del" onclick="cmDelete(${c.id},'${safeName}')">Remove</button>
      </div>`;
    }
    wrap.innerHTML = html;
  } catch(e) {
    wrap.innerHTML = '<div class="empty">Failed to load projects</div>';
  }
}

async function cmAdd(){
  const inp = document.getElementById('cmNewClient');
  const name = inp.value.trim();
  if (!name) { showToast('Enter project name', 'error'); return; }
  try {
    const r = await api('/api/clients', 'POST', { name });
    if (r.error) showToast(r.error, 'error');
    else { showToast('✅ Project added'); inp.value = ''; loadClients(); }
  } catch(e) { showToast('Failed to add', 'error'); }
}

async function cmDelete(id, name){
  if (!confirm(`Remove client "${name}"?`)) return;
  try {
    await api('/api/clients/' + id, 'DELETE');
    showToast('🗑 Project removed');
    loadClients();
  } catch(e) { showToast('Failed to delete', 'error'); }
}

// Download sample CSV
function cmDownloadSample() {
  const csv = `client_name\nVibes\nCCIS\nParty Walls\nA1 India\nKala Textiles`;
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'projects_sample.csv';
  a.click();
  showToast('✅ Sample downloaded');
}

// Bulk upload clients via CSV
async function cmBulkUpload() {
  const fileInput = document.getElementById('cmBulkFile');
  const file = fileInput.files[0];
  if (!file) { showToast('Choose a CSV file first', 'error'); return; }

  try {
    const text = await file.text();
    // Parse: split by newlines, take first column (handles plain list or CSV with header)
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);
    if (!lines.length) { showToast('CSV file is empty', 'error'); return; }

    // Skip first row if it looks like a header. Old client_* spellings stay accepted so CSVs made before the rename still import.
    let names = lines.map(line => line.split(',')[0].trim().replace(/^["']|["']$/g, ''));
    const firstLower = (names[0] || '').toLowerCase();
    if (['client_name', 'name', 'client name', 'clients', 'unit_name', 'unit name', 'units', 'project_name', 'project name', 'projects'].includes(firstLower)) {
      names = names.slice(1);
    }
    names = names.filter(n => n);
    if (!names.length) { showToast('No valid project names found in CSV', 'error'); return; }

    if (!confirm(`Upload ${names.length} client${names.length===1?'':'s'} from CSV?`)) return;

    const r = await api('/api/clients/bulk', 'POST', { names });
    if (r.error) { showToast(r.error, 'error'); return; }

    let msg = `✅ Added ${r.added} client${r.added===1?'':'s'}`;
    if (r.skipped) msg += ` · ⚠️ ${r.skipped} duplicate${r.skipped===1?'':'s'} skipped`;
    showToast(msg);

    // Show details if any skipped
    if (r.skipped && r.skippedNames && r.skippedNames.length) {
      console.log('Skipped (already exist):', r.skippedNames.join(', '));
    }
    fileInput.value = '';
    loadClients();
  } catch(e) {
    showToast('Failed to upload: ' + e.message, 'error');
  }
}

// ══════════════════════════════════════════════════════
// 🗓 LEAVE TRACKER
// ══════════════════════════════════════════════════════
const LEAVE_TYPE_LABEL = {
  full_day: 'Full Day Leave',
  half_day: 'Half Day Leave',
  work_from_home: 'Work From Home',
  extra_working: 'Extra Working'
};
const LEAVE_TYPE_ICON = {
  full_day: '🛌', half_day: '⏱', work_from_home: '🏠', extra_working: '⚡'
};
let LEAVE_DATA = [];
let LEAVE_TAB = 'mine';
let LEAVE_STATUS = '';
let LEAVE_PICKED_TYPE = '';
let LEAVE_DECIDE_ID = null;
// Calendar state
let LEAVE_CAL_VIEW = new Date(); // month being viewed
const LEAVE_SELECTED = new Map(); // dateStr -> hours (only meaningful for extra_working)

async function loadLeaves(){
  const wrap = document.getElementById('lvListWrap');
  wrap.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const qs = `?scope=${LEAVE_TAB}${LEAVE_STATUS ? '&status='+LEAVE_STATUS : ''}`;
    const [data, approverRes] = await Promise.all([
      api('/api/leaves' + qs),
      api('/api/leaves/my-approvers')
    ]);
    if (data.error) throw new Error(data.error);
    LEAVE_DATA = Array.isArray(data) ? data : [];
    lvRegisterPool(LEAVE_DATA);
    renderLeaves();
    // Show approver names in page header
    const approverLine = document.getElementById('lvApproverLine');
    if (approverLine && approverRes?.names) {
      approverLine.textContent = `Your approver${approverRes.names.includes(',') ? 's' : ''}: ${approverRes.names}`;
    }
  } catch(e){
    wrap.innerHTML = `<div class="empty" style="color:#dc2626">⚠️ ${dtEscape(e.message)}</div>`;
  }
  loadApprovalBadge();
}

function renderLeaves(){
  const wrap = document.getElementById('lvListWrap');
  if (!LEAVE_DATA.length) {
    wrap.innerHTML = '<div class="empty">No leave records yet.</div>';
    return;
  }
  const search = (document.getElementById('lvSearch')?.value || '').toLowerCase();
  let rows = LEAVE_DATA;
  if (search) {
    rows = rows.filter(r =>
      (r.user_name||'').toLowerCase().includes(search) ||
      (r.reason||'').toLowerCase().includes(search) ||
      (LEAVE_TYPE_LABEL[r.leave_type]||'').toLowerCase().includes(search)
    );
  }
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty">No leaves match the filters.</div>';
    return;
  }

  // Group by user_name
  const groups = {};
  for (const r of rows) {
    const key = r.user_id + '|' + r.user_name;
    if (!groups[key]) groups[key] = { name: r.user_name, dept: r.user_department, items: [] };
    groups[key].items.push(r);
  }

  let html = '';
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    html += `<div class="lv-user-group">
      <div class="lv-user-head">
        <span>${dtEscape(g.name)}</span>
        ${g.dept ? `<small>${dtEscape(g.dept)}</small>` : ''}
      </div>`;
    for (const r of g.items) {
      const dates = Array.isArray(r.dates) && r.dates.length
        ? r.dates : [{ date: r.from_date }];
      const dateLine = dates.map(d => {
        const dStr = fmtDate(d.date);
        return r.leave_type === 'extra_working' && d.hours
          ? `${dStr}<span class="lv-hours-pill">${d.hours}h</span>`
          : dStr;
      }).join(' · ');
      const countLabel = dates.length > 1
        ? `<span style="color:var(--faint);font-weight:500"> · ${dates.length} day${dates.length===1?'':'s'}</span>`
        : '';
      const canDelete = (r.user_id === ME.id && r.status === 'pending') || ME.role === 'admin';
      html += `<div class="lv-item">
        <div class="lv-item-main">
          <div class="lv-item-row1">
            <span class="lv-type-pill lv-type-${r.leave_type}">${LEAVE_TYPE_ICON[r.leave_type]||''} ${LEAVE_TYPE_LABEL[r.leave_type]||r.leave_type}</span>
            <span class="lv-status lv-status-${r.status}">${r.status}</span>
          </div>
          <div class="lv-item-reason">${dtEscape(r.reason)}</div>
          <div class="lv-item-meta">
            <b>Applied:</b> ${dtEscape((r.created_at||'').slice(0,16))}
            ${r.status === 'pending'
              ? (r.dept_hod_names ? ` · <b>Approver:</b> ${dtEscape(r.dept_hod_names)}` : (r.approver_name ? ` · <b>Approver:</b> ${dtEscape(r.approver_name)}` : ''))
              : (r.approver_name ? ` · <b>Decided by:</b> ${dtEscape(r.approver_name)}` : '')}
            ${r.decided_at ? ` · <b>Decided:</b> ${dtEscape(r.decided_at.slice(0,16))}` : ''}
            ${r.approver_note ? ` · <b>Note:</b> ${dtEscape(r.approver_note)}` : ''}
          </div>
        </div>
        <div class="lv-item-actions">
          <div class="lv-item-date">${dateLine}${countLabel}</div>
          ${canDelete ? `<div class="lv-item-btns"><button class="lv-btn-delete" onclick="deleteLeave(${r.id})">🗑 Delete</button></div>` : ''}
        </div>
      </div>`;
    }
    html += `</div>`;
  }
  wrap.innerHTML = html;
}

function lvSwitchTab(tab, el){
  LEAVE_TAB = tab;
  document.querySelectorAll('.lv-tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  loadLeaves();
}

function lvSetStatus(status, el){
  LEAVE_STATUS = status;
  document.querySelectorAll('.lv-pill').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  loadLeaves();
}

function openLeaveForm(){
  document.getElementById('leaveErr').style.display = 'none';
  // Timestamp
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const tsStr = `${pad(now.getDate())}-${months[now.getMonth()]}-${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  document.getElementById('lvTimestamp').value = tsStr;
  document.getElementById('lvEmpName').value = ME.name || '';
  document.getElementById('lvEmpEmail').value = ME.email || '';
  // Reset form
  document.querySelectorAll('#lvTypeGrid .lv-type-btn').forEach(b => b.classList.remove('active'));
  LEAVE_PICKED_TYPE = '';
  LEAVE_SELECTED.clear();
  LEAVE_CAL_VIEW = new Date();
  LEAVE_CAL_VIEW.setDate(1);
  lvRenderCalendar();
  lvRenderSelectedList();
  document.getElementById('lvReason').value = '';
  // Approver hint — show actual HOD names from API
  const hintBox = document.getElementById('lvApproverHint');
  const hintName = document.getElementById('lvApproverHintName');
  hintBox.style.display = 'block';
  hintName.textContent = '…';
  api('/api/leaves/my-approvers').then(r => {
    hintName.textContent = r?.names || 'HOD';
  }).catch(() => {
    if (ME.role === 'admin') hintName.textContent = 'Another Admin';
    else if (ME.role === 'hod' || ME.role === 'pc') hintName.textContent = 'Admin';
    else hintName.textContent = `HOD${ME.department ? ' — '+ME.department : ''}`;
  });
  document.getElementById('leaveModal').classList.add('open');
}

function lvPickType(type, el){
  LEAVE_PICKED_TYPE = type;
  document.querySelectorAll('#lvTypeGrid .lv-type-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  // Show / hide selected list (hours input panel)
  lvRenderSelectedList();
}

// ── Calendar render & navigation ──────────────────────
function lvCalNav(dir){
  LEAVE_CAL_VIEW.setMonth(LEAVE_CAL_VIEW.getMonth() + dir);
  lvRenderCalendar();
}

function lvDateKey(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function lvRenderCalendar(){
  const view = LEAVE_CAL_VIEW;
  const year = view.getFullYear();
  const month = view.getMonth();
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('lvCalMonthLabel').textContent = `${monthNames[month]} ${year}`;

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startWeekday = firstDay.getDay(); // 0=Sun
  const today = new Date(); today.setHours(0,0,0,0);
  const todayKey = lvDateKey(today);
  const minAllowed = new Date(today); minAllowed.setDate(minAllowed.getDate() - 33);

  let html = '';
  // Leading blanks
  for (let i = 0; i < startWeekday; i++) html += `<button type="button" class="lv-cal-day lv-cal-day-other" disabled></button>`;
  for (let d = 1; d <= lastDay.getDate(); d++) {
    const cur = new Date(year, month, d);
    const key = lvDateKey(cur);
    const isPast = cur < minAllowed;
    const isToday = key === todayKey;
    const isSelected = LEAVE_SELECTED.has(key);
    const classes = ['lv-cal-day'];
    if (isPast) classes.push('lv-cal-day-disabled');
    if (isToday && !isSelected) classes.push('lv-cal-day-today');
    if (isSelected) classes.push('lv-cal-day-selected');
    const dis = isPast ? 'disabled' : '';
    html += `<button type="button" class="${classes.join(' ')}" ${dis} onclick="lvToggleDate('${key}')">${d}</button>`;
  }
  document.getElementById('lvCalGrid').innerHTML = html;

  // Count
  const cnt = LEAVE_SELECTED.size;
  document.getElementById('lvCalCount').textContent =
    cnt === 0 ? '0 dates selected' : `${cnt} date${cnt===1?'':'s'} selected`;
}

function lvToggleDate(key){
  if (LEAVE_SELECTED.has(key)) {
    LEAVE_SELECTED.delete(key);
  } else {
    LEAVE_SELECTED.set(key, '');
  }
  lvRenderCalendar();
  lvRenderSelectedList();
}

function lvRenderSelectedList(){
  const box = document.getElementById('lvSelectedBox');
  const list = document.getElementById('lvSelectedList');
  const label = document.getElementById('lvSelectedLabel');
  const isExtra = LEAVE_PICKED_TYPE === 'extra_working';

  if (!LEAVE_SELECTED.size) {
    box.style.display = 'none';
    return;
  }
  if (!isExtra) {
    // Show a compact summary only when not extra_working
    box.style.display = 'block';
    label.textContent = 'Selected Dates';
    const sorted = [...LEAVE_SELECTED.keys()].sort();
    const first = sorted[0], last = sorted[sorted.length - 1];
    const summary = sorted.length === 1
      ? `${fmtDate(first)}`
      : `${sorted.length} days leave — ${fmtDate(first)} … ${fmtDate(last)}`;
    list.innerHTML = `<div class="lv-selected-row">
      <span style="font-size:14px">📅</span>
      <span class="lv-selected-date">${summary}</span>
    </div>`;
    return;
  }
  // Extra working — show hours input per date
  box.style.display = 'block';
  label.textContent = 'Hours per Date';
  const sorted = [...LEAVE_SELECTED.keys()].sort();
  list.innerHTML = sorted.map(k => `
    <div class="lv-selected-row">
      <span class="lv-selected-date">📅 ${fmtDate(k)}</span>
      <div class="lv-selected-hours">
        <input type="number" min="0.5" max="24" step="0.5" placeholder="0"
          value="${LEAVE_SELECTED.get(k) || ''}"
          oninput="lvUpdateHours('${k}', this.value)"/>
        <span class="lv-selected-hours-label">hrs</span>
      </div>
      <button type="button" class="lv-selected-remove" onclick="lvToggleDate('${k}')">✕</button>
    </div>`).join('');
}

function lvUpdateHours(key, val){
  if (!LEAVE_SELECTED.has(key)) return;
  LEAVE_SELECTED.set(key, val);
}

async function saveLeave(){
  const errBox = document.getElementById('leaveErr');
  errBox.style.display = 'none';
  const showErr = (m) => { errBox.textContent = m; errBox.style.display = 'block'; };

  if (!LEAVE_PICKED_TYPE) return showErr('Please pick a Leave Type');
  if (!LEAVE_SELECTED.size) return showErr('Select at least one date');

  const reason = document.getElementById('lvReason').value.trim();
  if (!reason) return showErr('Reason is required');

  const isExtra = LEAVE_PICKED_TYPE === 'extra_working';
  const dates = [];
  for (const key of [...LEAVE_SELECTED.keys()].sort()) {
    const item = { date: key };
    if (isExtra) {
      const h = parseFloat(LEAVE_SELECTED.get(key));
      if (!h || h <= 0) return showErr(`Enter hours for ${fmtDate(key)}`);
      item.hours = h;
    }
    dates.push(item);
  }

  const r = await api('/api/leaves', 'POST', {
    leave_type: LEAVE_PICKED_TYPE, dates, reason
  });
  if (r.error) return showErr(r.error);
  closeModal('leaveModal');
  showToast('✅ Leave request submitted for approval');
  loadLeaves();
  loadApprovalBadge();
}

// Pool of leaves currently shown (Leave Tracker page + Approvals page) — used by decision modal
let LEAVE_DECISION_POOL = {};

function lvRegisterPool(list){
  for (const r of (list || [])) LEAVE_DECISION_POOL[r.id] = r;
}

function openLeaveDecision(id, action){
  LEAVE_DECIDE_ID = id;
  const lr = LEAVE_DECISION_POOL[id] || (LEAVE_DATA.find(x => x.id === id));
  if (!lr) return;
  document.getElementById('lvDecisionErr').style.display = 'none';
  document.getElementById('lvDecisionNote').value = '';
  document.getElementById('lvDecisionTitle').textContent =
    action === 'approve' ? 'Approve Leave' : 'Reject Leave';
  const dates = Array.isArray(lr.dates) && lr.dates.length ? lr.dates : [{date: lr.from_date}];
  const datesHtml = dates.map(d =>
    lr.leave_type === 'extra_working' && d.hours
      ? `${fmtDate(d.date)} <span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:5px;font-size:10px;font-weight:700;margin-left:3px">${d.hours}h</span>`
      : fmtDate(d.date)
  ).join(' · ');
  document.getElementById('lvDecisionInfo').innerHTML = `
    <div><b>Employee:</b> ${dtEscape(lr.user_name)}</div>
    <div><b>Type:</b> ${LEAVE_TYPE_LABEL[lr.leave_type]||lr.leave_type}</div>
    <div><b>Dates (${dates.length}):</b> ${datesHtml}</div>
    <div><b>Reason:</b> ${dtEscape(lr.reason)}</div>`;
  const approveBtn = document.getElementById('lvApproveBtn');
  const rejectBtn = document.getElementById('lvRejectBtn');
  approveBtn.style.opacity = action === 'approve' ? '1' : '.7';
  rejectBtn.style.opacity = action === 'reject' ? '1' : '.7';
  document.getElementById('leaveDecisionModal').classList.add('open');
}

async function submitLeaveDecision(action){
  if (!LEAVE_DECIDE_ID) return;
  const note = document.getElementById('lvDecisionNote').value.trim();
  const r = await api('/api/leaves/' + LEAVE_DECIDE_ID, 'PUT', { action, note });
  if (r.error) {
    const e = document.getElementById('lvDecisionErr');
    e.textContent = r.error; e.style.display = 'block';
    return;
  }
  closeModal('leaveDecisionModal');
  showToast(action === 'approve' ? '✅ Leave approved' : '❌ Leave rejected');
  LEAVE_DECIDE_ID = null;
  loadLeaveApprovals();
  loadApprovalBadge();
  // If user is currently on Leave Tracker, also refresh that view
  if (document.getElementById('page-leaves')?.classList.contains('active')) loadLeaves();
}

async function deleteLeave(id){
  if (!confirm('Delete this leave request?')) return;
  const r = await api('/api/leaves/' + id, 'DELETE');
  if (r.error) { showToast(r.error, 'error'); return; }
  showToast('🗑 Leave deleted');
  loadLeaves();
  loadApprovalBadge();
}

async function loadLeaveApprovals(){
  const wrap = document.getElementById('leaveApprovalsContent');
  if (!wrap) return;
  try {
    const list = await api('/api/leaves?scope=approvals&status=pending');
    const rows = Array.isArray(list) ? list : [];
    lvRegisterPool(rows);

    // Update tab badge
    const tabBadge = document.getElementById('apprLeaveBadge');
    if (tabBadge) {
      if (rows.length > 0) { tabBadge.textContent = rows.length; tabBadge.style.display = 'inline-block'; }
      else tabBadge.style.display = 'none';
    }

    if (!rows.length) {
      wrap.innerHTML = `<div class="empty" style="padding:36px">✅ No pending leave approvals!</div>`;
      return;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr>
          <th>Employee</th><th>Type</th><th>Dates</th><th>Reason</th><th>Applied</th><th>Action</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => {
            const dates = Array.isArray(r.dates) && r.dates.length ? r.dates : [{date: r.from_date}];
            const datesHtml = dates.map(d =>
              r.leave_type === 'extra_working' && d.hours
                ? `${fmtDate(d.date)}<span class="lv-hours-pill">${d.hours}h</span>`
                : fmtDate(d.date)
            ).join(' · ');
            return `<tr>
              <td><b>${dtEscape(r.user_name)}</b>${r.user_department ? `<br><span style="color:var(--faint);font-size:11px">${dtEscape(r.user_department)}</span>` : ''}</td>
              <td><span class="lv-type-pill lv-type-${r.leave_type}">${LEAVE_TYPE_ICON[r.leave_type]||''} ${LEAVE_TYPE_LABEL[r.leave_type]||r.leave_type}</span></td>
              <td style="font-size:12px;line-height:1.5">${datesHtml}<br><span style="color:var(--faint);font-size:11px">${dates.length} day${dates.length===1?'':'s'}</span></td>
              <td style="font-size:12px;max-width:240px">${dtEscape(r.reason)}</td>
              <td style="color:var(--muted-foreground);font-size:11px">${dtEscape((r.created_at||'').slice(0,16))}</td>
              <td style="white-space:nowrap">
                <button class="action-btn done" onclick="openLeaveDecision(${r.id},'approve')">Approve</button>
                <button class="action-btn delete" style="margin-left:6px" onclick="openLeaveDecision(${r.id},'reject')">Reject</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch(e) {
    wrap.innerHTML = `<div class="empty" style="color:#dc2626">⚠️ ${dtEscape(e.message)}</div>`;
  }
}


// "16:30" → "4:30 PM". Display only; inputs and the API stay on 24-hour time.
function to12h(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}/.test(hhmm)) return hhmm || "";
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return hour + ":" + String(m).padStart(2, "0") + " " + suffix;
}

// Quick ranges. 0 = this calendar month; N = the last N months ending today.
function e360Range(months) {
  const now = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  let from, to;
  if (!months) {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  } else {
    to = now;
    from = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
  }
  document.getElementById('e360From').value = iso(from);
  document.getElementById('e360To').value = iso(to);
  loadEmp360();
}

// ══════════════════════════════════════════════════════
// EMPLOYEE 360
// ══════════════════════════════════════════════════════
let _e360 = null;

async function loadEmp360() {
  const sel = document.getElementById('e360User');
  const body = document.getElementById('e360Body');

  // First visit: fill the employee picker and default the window to this month.
  if (!sel.options.length) {
    const users = await api('/api/users');
    const list = Array.isArray(users) ? users : [];
    sel.innerHTML = list.map(u => `<option value="${u.id}">${dtEscape(u.name)}</option>`).join('');
    if (!list.length) { body.innerHTML = '<div class="empty">No employees yet</div>'; return; }
    // Default to the signed-in user when they are in the list.
    if (list.some(u => String(u.id) === String(ME.id))) sel.value = ME.id;
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const iso = d => d.toISOString().slice(0, 10);
    document.getElementById('e360From').value = iso(first);
    document.getElementById('e360To').value   = iso(last);
  }

  const id = sel.value;
  const from = document.getElementById('e360From').value;
  const to   = document.getElementById('e360To').value;
  if (!id) return;

  body.innerHTML = '<div class="empty">Loading…</div>';
  const d = await api(`/api/compliance/employee/${id}?from=${from}&to=${to}`);
  if (d.error) { body.innerHTML = `<div class="empty" style="color:#dc2626">${dtEscape(d.error)}</div>`; return; }
  _e360 = d;
  renderEmp360(d);
}

function renderEmp360(d) {
  const card = (inner, extra = '') =>
    `<div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-xs);padding:18px;${extra}">${inner}</div>`;
  const label = t => `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-foreground);font-weight:600;margin-bottom:10px">${t}</div>`;
  const stat = (k, v, color) =>
    `<div style="text-align:center;min-width:44px;flex:1 1 auto"><div style="font-size:17px;font-weight:700;line-height:1.15;color:${color || 'var(--foreground)'}">${v}</div>
     <div style="font-size:10px;color:var(--muted-foreground)">${k}</div></div>`;
  const row = (a, b) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px"><span style="color:var(--muted-foreground)">${a}</span><span style="font-weight:600">${b}</span></div>`;

  // Grade colour doubles as the score bar colour, so the two always agree.
  const gradeColor = g => g === 'Excellent' ? '#16a34a' : g === 'Good' ? '#0ea5e9' : g === 'Average' ? '#d97706' : '#dc2626';
  const sc = d.scores;
  const gc = gradeColor(sc.grade);

  const catRows = Object.entries(sc.categories).map(([k, v]) => {
    const nice = { delegation: 'Delegation', checklist: 'Checklist', clients: 'Projects' }[k] || k;
    if (v === null) {
      // Nothing to measure — say so rather than showing a misleading zero.
      return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">
        <span style="width:104px;font-size:12px;color:var(--muted-foreground)">${nice}</span>
        <span style="flex:1;font-size:11px;color:var(--faint)">no data — weight ${sc.weights[k]}% shared out</span></div>`;
    }
    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">
      <span style="width:104px;font-size:12px;color:var(--muted-foreground)">${nice}</span>
      <span style="flex:1;height:8px;background:var(--muted);border-radius:99px;overflow:hidden">
        <span style="display:block;height:100%;width:${v}%;background:${gradeColor(v >= 85 ? 'Excellent' : v >= 70 ? 'Good' : v >= 50 ? 'Average' : 'x')}"></span></span>
      <span style="width:42px;text-align:right;font-size:12px;font-weight:700">${v}</span>
      <span style="width:34px;text-align:right;font-size:11px;color:var(--faint)">${sc.weights[k]}%</span></div>`;
  }).join('');

  const units = d.clients.list.length ? d.clients.list.map(c =>
    `<tr><td>${dtEscape(c.name)}</td>
     <td><span class="status-badge ${c.is_active ? 'completed' : 'pending'}">${c.is_active ? 'Active' : 'Inactive'}</span></td>
     <td>${c.tasks}</td><td>${c.pending}</td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">No projects handled</td></tr>`;

  const weekly = d.weekly.length ? d.weekly.map(w =>
    `<tr onclick="openWeekTasks('${w.weekStart}','${w.weekEnd}')" style="cursor:pointer" title="Click to see this week's tasks">
      <td style="white-space:nowrap">${fmtDate(w.weekStart)} – ${fmtDate(w.weekEnd)}</td>
      <td>${w.committed === null ? '<span style="color:var(--faint)">not set</span>' : w.committed}</td>
      <td>${w.achieved === null ? '<span style="color:var(--faint)">—</span>' : w.achieved}</td>
      <td>${w.gap === null ? '—' : `<span style="color:${w.gap >= 0 ? '#16a34a' : '#dc2626'};font-weight:600">${w.gap > 0 ? '+' : ''}${w.gap}</span>`}</td>
      <td>${w.taskTotal}</td><td>${w.taskPending}</td>
      <td>${w.regression ? '<span style="font-size:11px;color:#dc2626;font-weight:600">⚠ lower than last week</span>' : ''}</td>
    </tr>`).join('')
    : `<tr><td colspan="7" class="empty">No weeks in this range</td></tr>`;

  document.getElementById('e360Body').innerHTML = `
    <div style="display:grid;grid-template-columns:minmax(280px,1fr) minmax(320px,1.4fr);gap:14px;margin-bottom:14px">
      ${card(`
        ${label('Final Score')}
        <div style="display:flex;align-items:baseline;gap:12px">
          <span style="font-size:46px;font-weight:800;line-height:1;color:${gc}">${sc.final ?? '—'}</span>
          <span style="font-size:14px;font-weight:700;color:${gc}">${dtEscape(sc.grade)}</span>
        </div>
        <div style="font-size:12px;color:var(--muted-foreground);margin-top:8px">
          ${dtEscape(d.user.name)} · ${dtEscape(d.user.department)} · unweighted average ${sc.average ?? '—'}
        </div>`)}
      ${card(label('Score Breakdown') + catRows)}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-bottom:14px">
      ${card(label('Delegation') + `<div style="display:flex;flex-wrap:wrap;gap:8px 4px;justify-content:space-around">
        ${stat('total', d.delegation.total)}${stat('done', d.delegation.completed, '#16a34a')}
        ${stat('pending', d.delegation.pending, '#dc2626')}${stat('revised', d.delegation.revised, '#d97706')}
        ${stat('overdue', d.delegation.overdue, '#dc2626')}</div>`)}
      ${card(label('Checklist') + `<div style="display:flex;flex-wrap:wrap;gap:8px 4px;justify-content:space-around">
        ${stat('total', d.checklist.total)}${stat('done', d.checklist.completed, '#16a34a')}
        ${stat('pending', d.checklist.pending, '#dc2626')}${stat('overdue', d.checklist.overdue, '#dc2626')}</div>`)}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;margin-bottom:14px">
      ${card(label(`Projects handled — ${d.clients.active} active / ${d.clients.total}`) +
        `<div class="flat-tasks-scroll"><table style="width:100%"><thead><tr>
          <th>Project</th><th>Status</th><th>Tasks</th><th>Pending</th>
        </tr></thead><tbody>${units}</tbody></table></div>`)}
    </div>

    ${card(label('Week by week — committed vs achieved') +
      `<div class="flat-tasks-scroll"><table style="min-width:640px;width:100%"><thead><tr>
        <th>Week</th><th>Committed</th><th>Achieved</th><th>Gap</th><th>Tasks</th><th>Pending</th><th></th>
      </tr></thead><tbody>${weekly}</tbody></table></div>
      <div style="font-size:11px;color:var(--faint);margin-top:8px">
        Weekly scores run −100 to 0, where 0 means nothing slipped. Gap is achieved minus committed, so positive beats the commitment.
      </div>`)}`;
}

// Drill-down: the tasks behind one week of the table.
async function openWeekTasks(from, to) {
  if (!_e360) return;
  const box = document.getElementById('weekTasksBody');
  document.getElementById('weekTasksTitle').textContent = `📋 ${fmtDate(from)} – ${fmtDate(to)}`;
  box.innerHTML = '<div class="empty">Loading…</div>';
  document.getElementById('weekTasksModal').classList.add('open');
  const rows = await api(`/api/compliance/employee/${_e360.user.id}/week-tasks?from=${from}&to=${to}`);
  if (rows.error) { box.innerHTML = `<div class="empty" style="color:#dc2626">${dtEscape(rows.error)}</div>`; return; }
  if (!rows.length) { box.innerHTML = '<div class="empty">No tasks that week</div>'; return; }
  box.innerHTML = `<div class="flat-tasks-scroll"><table style="width:100%"><thead><tr>
      <th>Date</th><th>Task</th><th>Type</th><th>Project</th><th>Status</th>
    </tr></thead><tbody>${rows.map(t => `<tr>
      <td style="white-space:nowrap">${fmtDate(t.due_date)}</td>
      <td>${dtEscape(t.title || '')}</td>
      <td style="white-space:nowrap">${t.task_type}</td>
      <td style="white-space:nowrap">${dtEscape(t.client_name || '—')}</td>
      <td><span class="status-badge ${t.status}">${t.status}</span></td>
    </tr>`).join('')}</tbody></table></div>`;
}

// ══════════════════════════════════════════════════════
// PMS — read-only production view
// ══════════════════════════════════════════════════════
let _pms = null;
let _pmsOpen = null;   // SO number expanded in the detail panel

async function loadPMS() {
  const box = document.getElementById('pmsBody');
  box.innerHTML = '<div class="empty">Loading…</div>';
  const d = await api('/api/pms/orders');
  if (d.error) { box.innerHTML = `<div class="empty" style="color:#dc2626">${dtEscape(d.error)}</div>`; return; }
  _pms = d;
  renderPMS();
}

function pmsFilterChange() { renderPMS(); }

function renderPMS() {
  const d = _pms;
  const q = (document.getElementById('pmsSearch')?.value || '').toLowerCase();
  const unit = document.getElementById('pmsUnit')?.value || 'all';
  const stat = document.getElementById('pmsStatus')?.value || 'all';

  const rows = d.orders.filter(o => {
    const matchQ = !q || [o.so, o.party, o.style].join(' ').toLowerCase().includes(q);
    const matchU = unit === 'all' || o.unit === unit;
    const matchS = stat === 'all'
      ? true
      : stat === 'blocked'  ? o.blocked
      : stat === 'running'  ? (o.process.length > 0 && o.progressPct < 100)
      : /* done */            o.progressPct === 100;
    return matchQ && matchU && matchS;
  });

  const units = [...new Set(d.orders.map(o => o.unit))];
  const uSel = document.getElementById('pmsUnit');
  if (uSel && uSel.options.length <= 1) {
    uSel.innerHTML = '<option value="all">All units</option>' + units.map(u => `<option>${dtEscape(u)}</option>`).join('');
  }

  const statusPill = s => {
    const map = { 'Raise PO': ['#fef2f2', '#dc2626'], 'Material Issue': ['#fffbeb', '#d97706'], 'Inhouse': ['#f0fdf4', '#16a34a'] };
    const [bg, fg] = map[s] || ['var(--muted)', 'var(--muted-foreground)'];
    return `<span style="background:${bg};color:${fg};font-size:11px;font-weight:600;padding:2px 8px;border-radius:var(--radius-full);white-space:nowrap">${dtEscape(s)}</span>`;
  };

  const detail = o => `
    <div style="padding:14px 18px;border-top:1px solid var(--border);background:var(--muted)">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">
        <div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-foreground);font-weight:600;margin-bottom:6px">Material — Merch FMS</div>
          <table style="width:100%;background:var(--card);border-radius:var(--radius-sm)"><thead><tr>
            <th>Material</th><th>Qty</th><th>Vendor</th><th>Status</th></tr></thead><tbody>
            ${o.materials.map(m => `<tr><td>${dtEscape(m.name)}<div style="font-size:10px;color:var(--faint)">${m.type}</div></td>
              <td style="white-space:nowrap">${m.qty} ${m.uom}</td><td>${dtEscape(m.vendor)}</td><td>${statusPill(m.status)}</td></tr>`).join('')}
          </tbody></table>
        </div>
        <div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-foreground);font-weight:600;margin-bottom:6px">Purchase orders</div>
          ${o.pos.length ? `<table style="width:100%;background:var(--card);border-radius:var(--radius-sm)"><thead><tr>
            <th>PO</th><th>Vendor</th><th>Qty</th><th>Rate</th><th>Date</th></tr></thead><tbody>
            ${o.pos.map(p => `<tr><td>${dtEscape(p.poNo)}</td><td>${dtEscape(p.vendor)}</td><td>${p.qty}</td><td>${p.price}</td><td style="white-space:nowrap">${fmtDate(p.date)}</td></tr>`).join('')}
          </tbody></table>` : '<div class="empty" style="font-size:12px;background:var(--card);border-radius:var(--radius-sm)">No PO raised yet</div>'}

          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-foreground);font-weight:600;margin:12px 0 6px">Production — Process FMS</div>
          ${o.process.length ? `<div style="background:var(--card);border-radius:var(--radius-sm);padding:10px">
            ${d.stages.map(st => {
              const hit = o.process.find(p => p.stage === st);
              return `<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:3px 0">
                <span style="width:14px">${hit ? '✅' : '⬜'}</span>
                <span style="flex:1;${hit ? '' : 'color:var(--faint)'}">${st}</span>
                <span style="color:var(--muted-foreground)">${hit ? hit.qty + ' pcs · ' + fmtDate(hit.date) : '—'}</span>
              </div>`;
            }).join('')}</div>` : '<div class="empty" style="font-size:12px;background:var(--card);border-radius:var(--radius-sm)">Not started</div>'}
        </div>
      </div>
    </div>`;

  document.getElementById('pmsBody').innerHTML = `
    <div style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:var(--radius);padding:10px 14px;font-size:12px;margin-bottom:12px">
      <b>Sample data.</b> This screen reads nothing yet — it shows the shape only. Point the sheet IDs in <code>.env</code> at your Merch FMS, Process FMS and PO sheets and it fills with the real thing. Nothing here ever writes back.
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <input type="text" id="pmsSearch" oninput="pmsFilterChange()" placeholder="🔍 SO, party or style…"
        style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;font-family:var(--font-sans)"/>
      <select id="pmsUnit" onchange="pmsFilterChange()" style="padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;background:var(--card)"><option value="all">All units</option></select>
      <select id="pmsStatus" onchange="pmsFilterChange()" style="padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;background:var(--card)">
        <option value="all">All orders</option>
        <option value="blocked">Blocked — material not ordered</option>
        <option value="running">In production</option>
        <option value="done">Completed</option>
      </select>
    </div>

    <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-xs);overflow:hidden">
      <div class="flat-tasks-scroll">
        <table style="min-width:860px;width:100%"><thead><tr>
          <th>SO</th><th>Party</th><th>Style</th><th>Pcs</th><th>Unit</th>
          <th>Material</th><th>Stage</th><th>Progress</th>
        </tr></thead><tbody>
        ${rows.length ? rows.map(o => `
          <tr onclick="pmsToggle('${o.so}')" style="cursor:pointer" title="Click for the full trail">
            <td style="white-space:nowrap;font-weight:600">${dtEscape(o.so)}${o.blocked ? ' <span style="color:#dc2626">●</span>' : ''}</td>
            <td>${dtEscape(o.party)}</td>
            <td style="white-space:nowrap">${dtEscape(o.style)}</td>
            <td>${o.pcs}</td>
            <td style="white-space:nowrap">${dtEscape(o.unit)}</td>
            <td style="white-space:nowrap">${o.awaitingPO ? `<span style="color:#dc2626;font-weight:600">${o.awaitingPO} awaiting PO</span>` : `<span style="color:#16a34a">ready</span>`}</td>
            <td style="white-space:nowrap">${o.lastStage ? dtEscape(o.lastStage) + `<div style="font-size:10px;color:var(--faint)">${o.lastQty} pcs · ${fmtDate(o.lastDate)}</div>` : '<span style="color:var(--faint)">not started</span>'}</td>
            <td style="min-width:110px">
              <span style="display:block;height:7px;background:var(--muted);border-radius:99px;overflow:hidden">
                <span style="display:block;height:100%;width:${o.progressPct}%;background:${o.progressPct === 100 ? '#16a34a' : 'var(--brand-mid)'}"></span></span>
              <span style="font-size:10px;color:var(--muted-foreground)">${o.progressPct}%</span>
            </td>
          </tr>
          ${_pmsOpen === o.so ? `<tr><td colspan="8" style="padding:0">${detail(o)}</td></tr>` : ''}
        `).join('') : `<tr><td colspan="8" class="empty">No orders match</td></tr>`}
        </tbody></table>
      </div>
    </div>`;
}

function pmsToggle(so) {
  _pmsOpen = _pmsOpen === so ? null : so;
  renderPMS();
}



// ══════════════════════════════════════════════════════
// DAILY TASK · COMPLIANCE TRACKER · DAILY REPORTS
// Restored from before the removal commit. The Scheduler that was taken out
// alongside them stays out, so nothing here touches meetings.
// ══════════════════════════════════════════════════════
let DT_CLIENTS = [];
let DT_DEPARTMENTS = [];
let DT_LOCKED = false;
let CM_OPEN_ID = null;
let CP_DATA = null;
let DR_DATA = null;

function dtPad(n){ return n<10 ? '0'+n : n; }

function dtFormatDate(d){ return `${d.getFullYear()}-${dtPad(d.getMonth()+1)}-${dtPad(d.getDate())}`; }

function dtFormatDDMMYYYY(d){ return `${dtPad(d.getDate())}/${dtPad(d.getMonth()+1)}/${d.getFullYear()}`; }

function dtTickClock(){
  const now = new Date();
  const t = `${dtFormatDDMMYYYY(now)} ${dtPad(now.getHours())}:${dtPad(now.getMinutes())}:${dtPad(now.getSeconds())}`;
  const el = document.getElementById('dtNow');
  if (el) el.textContent = t;
}

async function loadDailyForm(){
  dtTickClock();
  document.getElementById('dtUserName').textContent = ME.name;
  document.getElementById('dtDoerName').value = ME.name;

  // Date dropdown — today + yesterday only
  const sel = document.getElementById('dtEntryDate');
  sel.innerHTML = '';
  const today = new Date();
  for (let i = 0; i < 2; i++){
    const d = new Date(today); d.setDate(d.getDate() - i);
    const v = dtFormatDate(d);
    const label = i === 0 ? `Today (${dtFormatDDMMYYYY(d)})` : `Yesterday (${dtFormatDDMMYYYY(d)})`;
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = label;
    sel.appendChild(opt);
  }
  sel.onchange = dtCheckLockAndRender;

  // Load clients + departments
  try {
    const [clients, departments] = await Promise.all([
      api('/api/clients'),
      api('/api/departments')
    ]);
    DT_CLIENTS = Array.isArray(clients) ? clients : [];
    DT_DEPARTMENTS = Array.isArray(departments) ? departments : [];
  } catch(e) {
    DT_CLIENTS = []; DT_DEPARTMENTS = [];
  }

  await dtCheckLockAndRender();
  await dtLoadHistory();
}

async function dtCheckLockAndRender(){
  const date = document.getElementById('dtEntryDate').value;
  try {
    const r = await api('/api/daily-tasks/status?date=' + date);
    DT_LOCKED = !!r.submitted;
  } catch(e) { DT_LOCKED = false; }

  const lockNotice = document.getElementById('dtLockedNotice');
  const tableWrap = document.getElementById('dtTableWrap');
  const actions = document.getElementById('dtActions');

  if (DT_LOCKED) {
    lockNotice.style.display = 'block';
    tableWrap.style.display = 'none';
    actions.style.display = 'none';
  } else {
    lockNotice.style.display = 'none';
    tableWrap.style.display = 'block';
    actions.style.display = 'flex';
    // Reset rows to a single empty row
    document.getElementById('dtRowsBody').innerHTML = '';
    dtAddRow();
  }
  dtRecalcTotal();
}

function dtClientOptions(selected){
  let html = '<option value="">--select--</option>';
  for (const c of DT_CLIENTS) {
    const sel = (selected === c.name) ? 'selected' : '';
    html += `<option value="${dtEscape(c.name)}" ${sel}>${dtEscape(c.name)}</option>`;
  }
  return html;
}

function dtDeptOptions(selected){
  let html = '<option value="">--select--</option>';
  for (const d of DT_DEPARTMENTS) {
    const sel = (selected === d) ? 'selected' : '';
    html += `<option value="${dtEscape(d)}" ${sel}>${dtEscape(d)}</option>`;
  }
  return html;
}

function dtAddRow(prefill){
  const tbody = document.getElementById('dtRowsBody');
  const tr = document.createElement('tr');
  tr.className = 'dt-row';
  tr.innerHTML = `
    <td><select class="dt-client">${dtClientOptions(prefill?.client)}</select></td>
    <td><select class="dt-dept">${dtDeptOptions(prefill?.dept)}</select></td>
    <td><textarea class="dt-desc" placeholder="What did you do?">${dtEscape(prefill?.desc||'')}</textarea></td>
    <td><input type="number" min="1" class="dt-time" value="${prefill?.time||''}" placeholder="0" oninput="dtRecalcTotal()"/></td>
    <td><button class="dt-row-btn dt-btn-dup" onclick="dtDupRow(this)">Dup</button></td>
    <td><button class="dt-row-btn dt-btn-del" onclick="dtDelRow(this)">Del</button></td>
  `;
  tbody.appendChild(tr);
}

function dtDupRow(btn){
  const tr = btn.closest('tr');
  const prefill = {
    client: tr.querySelector('.dt-client').value,
    dept: tr.querySelector('.dt-dept').value,
    desc: tr.querySelector('.dt-desc').value,
    time: tr.querySelector('.dt-time').value,
  };
  dtAddRow(prefill);
  dtRecalcTotal();
}

function dtDelRow(btn){
  const tbody = document.getElementById('dtRowsBody');
  if (tbody.children.length <= 1) {
    showToast('At least 1 row required','error');
    return;
  }
  btn.closest('tr').remove();
  dtRecalcTotal();
}

function dtRecalcTotal(){
  let total = 0;
  document.querySelectorAll('.dt-time').forEach(inp => {
    const v = parseInt(inp.value) || 0;
    if (v > 0) total += v;
  });
  const el = document.getElementById('dtTotalMin');
  if (el) el.textContent = total;
}

async function dtSubmit(){
  if (DT_LOCKED) { showToast('Already submitted for this date','error'); return; }
  const date = document.getElementById('dtEntryDate').value;
  const rows = [];
  for (const tr of document.querySelectorAll('#dtRowsBody tr')) {
    const client = tr.querySelector('.dt-client').value.trim();
    const dept = tr.querySelector('.dt-dept').value.trim();
    const desc = tr.querySelector('.dt-desc').value.trim();
    const time = parseInt(tr.querySelector('.dt-time').value) || 0;
    if (!client || !desc || time <= 0) {
      showToast('Each row needs Unit, Description and Time (>0)','error');
      return;
    }
    rows.push({ client_name: client, department: dept, description: desc, duration_min: time });
  }
  if (!rows.length) { showToast('Add at least 1 row','error'); return; }

  const btn = document.querySelector('.dt-btn-submit');
  btn.disabled = true; btn.textContent = 'Submitting...';
  try {
    const r = await api('/api/daily-tasks', 'POST', { entry_date: date, rows });
    if (r.error) { showToast(r.error, 'error'); }
    else {
      showToast(`✅ ${r.count} entries submitted!`);
      DT_LOCKED = true;
      await dtCheckLockAndRender();
      await dtLoadHistory();
    }
  } catch(e) {
    showToast('Submit failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Submit All →';
  }
}

async function dtLoadHistory(){
  const wrap = document.getElementById('dtHistoryWrap');
  try {
    const rows = await api('/api/daily-tasks/mine');
    if (!rows || !rows.length) {
      wrap.innerHTML = '<div class="empty">No past submissions yet.</div>';
      return;
    }
    // Group by date
    const byDate = {};
    for (const r of rows) {
      if (!byDate[r.entry_date]) byDate[r.entry_date] = [];
      byDate[r.entry_date].push(r);
    }
    let html = '';
    for (const date of Object.keys(byDate)) {
      const items = byDate[date];
      const total = items.reduce((a,b) => a + (b.duration_min||0), 0);
      html += `<div class="dt-history-day">
        <div class="dt-history-date">📅 ${date}  ·  ${items.length} task${items.length>1?'s':''}  ·  ${total} min total</div>`;
      for (const it of items) {
        html += `<div class="dt-history-row">
          <span class="pill">${dtEscape(it.client_name)}</span>
          ${it.department ? `<span class="pill" style="background:#dbeafe;color:#1e40af">${dtEscape(it.department)}</span>` : ''}
          <span style="flex:1">${dtEscape(it.description)}</span>
          <span style="color:#A63F43;font-weight:600">${it.duration_min} min</span>
        </div>`;
      }
      html += `</div>`;
    }
    wrap.innerHTML = html;
  } catch(e) {
    wrap.innerHTML = '<div class="empty">Failed to load history</div>';
  }
}

async function cmToggleDetail(id) {
  const detail = document.getElementById('cm-detail-' + id);
  const row = document.querySelector(`[data-cm-id="${id}"]`);

  if (CM_OPEN_ID === id) {
    detail.style.display = 'none';
    row.classList.remove('cm-active');
    CM_OPEN_ID = null;
    return;
  }

  // Close any open panel
  if (CM_OPEN_ID) {
    const prev = document.getElementById('cm-detail-' + CM_OPEN_ID);
    const prevRow = document.querySelector(`[data-cm-id="${CM_OPEN_ID}"]`);
    if (prev) prev.style.display = 'none';
    if (prevRow) prevRow.classList.remove('cm-active');
  }

  detail.style.display = 'block';
  row.classList.add('cm-active');
  CM_OPEN_ID = id;

  if (detail.dataset.loaded) return;
  detail.innerHTML = '<div style="padding:14px;text-align:center;color:var(--faint);font-size:13px">Loading stats…</div>';

  try {
    const stats = await api('/api/clients/' + id + '/stats');
    detail.dataset.loaded = '1';
    const totalHrs = (stats.total_minutes / 60).toFixed(1);
    const medals = ['🥇','🥈','🥉'];
    let workersHtml = '';
    if (!stats.top_workers || !stats.top_workers.length) {
      workersHtml = '<div style="color:var(--faint);font-size:13px;padding:6px 0">No work recorded yet</div>';
    } else {
      for (let i = 0; i < stats.top_workers.length; i++) {
        const w = stats.top_workers[i];
        const hrs = (w.total_minutes / 60).toFixed(1);
        workersHtml += `<div class="cm-worker-row">
          <span class="cm-worker-rank">${medals[i]}</span>
          <span class="cm-worker-name">${dtEscape(w.name)}</span>
          ${w.department ? `<span class="cm-worker-dept">${dtEscape(w.department)}</span>` : ''}
          <span class="cm-worker-hrs">${hrs} hrs</span>
        </div>`;
      }
    }
    detail.innerHTML = `<div class="cm-detail-inner">
      <div class="cm-detail-total">
        <span class="cm-detail-label">Total Hours</span>
        <span class="cm-detail-val">${totalHrs}</span>
        <span style="font-size:11px;color:#92400e;font-weight:600">hrs</span>
      </div>
      <div class="cm-detail-workers">
        <div class="cm-detail-workers-title">Top 3 Contributors</div>
        ${workersHtml}
      </div>
    </div>`;
  } catch(e) {
    detail.innerHTML = '<div style="padding:14px;color:#ef4444;font-size:13px">Failed to load stats</div>';
  }
}

async function loadCompliance(){
  const wrap = document.getElementById('cpGridWrap');
  wrap.innerHTML = '<div class="empty">Loading...</div>';
  try {
    CP_DATA = await api('/api/compliance/last7');
    renderCompliance();
  } catch(e) {
    wrap.innerHTML = '<div class="empty">Failed to load compliance data</div>';
  }
}

function renderCompliance(){
  if (!CP_DATA) return;
  const wrap = document.getElementById('cpGridWrap');
  const search = (document.getElementById('cpSearch')?.value || '').toLowerCase();
  const roleF = document.getElementById('cpRoleFilter')?.value || '';

  const dates = CP_DATA.dates;
  let users = CP_DATA.users;

  if (search) {
    users = users.filter(u =>
      u.name.toLowerCase().includes(search) ||
      u.email.toLowerCase().includes(search) ||
      (u.department||'').toLowerCase().includes(search)
    );
  }
  if (roleF) users = users.filter(u => u.role === roleF);

  if (!users.length) { wrap.innerHTML = '<div class="empty">No users match filters</div>'; return; }

  let html = `<table class="cp-grid"><thead><tr>
    <th style="text-align:left">Name</th>
    <th style="text-align:left">Role</th>
    <th style="text-align:left">Department</th>`;
  for (const d of dates) {
    const dt = new Date(d);
    const dayLabel = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()];
    html += `<th>${dayLabel}<br><span style="font-weight:400;font-size:10px;opacity:.85">${d.slice(5)}</span></th>`;
  }
  html += `<th>Score</th></tr></thead><tbody>`;

  for (const u of users) {
    // Working days = days that aren't user's off/holiday
    const workingDays = u.status.filter(s => !s.off).length;
    const filledCnt = u.status.filter(s => s.filled).length;
    const denom = workingDays || 1;
    const pct = Math.round((filledCnt/denom)*100);
    const pillClass = pct >= 80 ? 'cp-summary-good' : pct >= 50 ? 'cp-summary-meh' : 'cp-summary-bad';

    html += `<tr>
      <td>${dtEscape(u.name)}</td>
      <td>${u.role}</td>
      <td>${dtEscape(u.department)}</td>`;
    for (const s of u.status) {
      let cell;
      if (s.off) {
        cell = s.isHoliday
          ? '<span class="cp-cell-holiday" title="Holiday">🎉 Off</span>'
          : '<span class="cp-cell-off" title="Week off">Off</span>';
      } else if (s.filled) {
        cell = '<span class="cp-cell-yes">✓</span>';
      } else {
        cell = '<span class="cp-cell-no">✗</span>';
      }
      html += `<td>${cell}</td>`;
    }
    html += `<td><span class="cp-summary-pill ${pillClass}">${filledCnt}/${workingDays} (${pct}%)</span></td></tr>`;
  }
  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

// Compliance page has two views; Employee 360 loads lazily on first open.
function complianceTab(which, el) {
  document.querySelectorAll('#page-compliance .tab-group .tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  const fill = which === 'fill';
  document.getElementById('cpFillView').style.display = fill ? 'block' : 'none';
  document.getElementById('cpE360View').style.display = fill ? 'none' : 'block';
  if (!fill) loadEmp360();
}

async function loadDailyReports(){
  const monthInput = document.getElementById('drMonth');
  if (!monthInput.value) {
    const now = new Date();
    monthInput.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  }
  document.getElementById('drStats').innerHTML = '<div class="empty">Loading...</div>';
  document.getElementById('drSummaryWrap').innerHTML = '<div class="empty">Loading...</div>';
  document.getElementById('drEntriesWrap').innerHTML = '<div class="empty">Loading...</div>';

  try {
    DR_DATA = await api('/api/daily-tasks/report?month=' + monthInput.value);
    if (DR_DATA.error) throw new Error(DR_DATA.error);
    renderDRStats();
    renderDRSummary();
    renderDREntriesUserDropdown();
    renderDREntries();
  } catch(e) {
    document.getElementById('drStats').innerHTML = `<div class="empty">Failed: ${e.message}</div>`;
    document.getElementById('drSummaryWrap').innerHTML = '';
    document.getElementById('drEntriesWrap').innerHTML = '';
  }
}

function renderDRStats(){
  const d = DR_DATA;
  const totalHours = (d.total_minutes / 60).toFixed(1);
  const monthLabel = new Date(d.month + '-01').toLocaleString('en-US', { month: 'long', year: 'numeric' });
  document.getElementById('drStats').innerHTML = `
    <div class="dr-stat">
      <div class="dr-stat-label">Month</div>
      <div class="dr-stat-value" style="font-size:20px">${monthLabel}</div>
    </div>
    <div class="dr-stat">
      <div class="dr-stat-label">Total Entries</div>
      <div class="dr-stat-value">${d.total_entries}</div>
      <div class="dr-stat-sub">across ${d.summary.length} user${d.summary.length===1?'':'s'}</div>
    </div>
    <div class="dr-stat">
      <div class="dr-stat-label">Total Time</div>
      <div class="dr-stat-value">${d.total_minutes}<span style="font-size:14px"> min</span></div>
      <div class="dr-stat-sub">≈ ${totalHours} hours</div>
    </div>
    <div class="dr-stat">
      <div class="dr-stat-label">Active Users</div>
      <div class="dr-stat-value">${d.summary.length}</div>
      <div class="dr-stat-sub">submitted at least once</div>
    </div>
  `;
}

function renderDRSummary(){
  const wrap = document.getElementById('drSummaryWrap');
  if (!DR_DATA.summary.length) {
    wrap.innerHTML = '<div class="empty">No submissions in this month yet.</div>';
    return;
  }
  let html = `<table class="dr-table"><thead><tr>
    <th>User</th><th>Department</th><th>Days Filled</th>
    <th>Total Tasks</th><th>Total Minutes</th><th>Hours</th><th>Avg/Day</th>
  </tr></thead><tbody>`;
  for (const u of DR_DATA.summary) {
    const hours = (u.total_minutes / 60).toFixed(1);
    const avg = u.days_filled > 0 ? Math.round(u.total_minutes / u.days_filled) : 0;
    html += `<tr>
      <td><b>${dtEscape(u.name)}</b><br><span style="color:var(--muted-foreground);font-size:11px">${dtEscape(u.email)}</span></td>
      <td>${dtEscape(u.department || '—')}</td>
      <td>${u.days_filled} day${u.days_filled===1?'':'s'}</td>
      <td>${u.total_tasks}</td>
      <td><span class="pill-min">${u.total_minutes} min</span></td>
      <td>${hours} hr</td>
      <td>${avg} min/day</td>
    </tr>`;
  }
  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

function renderDREntriesUserDropdown(){
  const sel = document.getElementById('drUserFilter');
  const cur = sel.value;
  let html = '<option value="">All Users</option>';
  for (const u of DR_DATA.summary) {
    const selected = cur == u.user_id ? 'selected' : '';
    html += `<option value="${u.user_id}" ${selected}>${dtEscape(u.name)}</option>`;
  }
  sel.innerHTML = html;
}

function renderDREntries(){
  if (!DR_DATA) return;
  const wrap = document.getElementById('drEntriesWrap');
  const search = (document.getElementById('drSearch')?.value || '').toLowerCase();
  const userId = document.getElementById('drUserFilter')?.value || '';

  let entries = DR_DATA.entries;
  if (userId) entries = entries.filter(e => String(e.user_id) === String(userId));
  if (search) {
    entries = entries.filter(e =>
      e.doer_name.toLowerCase().includes(search) ||
      e.client_name.toLowerCase().includes(search) ||
      (e.description||'').toLowerCase().includes(search) ||
      (e.department||'').toLowerCase().includes(search)
    );
  }

  if (!entries.length) {
    wrap.innerHTML = '<div class="empty">No entries match the filters.</div>';
    return;
  }

  let html = `<table class="dr-table"><thead><tr>
    <th>Date</th><th>User</th><th>Project</th><th>Department</th>
    <th>Description</th><th>Time</th>
  </tr></thead><tbody>`;
  for (const e of entries) {
    html += `<tr>
      <td><b>${e.entry_date}</b></td>
      <td>${dtEscape(e.doer_name)}</td>
      <td><span class="pill-tag">${dtEscape(e.client_name)}</span></td>
      <td>${e.department ? `<span class="pill-dept">${dtEscape(e.department)}</span>` : '—'}</td>
      <td>${dtEscape(e.description)}</td>
      <td><span class="pill-min">${e.duration_min} min</span></td>
    </tr>`;
  }
  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

function drExportCSV(){
  if (!DR_DATA || !DR_DATA.entries.length) {
    showToast('No data to export', 'error'); return;
  }
  const rows = [['Date', 'User', 'Email', 'Unit', 'Department', 'Description', 'Minutes']];
  for (const e of DR_DATA.entries) {
    rows.push([
      e.entry_date,
      (e.doer_name||'').replace(/,/g,';'),
      e.doer_email,
      (e.client_name||'').replace(/,/g,';'),
      (e.department||'').replace(/,/g,';'),
      (e.description||'').replace(/,/g,';').replace(/\n/g,' '),
      e.duration_min
    ]);
  }
  const csv = rows.map(r => r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `daily_tasks_${DR_DATA.month}.csv`;
  a.click();
  showToast('✅ CSV downloaded');
}

setInterval(dtTickClock, 1000);

init();
setDefaultMISDates();
initModalCloseButtons();
initPasswordToggles();
applyUnitNames();
