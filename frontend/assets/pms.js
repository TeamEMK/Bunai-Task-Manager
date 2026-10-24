// ══════════════════════════════════════════════════════
// PMS — Production Management (see backend/src/routes/pms.routes.js)
// One sidebar page with its own tabs: Dashboard · My Tasks · Orders ·
// New Order · Order Update · Workflow · Vendors · Settings.
// Uses the shared api(), showToast(), dtEscape() and .modal-overlay from app.js.
// ══════════════════════════════════════════════════════
const PMS = { tab: 'dashboard', meta: null, orders: null, orderTab: 'active', stepFilter: '', upd: { sel: null, range: 'week' }, newPrefill: null };
const pmsEsc = s => dtEscape(s == null ? '' : String(s));

const PMS_TABS = [
  ['dashboard', 'Dashboard'], ['tasks', 'My Tasks'], ['orders', 'Orders'], ['new', 'New Order'],
  ['updates', 'Order Update'], ['workflow', 'Workflow'], ['vendors', 'Vendors'], ['settings', 'Settings', true],
];

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function pmsDate(s) {
  if (!s) return '—';
  const [y, m, d] = s.slice(0, 10).split('-');
  return `${d} ${MON[+m - 1]} ${y}`;
}
function pmsDateTime(s) {
  if (!s) return '—';
  let h = +s.slice(11, 13); const mi = s.slice(14, 16);
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${pmsDate(s)}, ${h}:${mi} ${ap}`;
}
function pmsAgo(s) {
  if (!s) return '';
  const now = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const diff = (Date.parse(now.replace(' ', 'T') + 'Z') - Date.parse(s.replace(' ', 'T') + 'Z')) / 60000;
  if (diff < 1) return 'just now';
  if (diff < 60) return Math.round(diff) + ' min ago';
  if (diff < 1440) return Math.round(diff / 60) + ' hours ago';
  const d = Math.round(diff / 1440);
  return d === 1 ? '1 day ago' : d + ' days ago';
}
const pmsFlagNames = flags => (flags || []).map(f => PMS.meta.conditions[f] || f);
const pmsTitle = o => `${pmsEsc(o.order_no && o.order_no !== o.order_code ? o.order_no : o.order_code)} · ${pmsEsc(o.client_name)}`;
const pmsUserOpts = (sel, blank = '— Unassigned —') =>
  `<option value="">${blank}</option>` + PMS.meta.users.map(u => `<option value="${u.id}"${+sel === u.id ? ' selected' : ''}>${pmsEsc(u.name)}</option>`).join('');
const pmsVendorOpts = sel =>
  `<option value="">— No vendor —</option>` + PMS.meta.vendors.filter(v => v.active || +sel === v.id)
    .map(v => `<option value="${v.id}"${+sel === v.id ? ' selected' : ''}>${pmsEsc(v.name)}${v.category ? ' · ' + pmsEsc(v.category) : ''}</option>`).join('');

async function loadPMS() {
  const box = document.getElementById('pmsBody');
  if (!PMS.meta) box.innerHTML = '<div class="empty">Loading…</div>';
  const m = await api('/api/pms/meta');
  if (m.error) { box.innerHTML = `<div class="empty" style="color:#dc2626">${pmsEsc(m.error)}</div>`; return; }
  PMS.meta = m;
  try { const t = localStorage.getItem('pmsTab'); if (t && PMS_TABS.some(x => x[0] === t)) PMS.tab = t; } catch (_) {}
  if (PMS.tab === 'settings' && !m.me.manager) PMS.tab = 'dashboard';
  pmsGo(PMS.tab);
}

function pmsGo(tab) {
  PMS.tab = tab;
  try { localStorage.setItem('pmsTab', tab); } catch (_) {}
  const tabs = PMS_TABS.filter(t => !t[2] || PMS.meta.me.manager);
  document.getElementById('pmsBody').innerHTML = `
    <div class="pm-nav" role="tablist">${tabs.map(([k, l]) =>
      `<button class="pm-nav-btn${k === tab ? ' active' : ''}" role="tab" onclick="pmsGo('${k}')">${l}</button>`).join('')}</div>
    <div id="pmView"><div class="empty">Loading…</div></div>`;
  ({ dashboard: pmsDashboard, tasks: pmsTasks, orders: pmsOrders, new: pmsNewOrder, updates: pmsUpdates,
     workflow: pmsWorkflow, vendors: pmsVendors, settings: pmsSettings })[tab]();
}
const pmView = html => { document.getElementById('pmView').innerHTML = html; };

// ── Dashboard ─────────────────────────────────────────
async function pmsDashboard() {
  const d = await api('/api/pms/dashboard');
  if (d.error) return pmView(`<div class="empty" style="color:#dc2626">${pmsEsc(d.error)}</div>`);
  const c = d.counts;
  const hr = +new Date(Date.now() + 330 * 60000).toISOString().slice(11, 13);
  const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const total = d.pipeline.reduce((a, s) => a + s.pending, 0);
  pmView(`
    <div class="pm-hero">
      <div><h2>${greet}, ${pmsEsc(PMS.meta.me.name)}</h2>
        <p>${c.myPending ? `You have <b>${c.myPending}</b> pending step${c.myPending > 1 ? 's' : ''}.` : 'You have no pending tasks.'}</p></div>
      <div class="pm-actions"><button class="btn btn-outline" onclick="pmsGo('tasks')">My Tasks</button>
        <button class="btn btn-primary" onclick="pmsGo('new')">+ New Order</button></div>
    </div>
    <div class="pm-stats">
      ${pmsStat('Active Orders', c.active, '', "pmsOpenOrders('active')")}
      ${pmsStat('Delayed Orders', c.delayed, 'bad', "pmsOpenOrders('delayed')")}
      ${pmsStat('My Pending Tasks', c.myPending, 'warn', "pmsGo('tasks')")}
      ${pmsStat('Completed (this month)', c.completedMonth, 'good', "pmsOpenOrders('completed')")}
    </div>
    <div class="pm-card">
      <div class="pm-card-head"><b>Step-wise Pipeline</b><span class="pm-muted">Pending orders at each step · click to view</span></div>
      <div class="pm-pipe">
        <button class="pm-pipe-card all" onclick="pmsOpenOrders('active')">
          <span class="pm-pipe-no">ALL</span><span class="pm-pipe-name">All active orders</span>
          <span class="pm-pipe-foot"><b>${c.active}</b> orders</span></button>
        ${d.pipeline.map(s => `
          <button class="pm-pipe-card${s.late ? ' late' : ''}${s.pending ? '' : ' idle'}" onclick="pmsOpenOrders('active',${s.step_no})">
            <span class="pm-pipe-no">STEP ${s.step_no}</span><span class="pm-pipe-name">${pmsEsc(s.name)}</span>
            <span class="pm-pipe-foot"><b>${s.pending}</b> pending ${s.late ? `<em>${s.late} late</em>` : ''}</span></button>`).join('')}
      </div>
      ${total ? '' : '<div class="pm-muted" style="padding:0 18px 14px">No order is waiting at any step right now.</div>'}
    </div>
    <div class="pm-two">
      <div class="pm-card">
        <div class="pm-card-head"><b>Upcoming Deliveries (7 days)</b><a onclick="pmsOpenOrders('delayed')">View delayed →</a></div>
        ${d.upcoming.length ? d.upcoming.map(o => `
          <div class="pm-row" onclick="pmsOrderDetail(${o.id})">
            <div><b>${pmsTitle(o)}</b><div class="pm-muted">${pmsEsc(o.product)} · Qty ${o.qty}</div></div>
            <div class="pm-right"><span class="pm-chip ${o.delivery_date < PMS.meta.today ? 'bad' : 'warn'}">${pmsDate(o.delivery_date)}</span>
              <div class="pm-muted">${o.current ? 'Step ' + o.current.step_no : ''}</div></div>
          </div>`).join('') : '<div class="empty">Nothing due in the next 7 days.</div>'}
      </div>
      <div class="pm-card">
        <div class="pm-card-head"><b>Recent Orders</b><a onclick="pmsOpenOrders('all')">View all →</a></div>
        ${d.recent.length ? d.recent.map(o => `
          <div class="pm-row" onclick="pmsOrderDetail(${o.id})">
            <div><b>${pmsTitle(o)}</b><div class="pm-muted">${pmsEsc(o.product)} · ${pmsAgo(o.created_at)}</div></div>
            <div class="pm-right">${o.current ? `<span class="pm-chip">S${o.current.step_no} · ${pmsEsc(o.current.name)}</span>` : pmsStatusChip(o)}</div>
          </div>`).join('') : '<div class="empty">No orders yet — create the first one.</div>'}
      </div>
    </div>`);
}
const pmsStat = (label, n, tone, click) =>
  `<button class="pm-stat ${tone}" onclick="${click}"><span class="pm-stat-n">${n}</span><span class="pm-stat-l">${label}</span></button>`;
function pmsStatusChip(o) {
  if (o.status === 'completed') return '<span class="pm-chip good">Completed</span>';
  if (o.status === 'hold') return '<span class="pm-chip">On Hold</span>';
  if (o.status === 'cancelled') return '<span class="pm-chip bad">Cancelled</span>';
  return o.delayed ? '<span class="pm-chip bad">Delayed</span>' : '<span class="pm-chip warn">In Progress</span>';
}
function pmsOpenOrders(tab, step) {
  PMS.orderTab = tab; PMS.stepFilter = step ? String(step) : '';
  pmsGo('orders');
}

// ── My Tasks ──────────────────────────────────────────
async function pmsTasks() {
  const d = await api('/api/pms/my-tasks');
  if (d.error) return pmView(`<div class="empty" style="color:#dc2626">${pmsEsc(d.error)}</div>`);
  PMS.tasks = d;
  const task = (t, unassigned) => `
    <div class="pm-task${t.late ? ' late' : ''}">
      <div class="pm-task-main" onclick="pmsOrderDetail(${t.order_id})">
        <div class="pm-task-step">Step ${t.step_no} · ${pmsEsc(t.name)}</div>
        <b>${pmsEsc(t.order_code)} · ${pmsEsc(t.client_name)}</b>
        <div class="pm-muted">${pmsEsc(t.product)} · Qty ${t.qty}${t.color ? ' · ' + pmsEsc(t.color) : ''}${t.sizes ? ' · ' + pmsEsc(t.sizes) : ''}</div>
      </div>
      <div class="pm-task-side">
        <span class="pm-chip ${t.late ? 'bad' : ''}">Plan: ${pmsDateTime(t.planned_at)}</span>
        ${unassigned
          ? `<select onchange="pmsAssign(${t.id},this.value)">${pmsUserOpts(null, 'Assign to…')}</select>`
          : `<button class="btn btn-primary btn-sm" onclick="pmsDoneModal(${t.id},${t.order_id})">✓ Done</button>`}
      </div>
    </div>`;
  pmView(`
    <div class="pm-hero"><div><h2>My Tasks</h2><p>${d.mine.length ? `${d.mine.length} step${d.mine.length > 1 ? 's' : ''} waiting on you` : 'All work is complete 🎉'}</p></div>
      <div class="pm-actions"><button class="btn btn-outline" onclick="pmsTasks()">↻ Refresh</button></div></div>
    <div class="pm-two wide">
      <div>
        <div class="pm-card"><div class="pm-card-head"><b>My Steps <span class="pm-count">${d.mine.length}</span></b></div>
          ${d.mine.length ? d.mine.map(t => task(t)).join('') : '<div class="empty">✓ No pending steps</div>'}</div>
        ${PMS.meta.me.manager ? `<div class="pm-card"><div class="pm-card-head"><b>Unassigned Steps (PM view) <span class="pm-count">${d.unassigned.length}</span></b></div>
          ${d.unassigned.length ? d.unassigned.map(t => task(t, true)).join('') : '<div class="empty">✓ All steps are assigned</div>'}</div>` : ''}
      </div>
      <div class="pm-card"><div class="pm-card-head"><b>Vendor Tracking <span class="pm-count">${d.vendorOpen.length}</span></b></div>
        ${d.vendorOpen.length ? d.vendorOpen.map(v => `
          <div class="pm-row"><div><b>${pmsEsc(v.vendor_name)}</b> <span class="pm-chip ${v.late ? 'bad' : 'warn'}">Due ${pmsDate(v.planned_at)}</span>
            <div class="pm-muted">${pmsEsc(v.order_code)} · ${pmsEsc(v.name)} · Qty ${v.qty}</div></div></div>`).join('')
          : '<div class="empty">No order is at a vendor.</div>'}
      </div>
    </div>`);
}
async function pmsAssign(stepId, userId) {
  if (!userId) return;
  const r = await api('/api/pms/order-steps/' + stepId, 'PUT', { doer_id: Number(userId) });
  if (r.error) return showToast(r.error, 'error');
  showToast('Assigned'); pmsTasks();
}

// ── Orders ────────────────────────────────────────────
async function pmsOrders() {
  const d = await api('/api/pms/orders');
  if (d.error) return pmView(`<div class="empty" style="color:#dc2626">${pmsEsc(d.error)}</div>`);
  PMS.orders = d.orders;
  const steps = PMS.meta.steps.filter(s => s.active);
  const tabs = [['active', 'Active'], ['delayed', '⚠ Delayed'], ['completed', 'Completed'], ['hold', 'Hold / Cancelled'], ['all', 'All']];
  pmView(`
    <div class="pm-hero"><div><h2>Orders</h2><p>Live status of every order — current step, plan vs actual.</p></div>
      <div class="pm-actions"><button class="btn btn-primary" onclick="pmsGo('new')">+ New Order</button></div></div>
    <div class="pm-subtabs">${tabs.map(([k, l]) => `<button class="${k === PMS.orderTab ? 'active' : ''}" onclick="PMS.orderTab='${k}';pmsRenderOrders()">${l} <span id="pmTabN-${k}"></span></button>`).join('')}</div>
    <div class="pm-filters">
      <input id="pmQ" placeholder="Search order code, order no, client, product, phone, SKU…" oninput="pmsRenderOrders()"/>
      <select id="pmStep" onchange="PMS.stepFilter=this.value;pmsRenderOrders()"><option value="">Any current step</option>
        ${steps.map(s => `<option value="${s.step_no}"${String(s.step_no) === PMS.stepFilter ? ' selected' : ''}>S${s.step_no} · ${pmsEsc(s.name)}</option>`).join('')}</select>
      <select id="pmType" onchange="pmsRenderOrders()"><option value="">All types</option><option value="new">New</option><option value="repeat">Repeat</option><option value="sample">Sample only</option></select>
      <select id="pmPri" onchange="pmsRenderOrders()"><option value="">Any priority</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option></select>
      <select id="pmSrc" onchange="pmsRenderOrders()"><option value="">All sources</option><option value="manual">Manual form</option><option value="unicommerce">Unicommerce</option></select>
    </div>
    <div class="pm-card pm-table-wrap" id="pmOrdersTable"></div>`);
  pmsRenderOrders();
}
function pmsRenderOrders() {
  const all = PMS.orders || [];
  const val = id => (document.getElementById(id) || {}).value || '';
  const q = val('pmQ').toLowerCase(), type = val('pmType'), pri = val('pmPri'), src = val('pmSrc'), step = PMS.stepFilter;
  const inTab = (o, t) => t === 'all' ? true : t === 'active' ? o.status === 'active' : t === 'delayed' ? o.delayed
    : t === 'completed' ? o.status === 'completed' : (o.status === 'hold' || o.status === 'cancelled');
  ['active', 'delayed', 'completed', 'hold', 'all'].forEach(t => {
    const el = document.getElementById('pmTabN-' + t); if (el) el.textContent = all.filter(o => inTab(o, t)).length;
  });
  document.querySelectorAll('.pm-subtabs button').forEach((b, i) => b.classList.toggle('active', ['active', 'delayed', 'completed', 'hold', 'all'][i] === PMS.orderTab));
  const rows = all.filter(o => inTab(o, PMS.orderTab)
    && (!q || [o.order_code, o.order_no, o.client_name, o.client_phone, o.product, o.sku, o.uni_order_code, o.party].some(v => String(v || '').toLowerCase().includes(q)))
    && (!type || o.order_type === type) && (!pri || o.priority === pri) && (!src || o.source === src)
    && (!step || (o.current && String(o.current.step_no) === step)));
  document.getElementById('pmOrdersTable').innerHTML = rows.length ? `
    <table><thead><tr><th>Order</th><th>Client</th><th>Current Step</th><th>Progress</th><th>Delivery</th><th>Status</th><th>Source</th></tr></thead>
    <tbody>${rows.map(o => `
      <tr class="${o.delayed ? 'pm-late-row' : ''}" onclick="pmsOrderDetail(${o.id})" style="cursor:pointer">
        <td><b>${pmsEsc(o.order_no || o.order_code)}</b>${o.order_no && o.order_no !== o.order_code ? `<div class="pm-mono">${pmsEsc(o.order_code)}</div>` : ""}
          <div class="pm-muted">${pmsEsc(o.product)} · Qty ${o.qty}${o.priority !== 'normal' ? ` · <span class="pm-pri ${o.priority}">${o.priority}</span>` : ''}</div></td>
        <td><b>${pmsEsc(o.client_name)}</b><div class="pm-muted">${pmsEsc(o.sales_person || 'No sales person')}</div></td>
        <td>${o.current ? `<b>S${o.current.step_no} · ${pmsEsc(o.current.name)}</b>
          <div class="${o.step_late ? 'pm-bad' : 'pm-muted'}">Plan: ${pmsDate(o.current.planned_at)}</div>
          <div class="pm-muted">${pmsEsc(o.current.doer_name || 'Unassigned')}</div>` : '—'}</td>
        <td style="min-width:120px"><div class="pm-bar"><i style="width:${o.progress}%"></i></div>
          <div class="pm-muted">${o.steps_done}/${o.steps_total} steps · ${o.progress}%</div></td>
        <td>${pmsDate(o.delivery_date)}</td>
        <td>${pmsStatusChip(o)}</td>
        <td><span class="pm-chip ${o.source === 'unicommerce' ? 'uni' : ''}">${o.source === 'unicommerce' ? 'Unicommerce' : 'Manual'}</span></td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">No orders match.</div>';
}

// ── Order detail ──────────────────────────────────────
function pmsModal(html, wide) {
  let ov = document.getElementById('pmsModal');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'modal-overlay'; ov.id = 'pmsModal';
    ov.addEventListener('keydown', e => { if (e.key === 'Escape') pmsCloseModal(); });
    document.body.appendChild(ov);
  }
  ov.innerHTML = `<div class="modal" style="width:${wide ? 900 : 560}px;max-width:95vw">
    <div class="modal-close-bar"><button class="modal-close" aria-label="Close" onclick="pmsCloseModal()">✕</button></div>${html}</div>`;
  ov.classList.add('open');
}
function pmsCloseModal() { const ov = document.getElementById('pmsModal'); if (ov) ov.classList.remove('open'); }

async function pmsOrderDetail(id) {
  pmsModal('<div class="empty">Loading…</div>', true);
  const d = await api('/api/pms/orders/' + id);
  if (d.error) return pmsModal(`<div class="empty" style="color:#dc2626">${pmsEsc(d.error)}</div>`);
  PMS.detail = d;
  const o = d.order, me = PMS.meta.me;
  const field = (l, v) => v ? `<div><span>${l}</span><b>${pmsEsc(v)}</b></div>` : '';
  const stepRow = s => {
    const canDone = s.status === 'open' && o.status === 'active' && (me.manager || !s.doer_id || s.doer_id === me.id);
    return `<div class="pm-step ${s.status}${s.late ? ' late' : ''}">
      <span class="pm-step-no">${s.step_no}</span>
      <div class="pm-step-body">
        <b>${pmsEsc(s.name)}</b> ${s.condition_key ? `<span class="pm-chip">Only if: ${pmsEsc(PMS.meta.conditions[s.condition_key])}</span>` : ''}
        <div class="pm-muted">${s.status === 'skipped' ? 'Skipped — does not apply'
          : `${pmsEsc(s.doer_name || 'Unassigned')}${s.vendor_name ? ' · Vendor: ' + pmsEsc(s.vendor_name) : ''} · TAT ${+s.tat_days} day${+s.tat_days === 1 ? '' : 's'}`}</div>
        ${s.status !== 'waiting' && s.status !== 'skipped' ? `<div class="pm-muted">Plan: <span class="${s.late ? 'pm-bad' : ''}">${pmsDateTime(s.planned_at)}</span>${s.actual_at ? ` · Actual: ${pmsDateTime(s.actual_at)}${s.done_by_name ? ' by ' + pmsEsc(s.done_by_name) : ''}` : ''}</div>` : ''}
        ${s.fill_value ? `<div class="pm-muted">${pmsEsc(s.fill_label || 'Value')}: <b>${pmsEsc(s.fill_value)}</b></div>` : ''}
        ${s.remarks ? `<div class="pm-note">${pmsEsc(s.remarks)}</div>` : ''}
      </div>
      <div class="pm-step-act">
        ${canDone ? `<button class="btn btn-primary btn-sm" onclick="pmsDoneModal(${s.id},${o.id})">✓ Done</button>` : ''}
        ${me.manager && (s.status === 'open' || s.status === 'waiting') && o.status !== 'cancelled'
          ? `<select title="Reassign" onchange="pmsReassign(${s.id},this.value,${o.id})">${pmsUserOpts(s.doer_id)}</select>` : ''}
      </div></div>`;
  };
  pmsModal(`
    <h3>${pmsTitle(o)} ${pmsStatusChip(o)}</h3>
    <div class="pm-detail">
      <div class="pm-detail-grid">
        ${field('Order code', o.order_code)}${o.order_no !== o.order_code ? field('Order no.', o.order_no) : ''}${field('Product', o.product)}${field('SKU', o.sku)}
        ${field('Category', o.category)}${field('Yarn / Fabric', o.yarn)}${field('Colour', o.color)}${field('Sizes', o.sizes)}
        ${field('Quantity', String(o.qty))}${field('Order type', o.order_type)}${field('Priority', o.priority)}
        ${field('Client phone', o.client_phone)}${field('Party / Store', o.party)}${field('Channel', o.channel)}
        ${field('Sales person', o.sales_person)}${field('Order date', pmsDate(o.order_date))}${field('Delivery date', o.delivery_date ? pmsDate(o.delivery_date) : '')}
        ${field('Unicommerce', o.uni_order_code)}${field('Created by', o.created_by_name)}
        ${o.flags.length ? `<div><span>Applies</span><b>${pmsFlagNames(o.flags).map(pmsEsc).join(', ')}</b></div>` : ''}
      </div>
      ${o.photo ? `<img class="pm-photo" src="${o.photo}" alt="Product photo"/>` : ''}
    </div>
    ${o.description ? `<div class="pm-note" style="margin:10px 0">${pmsEsc(o.description)}</div>` : ''}
    <div class="pm-actions" style="margin:12px 0">
      ${o.status === 'active' && me.manager ? `<button class="btn btn-outline btn-sm" onclick="pmsSetStatus(${o.id},'hold')">Put on hold</button>` : ''}
      ${o.status === 'hold' && me.manager ? `<button class="btn btn-outline btn-sm" onclick="pmsSetStatus(${o.id},'active')">Resume</button>` : ''}
      ${(o.status === 'active' || o.status === 'hold') && d.canCancel ? `<button class="btn btn-danger btn-sm" onclick="pmsSetStatus(${o.id},'cancelled')">Cancel order</button>` : ''}
      ${me.manager && o.status !== 'completed' ? `<button class="btn btn-outline btn-sm" onclick="pmsEditOrder(${o.id})">Edit details</button>` : ''}
    </div>
    <div class="pm-two">
      <div><div class="pm-sec">Steps · ${o.steps_done}/${o.steps_total} done</div>${d.steps.map(stepRow).join('')}</div>
      <div><div class="pm-sec">Update history</div>
        <div class="pm-add-update"><textarea id="pmUpdText" placeholder="Add an update / remark…"></textarea>
          <button class="btn btn-outline btn-sm" onclick="pmsAddUpdate(${o.id})">Add update</button></div>
        ${pmsTimeline(d.updates)}</div>
    </div>`, true);
}
function pmsTimeline(list) {
  return list.length ? `<div class="pm-timeline">${list.map(u => `
    <div class="pm-tl ${u.kind}"><div class="pm-muted">${pmsDateTime(u.created_at)} · ${pmsEsc(u.user_name || 'System')}</div>${pmsEsc(u.text)}</div>`).join('')}</div>`
    : '<div class="empty">No updates yet.</div>';
}
async function pmsRefreshAfter(orderId) {
  if (document.getElementById('pmsModal')?.classList.contains('open') && orderId) await pmsOrderDetail(orderId);
  if (PMS.tab === 'orders') pmsOrders(); else if (PMS.tab === 'tasks') pmsTasks(); else if (PMS.tab === 'dashboard') pmsDashboard();
  else if (PMS.tab === 'updates') pmsUpdates();
}
async function pmsReassign(stepId, userId, orderId) {
  const r = await api('/api/pms/order-steps/' + stepId, 'PUT', { doer_id: userId ? Number(userId) : null });
  if (r.error) return showToast(r.error, 'error');
  showToast('Reassigned'); pmsRefreshAfter(orderId);
}
async function pmsSetStatus(id, status) {
  const label = { hold: 'put this order on hold', active: 'resume this order', cancelled: 'cancel this order' }[status];
  const reason = prompt(`Why ${label}? (optional)`);
  if (reason === null) return;
  const r = await api(`/api/pms/orders/${id}/status`, 'POST', { status, reason });
  if (r.error) return showToast(r.error, 'error');
  showToast('Saved'); pmsRefreshAfter(id);
}
async function pmsAddUpdate(id) {
  const text = document.getElementById('pmUpdText').value.trim();
  if (!text) return showToast('Write the update first', 'error');
  const r = await api(`/api/pms/orders/${id}/updates`, 'POST', { text });
  if (r.error) return showToast(r.error, 'error');
  showToast('Update added'); pmsRefreshAfter(id);
}

// ── Mark Done (PM Decision on the first step) ─────────
async function pmsDoneModal(stepId, orderId) {
  if (!PMS.detail || PMS.detail.order.id !== orderId) {
    const d = await api('/api/pms/orders/' + orderId);
    if (d.error) return showToast(d.error, 'error');
    PMS.detail = d;
  }
  const { order: o, steps } = PMS.detail;
  const s = steps.find(x => x.id === stepId);
  if (!s) return;
  const isDecision = s.step_no === Math.min(...steps.map(x => x.step_no));
  const later = steps.filter(x => x.status === 'waiting');
  const conds = PMS.meta.conditions;
  pmsModal(`
    <h3>Step ${s.step_no} · ${pmsEsc(s.name)}</h3>
    <div class="pm-muted" style="margin:-10px 0 14px">${pmsTitle(o)} · ${pmsEsc(o.product)} × ${o.qty}</div>
    ${isDecision ? `
      <div class="pm-sec">Which steps apply to this order?</div>
      <div class="pm-flags">${Object.entries(conds).map(([k, l]) => `
        <label><input type="checkbox" class="pmFlag" value="${k}"${o.flags.includes(k) ? ' checked' : ''} onchange="pmsDecisionSkip()"/> ${pmsEsc(l)}</label>`).join('')}</div>
      <div class="pm-sec">Who does each step</div>
      <table class="pm-assign"><thead><tr><th>Step</th><th>Doer</th><th>Vendor</th></tr></thead><tbody>
      ${later.map(x => `<tr data-id="${x.id}" data-cond="${x.condition_key || ''}">
        <td><b>S${x.step_no}</b> ${pmsEsc(x.name)}<div class="pm-muted pm-skipnote" style="display:none">Will be skipped</div></td>
        <td><select class="pmDoer">${pmsUserOpts(x.doer_id)}</select></td>
        <td>${x.uses_vendor ? `<select class="pmVendor">${pmsVendorOpts(x.vendor_id)}</select>` : '<span class="pm-muted">—</span>'}</td></tr>`).join('')}
      </tbody></table>` : `
      ${s.fill_label ? `<div class="form-group"><label>${pmsEsc(s.fill_label)}</label><input id="pmFill"/></div>` : ''}
      ${s.uses_vendor ? `<div class="form-group"><label>Vendor</label><select id="pmDoneVendor">${pmsVendorOpts(s.vendor_id)}</select></div>` : ''}`}
    <div class="form-group"><label>Remarks / instructions</label><textarea id="pmRemarks" placeholder="Optional"></textarea></div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="pmsOrderDetail(${o.id})">Back</button>
      <button class="btn btn-primary" id="pmDoneBtn" onclick="pmsSubmitDone(${s.id},${o.id},${isDecision})">✓ Mark Done</button></div>`, isDecision);
  if (isDecision) pmsDecisionSkip();
}
function pmsDecisionSkip() {
  const flags = [...document.querySelectorAll('.pmFlag:checked')].map(c => c.value);
  document.querySelectorAll('.pm-assign tr[data-id]').forEach(tr => {
    const off = tr.dataset.cond && !flags.includes(tr.dataset.cond);
    tr.classList.toggle('pm-off', !!off);
    tr.querySelector('.pm-skipnote').style.display = off ? '' : 'none';
  });
}
async function pmsSubmitDone(stepId, orderId, isDecision) {
  const body = { remarks: document.getElementById('pmRemarks').value };
  if (isDecision) {
    body.flags = [...document.querySelectorAll('.pmFlag:checked')].map(c => c.value);
    body.assign = [...document.querySelectorAll('.pm-assign tr[data-id]')].map(tr => ({
      id: +tr.dataset.id, doer_id: +tr.querySelector('.pmDoer').value || null,
      vendor_id: tr.querySelector('.pmVendor') ? (+tr.querySelector('.pmVendor').value || null) : null,
    }));
  } else {
    const f = document.getElementById('pmFill'); if (f) body.fill_value = f.value;
    const v = document.getElementById('pmDoneVendor'); if (v) body.vendor_id = +v.value || null;
  }
  const btn = document.getElementById('pmDoneBtn'); btn.disabled = true;
  const r = await api(`/api/pms/order-steps/${stepId}/done`, 'POST', body);
  btn.disabled = false;
  if (r.error) return showToast(r.error, 'error');
  showToast(r.next ? `Done — next: ${r.next}` : 'Done — order completed 🎉');
  PMS.detail = null;
  pmsCloseModal();
  pmsRefreshAfter(null);
}

// ── New Order / Edit ──────────────────────────────────
function pmsOrderForm(o = {}, edit = false) {
  const v = k => pmsEsc(o[k] == null ? '' : o[k]);
  const sel = (k, opts) => opts.map(([val, l]) => `<option value="${val}"${String(o[k] || '') === val ? ' selected' : ''}>${l}</option>`).join('');
  return `
    <div class="pm-form-sec"><div class="pm-sec">Client Details <span class="pm-muted">Who the client is and where the order came from</span></div>
      <div class="pm-grid">
        <div class="form-group"><label>Client Name *</label><input id="pf_client_name" value="${v('client_name')}"/></div>
        <div class="form-group"><label>Client Phone</label><input id="pf_client_phone" value="${v('client_phone')}"/></div>
        <div class="form-group"><label>Party / Store (B2B)</label><input id="pf_party" value="${v('party')}" placeholder="Leave blank for a D2C customer"/></div>
        <div class="form-group"><label>Channel</label><input id="pf_channel" value="${v('channel')}" placeholder="Website, Myntra, Store, B2B…"/></div>
        <div class="form-group"><label>Sales Person</label><select id="pf_sales_person_id">${pmsUserOpts(o.sales_person_id, '— Unassigned (goes to PM) —')}</select></div>
        <div class="form-group"><label>Order No.</label><input id="pf_order_no" value="${v('order_no')}" placeholder="Leave blank = auto (ORD-0001)"/></div>
      </div></div>
    <div class="pm-form-sec"><div class="pm-sec">Product Details <span class="pm-muted">What needs to be made</span></div>
      <div class="pm-grid">
        <div class="form-group pm-span2"><label>Product *</label><input id="pf_product" value="${v('product')}" placeholder="e.g. Cable-knit Cotton Cardigan"/></div>
        <div class="form-group"><label>SKU / Style no.</label><input id="pf_sku" value="${v('sku')}"/></div>
        <div class="form-group"><label>Category</label><select id="pf_category">${sel('category', [['', '— Select —'], ['Sweater', 'Sweater'], ['Cardigan', 'Cardigan'], ['Co-ord Set', 'Co-ord Set'], ['Dress', 'Dress'], ['Top', 'Top'], ['Bottom', 'Bottom'], ['Kids', 'Kids'], ['Accessory', 'Accessory'], ['Other', 'Other']])}</select></div>
        <div class="form-group"><label>Yarn / Fabric</label><input id="pf_yarn" value="${v('yarn')}" placeholder="e.g. Cotton 2/30s, Acrylic-wool"/></div>
        <div class="form-group"><label>Colour</label><input id="pf_color" value="${v('color')}"/></div>
        <div class="form-group"><label>Size breakup</label><input id="pf_sizes" value="${v('sizes')}" placeholder="S:10, M:20, L:15"/></div>
        <div class="form-group"><label>Quantity (pcs)</label><input id="pf_qty" type="number" min="1" value="${v('qty') || 1}"/></div>
        <div class="form-group"><label>Order Type</label><select id="pf_order_type">${sel('order_type', [['new', 'New design'], ['repeat', 'Repeat'], ['sample', 'Sample only']])}</select></div>
        <div class="form-group"><label>Priority</label><select id="pf_priority">${sel('priority', [['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']])}</select></div>
        ${edit ? '' : `<div class="form-group pm-span2"><label>Likely to need (PM confirms at Step 1)</label><div class="pm-flags">${Object.entries(PMS.meta.conditions).map(([k, l]) =>
          `<label><input type="checkbox" class="pfFlag" value="${k}"${(o.flags || []).includes(k) ? ' checked' : ''}/> ${pmsEsc(l)}</label>`).join('')}</div></div>`}
        <div class="form-group pm-span2"><label>Description / Details</label><textarea id="pf_description" placeholder="Design details, stitch, reference, trims…">${v('description')}</textarea></div>
        <div class="form-group"><label>Product Photo</label><input type="file" id="pf_photo" accept="image/*" onchange="pmsPhoto(this)"/>
          <img id="pf_photo_prev" class="pm-photo small" ${o.photo ? `src="${o.photo}"` : 'style="display:none"'}/></div>
      </div></div>
    <div class="pm-form-sec"><div class="pm-sec">Dates</div>
      <div class="pm-grid">
        <div class="form-group"><label>Order Date</label><input id="pf_order_date" type="date" value="${v('order_date') || PMS.meta.today}"/>
          <div class="pm-muted">Step 1 plan date is calculated from this.</div></div>
        <div class="form-group"><label>Client Delivery Date</label><input id="pf_delivery_date" type="date" value="${v('delivery_date')}"/></div>
      </div></div>`;
}
function pmsPhoto(input) {
  const f = input.files[0];
  PMS.photo = undefined;
  if (!f) return;
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, 1200 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    PMS.photo = c.toDataURL('image/jpeg', 0.82);
    const p = document.getElementById('pf_photo_prev'); p.src = PMS.photo; p.style.display = '';
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(f);
}
function pmsReadForm() {
  const b = {};
  ['client_name', 'client_phone', 'party', 'channel', 'sales_person_id', 'order_no', 'product', 'sku', 'category', 'yarn', 'color',
    'sizes', 'qty', 'order_type', 'priority', 'description', 'order_date', 'delivery_date'].forEach(k => {
    const el = document.getElementById('pf_' + k); if (el) b[k] = el.value.trim();
  });
  if (document.querySelector('.pfFlag')) b.flags = [...document.querySelectorAll('.pfFlag:checked')].map(c => c.value);
  if (PMS.photo !== undefined) b.photo = PMS.photo;
  return b;
}

function pmsNewOrder() {
  PMS.photo = undefined;
  const pre = PMS.newPrefill || {};
  pmView(`
    <div class="pm-hero"><div><h2>New Order</h2><p>Once the order is created, Step 1 (${pmsEsc(PMS.meta.steps[0]?.name || 'PM Decision')}) goes to the PM. Step 1 plan date = Order date + TAT.</p></div></div>
    <div class="pm-card pm-pad">
      <div class="pm-uni">
        <div class="pm-sec">Pull from an order <span class="pm-muted">optional — fills the form for you</span></div>
        <div class="pm-filters"><input id="pmUniQ" placeholder="Website order: customer name, phone, email or order no. · Myntra: order ID" onkeydown="if(event.key==='Enter')pmsUniSearch()"/>
          <button class="btn btn-outline" onclick="pmsUniSearch()">Search</button></div>
        <div id="pmUniResults"></div>
        ${pre.uni_order_code ? `<div class="pm-note">Linked to Unicommerce order <b>${pmsEsc(pre.uni_order_code)}</b> <a onclick="PMS.newPrefill=null;pmsNewOrder()">remove</a></div>` : ''}
      </div>
      ${pmsOrderForm(pre)}
      <div class="modal-footer"><button class="btn btn-outline" onclick="PMS.newPrefill=null;pmsGo('dashboard')">Cancel</button>
        <button class="btn btn-primary" id="pmCreateBtn" onclick="pmsCreateOrder()">✓ Create Order</button></div>
    </div>`);
}
async function pmsUniSearch() {
  const q = document.getElementById('pmUniQ').value.trim();
  const box = document.getElementById('pmUniResults');
  box.innerHTML = '<div class="pm-muted">Searching…</div>';
  const d = await api('/api/pms/uni-orders?q=' + encodeURIComponent(q));
  if (d.error) { box.innerHTML = `<div class="pm-bad">${pmsEsc(d.error)}</div>`; return; }
  PMS.uni = d.orders;
  box.innerHTML = d.orders.length ? `<div class="pm-uni-list">${d.orders.map((u, i) => `
    <div class="pm-row">
      <div><b>${pmsEsc(u.display_code || u.code)}</b> · ${u.customer_name ? pmsEsc(u.customer_name) : '<span class="pm-muted">buyer not shared by Myntra</span>'}${u.notification_mobile ? ` <span class="pm-muted">· ${pmsEsc(u.notification_mobile)}</span>` : ''} <span class="pm-muted">${pmsEsc(u.channel || '')} · ${pmsDate(u.order_date)} · ${u.items.length} item${u.items.length === 1 ? '' : 's'}${u.ship_city ? ' · ' + pmsEsc(u.ship_city) : ''}</span>
        <div class="pm-muted">${u.items.slice(0, 3).map(it => pmsEsc(it.item_name || it.sku)).join(' · ')}</div></div>
      <div class="pm-right">${u.pms_code ? `<span class="pm-chip good">In PMS · ${pmsEsc(u.pms_code)}</span>` : `<button class="btn btn-outline btn-sm" onclick="pmsUniPick(${i})">Use</button>`}</div>
    </div>`).join('')}</div>` : '<div class="pm-muted">No order matches. Website orders can be found by customer name, phone, email or order number; Myntra orders only by their order ID.</div>';
}
function pmsUniPick(i) {
  const u = PMS.uni[i];
  const it = u.items[0] || {};
  const sizes = {};
  u.items.forEach(x => { if (x.size) sizes[x.size] = (sizes[x.size] || 0) + 1; });
  PMS.newPrefill = {
    uni_order_code: u.code, order_no: u.display_code || u.code, client_name: u.customer_name || '', client_phone: u.notification_mobile || '',
    channel: u.channel || '', product: u.items.length > 1 ? `${it.item_name || it.sku} + ${u.items.length - 1} more` : (it.item_name || it.sku || ''),
    sku: it.sku || '', color: it.color || '', qty: u.items.length || 1,
    sizes: Object.entries(sizes).map(([k, n]) => `${k}:${n}`).join(', '), order_date: (u.order_date || '').slice(0, 10),
    description: u.items.map(x => `${x.sku || ''} ${x.item_name || ''} ${x.color || ''} ${x.size || ''}`.trim()).join('\n')
      + ((u.email || u.ship_city) ? '\n' + [u.email ? 'Email: ' + u.email : '', u.ship_city ? 'City: ' + u.ship_city : ''].filter(Boolean).join(' · ') : ''),
  };
  pmsNewOrder();
}
async function pmsCreateOrder() {
  const b = pmsReadForm();
  if (!b.client_name) return showToast('Client name is required', 'error');
  if (!b.product) return showToast('Product is required', 'error');
  if (PMS.newPrefill?.uni_order_code) b.uni_order_code = PMS.newPrefill.uni_order_code;
  const btn = document.getElementById('pmCreateBtn'); btn.disabled = true;
  const r = await api('/api/pms/orders', 'POST', b);
  btn.disabled = false;
  if (r.error) return showToast(r.error, 'error');
  PMS.newPrefill = null;
  showToast(`Order ${r.order_code} created`);
  PMS.orderTab = 'active'; PMS.stepFilter = '';
  pmsGo('orders');
  pmsOrderDetail(r.id);
}
function pmsEditOrder(id) {
  const o = PMS.detail.order;
  PMS.photo = undefined;
  pmsModal(`<h3>Edit ${pmsEsc(o.order_code)}</h3>${pmsOrderForm(o, true)}
    <div class="modal-footer"><button class="btn btn-outline" onclick="pmsOrderDetail(${id})">Back</button>
      <button class="btn btn-primary" onclick="pmsSaveEdit(${id})">Save</button></div>`, true);
}
async function pmsSaveEdit(id) {
  const r = await api('/api/pms/orders/' + id, 'PUT', pmsReadForm());
  if (r.error) return showToast(r.error, 'error');
  showToast('Saved'); pmsRefreshAfter(id);
}

// ── Order Update ──────────────────────────────────────
function pmsRange(r) {
  const t = PMS.meta.today, d = new Date(t + 'T00:00:00Z');
  const back = n => new Date(d.getTime() - n * 864e5).toISOString().slice(0, 10);
  if (r === 'today') return [t, t];
  if (r === 'week') return [back((d.getUTCDay() + 6) % 7), t];
  if (r === 'month') return [t.slice(0, 8) + '01', t];
  if (r === '30') return [back(29), t];
  return [back(364), t];
}
async function pmsUpdates() {
  const [from, to] = pmsRange(PMS.upd.range);
  const q = PMS.upd.q || '';
  const d = await api(`/api/pms/updates?from=${from}&to=${to}&q=${encodeURIComponent(q)}`);
  if (d.error) return pmView(`<div class="empty" style="color:#dc2626">${pmsEsc(d.error)}</div>`);
  pmView(`
    <div class="pm-hero"><div><h2>Order Update</h2><p>Search any order and see its complete update history — every step, change and remark.</p></div></div>
    <div class="pm-filters">
      <input id="pmUpdQ" value="${pmsEsc(q)}" placeholder="Search order code, order no, client, phone…" onkeydown="if(event.key==='Enter'){PMS.upd.q=this.value;pmsUpdates()}"/>
      <select onchange="PMS.upd.range=this.value;pmsUpdates()">${[['today', 'Today'], ['week', 'This Week'], ['month', 'This Month'], ['30', 'Last 30 days'], ['year', 'Last 12 months']]
        .map(([k, l]) => `<option value="${k}"${k === PMS.upd.range ? ' selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="pm-two upd">
      <div class="pm-card"><div class="pm-card-head"><b>Orders updated</b><span class="pm-muted">${d.orders.length} orders · ${pmsDate(from)} – ${pmsDate(to)}</span></div>
        ${d.orders.length ? d.orders.map(o => `
          <div class="pm-row${PMS.upd.sel === o.id ? ' sel' : ''}" onclick="PMS.upd.sel=${o.id};pmsUpdHistory(${o.id});document.querySelectorAll('.upd .pm-row').forEach(r=>r.classList.remove('sel'));this.classList.add('sel')">
            <div><b>${pmsEsc(o.order_code)} · ${pmsEsc(o.client_name)}</b><div class="pm-muted">${pmsEsc(o.product)} · ${o.updates} update${o.updates > 1 ? 's' : ''}</div></div>
            <div class="pm-right pm-muted">${pmsAgo(o.last_at)}</div></div>`).join('') : '<div class="empty">No order updates in the selected dates</div>'}</div>
      <div class="pm-card" id="pmUpdRight"><div class="empty">Select an order to see its update history</div></div>
    </div>`);
  if (PMS.upd.sel) pmsUpdHistory(PMS.upd.sel);
}
async function pmsUpdHistory(id) {
  const box = document.getElementById('pmUpdRight');
  box.innerHTML = '<div class="empty">Loading…</div>';
  const d = await api('/api/pms/orders/' + id);
  if (d.error) { box.innerHTML = `<div class="empty">${pmsEsc(d.error)}</div>`; return; }
  const o = d.order;
  box.innerHTML = `<div class="pm-card-head"><b>${pmsTitle(o)}</b><a onclick="pmsOrderDetail(${o.id})">Open order →</a></div>
    <div class="pm-pad"><div class="pm-muted" style="margin-bottom:10px">${pmsEsc(o.product)} · Qty ${o.qty} · ${o.current ? 'At S' + o.current.step_no + ' · ' + pmsEsc(o.current.name) : ''} ${pmsStatusChip(o)}</div>
      <div class="pm-add-update"><textarea id="pmUpdText" placeholder="Add an update / remark…"></textarea>
        <button class="btn btn-outline btn-sm" onclick="pmsAddUpdate(${o.id})">Add update</button></div>
      ${pmsTimeline(d.updates)}</div>`;
}

// ── Workflow (read-only explainer, built from the live steps) ──
function pmsWorkflow() {
  const steps = PMS.meta.steps.filter(s => s.active);
  const conds = PMS.meta.conditions;
  const blocks = [];
  steps.forEach(s => {
    const last = blocks[blocks.length - 1];
    if (last && last.cond === (s.condition_key || null)) last.steps.push(s);
    else blocks.push({ cond: s.condition_key || null, steps: [s] });
  });
  const card = s => `<div class="pm-wf-step"><span class="pm-step-no">${s.step_no}</span><div><b>${pmsEsc(s.name)}</b>
    ${s.uses_vendor ? '<span class="pm-chip uni">vendor</span>' : ''}
    <div class="pm-muted">👤 ${pmsEsc(s.doer_label || 'Doer')}${s.default_user_name ? ' · Default: <b>' + pmsEsc(s.default_user_name) + '</b>' : ''} · ⏱ TAT: <b>${+s.tat_days} day${+s.tat_days === 1 ? '' : 's'}</b>
    ${s.fill_label ? ' · Fill: ' + pmsEsc(s.fill_label) : ''}</div></div></div>`;
  pmView(`
    <div class="pm-hero"><div><h2>Workflow — ${steps.length} Steps</h2><p>How every order moves through PMS, from the order form to dispatch. Read it top to bottom.</p></div></div>
    <div class="pm-card pm-pad">
      <div class="pm-sec">How it works in 5 points</div>
      <div class="pm-five">
        <div><b>1 · Order comes in</b>From the New Order form or picked from a Unicommerce order. It gets an automatic Order Code (ORD-0001) that never changes.</div>
        <div><b>2 · Step 1 opens</b>Planned = Order date + TAT (from 10:00 AM). The PM ticks which steps apply and picks the doer / vendor for each.</div>
        <div><b>3 · Steps run in order</b>One after another. A step whose condition is NO is skipped and the next one opens.</div>
        <div><b>4 · Done → next step</b>When a doer clicks Done, the Actual is recorded and the next step opens with Planned = Actual + TAT.</div>
        <div><b>5 · Late → red</b>Past the Planned date the step and the order turn Delayed on the Dashboard and in Orders.</div>
      </div>
    </div>
    <div class="pm-card pm-pad pm-flow">
      <div class="pm-flow-cap start">Order received<small>New Order form or Unicommerce · Order Code is created</small></div>
      ${blocks.map(b => `<div class="pm-flow-arrow"></div>${b.cond
        ? `<div class="pm-flow-group"><div class="pm-flow-if"><div>Only if: <b>${pmsEsc(conds[b.cond])} = YES</b></div><span>If NO → skipped</span></div>${b.steps.map(card).join('')}</div>`
        : b.steps.map(card).join('<div class="pm-flow-arrow"></div>')}`).join('')}
      <div class="pm-flow-arrow"></div><div class="pm-flow-cap end">Order completed<small>Shown in the Completed tab</small></div>
    </div>
    <div class="pm-two">
      <div class="pm-card pm-pad"><div class="pm-sec">How the Planned date is calculated</div><ul class="pm-list">
        <li><b>Step 1:</b> Order date + TAT, counted from 10:00 AM.</li>
        <li><b>Every next step:</b> Actual of the previous step + TAT.</li>
        <li>Done <b>after 6 PM</b> → TAT counts from 10:00 AM of the next working day.</li>
        <li>Done <b>before 10 AM</b> → TAT counts from 10:00 AM the same day. <b>Sunday</b> is a holiday.</li>
        <li>Every step's TAT and default doer can be changed in <b>Settings</b>.</li></ul></div>
      <div class="pm-card pm-pad"><div class="pm-sec">Order rules</div><ul class="pm-list">
        <li><b>Order Code</b> — ORD-0001… is fixed for life; search with it anywhere.</li>
        <li><b>Cancel within 24 hours</b> — the creator can cancel their own order for 24 hours. Admin / PC / HOD can cancel any time.</li>
        <li><b>Cancelled orders</b> are hidden from doers; Admin / PC / HOD still see them under Hold / Cancelled.</li>
        <li><b>Hold</b> freezes the order — no step can be marked Done until it is resumed.</li>
        <li><b>Unicommerce</b> — one Unicommerce order can be pulled into PMS only once.</li></ul></div>
    </div>
    <div class="pm-card pm-table-wrap"><div class="pm-card-head"><b>All ${steps.length} steps at a glance</b><span class="pm-muted">A step that does not apply is skipped and the next opens straight away.</span></div>
      <table><thead><tr><th>#</th><th>Step</th><th>When it applies</th><th>Opens after</th><th>Doer</th><th>TAT</th><th>What to fill</th></tr></thead><tbody>
      ${steps.map((s, i) => `<tr><td>${s.step_no}</td><td><b>${pmsEsc(s.name)}</b></td><td>${s.condition_key ? 'If ' + pmsEsc(conds[s.condition_key]) + ' = YES' : 'Always'}</td>
        <td>${i ? 'Step ' + steps[i - 1].step_no : 'Order created'}</td><td>${pmsEsc(s.doer_label)}${s.default_user_name ? ' · Default: <b>' + pmsEsc(s.default_user_name) + '</b>' : ''}</td>
        <td>${+s.tat_days} day${+s.tat_days === 1 ? '' : 's'}</td><td>${i ? (s.fill_label ? pmsEsc(s.fill_label) : 'Just mark Done (remarks optional)') : 'Which steps apply + doer / vendor per step'}</td></tr>`).join('')}
      </tbody></table></div>`);
}

// ── Vendors ───────────────────────────────────────────
async function pmsVendors() {
  const list = await api('/api/pms/vendors');
  if (list.error) return pmView(`<div class="empty" style="color:#dc2626">${pmsEsc(list.error)}</div>`);
  PMS.vendorList = list;
  pmView(`
    <div class="pm-hero"><div><h2>Vendors</h2><p>Yarn, knitting, dyeing, embroidery and other job-work vendors. Vendors for a step are picked from this list.</p></div>
      ${PMS.meta.me.manager ? '<div class="pm-actions"><button class="btn btn-primary" onclick="pmsVendorModal()">+ Add Vendor</button></div>' : ''}</div>
    <div class="pm-filters"><input id="pmVq" placeholder="Search vendor, phone, category…" oninput="pmsRenderVendors()"/>
      <label class="pm-check"><input type="checkbox" id="pmVin" onchange="pmsRenderVendors()"/> Show inactive too</label></div>
    <div class="pm-card pm-table-wrap" id="pmVendorTable"></div>`);
  pmsRenderVendors();
}
function pmsRenderVendors() {
  const q = (document.getElementById('pmVq').value || '').toLowerCase(), inact = document.getElementById('pmVin').checked;
  const rows = PMS.vendorList.filter(v => (inact || v.active) && (!q || [v.name, v.phone, v.category].some(x => String(x || '').toLowerCase().includes(q))));
  document.getElementById('pmVendorTable').innerHTML = rows.length ? `<table><thead><tr><th>Vendor</th><th>Phone</th><th>Category</th><th style="text-align:right">Open orders</th><th style="text-align:right">Total</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map(v => `<tr><td><b>${pmsEsc(v.name)}</b>${v.address ? `<div class="pm-muted">${pmsEsc(v.address)}</div>` : ''}</td><td>${pmsEsc(v.phone)}</td>
      <td>${v.category ? `<span class="pm-chip">${pmsEsc(v.category)}</span>` : ''}</td><td style="text-align:right">${v.open_orders}</td><td style="text-align:right">${v.total_orders}</td>
      <td>${v.active ? '<span class="pm-chip good">Active</span>' : '<span class="pm-chip">Inactive</span>'}</td>
      <td style="text-align:right">${PMS.meta.me.manager ? `<button class="btn btn-outline btn-sm" onclick="pmsVendorModal(${v.id})">Edit</button>` : ''}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No vendors yet.</div>';
}
function pmsVendorModal(id) {
  const v = id ? PMS.vendorList.find(x => x.id === id) : { active: 1 };
  const e = k => pmsEsc(v[k] || '');
  pmsModal(`<h3>${id ? 'Edit' : 'Add'} Vendor</h3>
    <div class="pm-grid">
      <div class="form-group"><label>Vendor Name *</label><input id="pv_name" value="${e('name')}"/></div>
      <div class="form-group"><label>Phone</label><input id="pv_phone" value="${e('phone')}"/></div>
      <div class="form-group"><label>Category</label><input id="pv_category" value="${e('category')}" list="pmVcats" placeholder="Yarn, Knitting, Dyeing, Embroidery…"/>
        <datalist id="pmVcats"><option>Yarn</option><option>Knitting</option><option>Linking</option><option>Dyeing / Washing</option><option>Embroidery / Print</option><option>Trims & Labels</option><option>Packing</option></datalist></div>
      <div class="form-group"><label>Address</label><input id="pv_address" value="${e('address')}"/></div>
      <div class="form-group pm-span2"><label>Notes</label><textarea id="pv_notes">${e('notes')}</textarea></div>
      ${id ? `<label class="pm-check"><input type="checkbox" id="pv_active"${v.active ? ' checked' : ''}/> Active</label>` : ''}
    </div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="pmsCloseModal()">Cancel</button><button class="btn btn-primary" onclick="pmsSaveVendor(${id || 0})">✓ Save</button></div>`);
}
async function pmsSaveVendor(id) {
  const b = {}; ['name', 'phone', 'category', 'address', 'notes'].forEach(k => { b[k] = document.getElementById('pv_' + k).value.trim(); });
  const a = document.getElementById('pv_active'); if (a) b.active = a.checked;
  if (!b.name) return showToast('Vendor name is required', 'error');
  const r = await api('/api/pms/vendors' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', b);
  if (r.error) return showToast(r.error, 'error');
  showToast('Vendor saved'); pmsCloseModal();
  PMS.meta = await api('/api/pms/meta');
  pmsVendors();
}

// ── Settings: edit the workflow template ──────────────
function pmsSettings() {
  PMS.edit = PMS.meta.steps.map(s => ({ ...s }));
  pmsRenderSettings();
}
function pmsRenderSettings() {
  const conds = PMS.meta.conditions;
  pmView(`
    <div class="pm-hero"><div><h2>Workflow Settings</h2><p>Steps, TAT and default doers. Changes apply to <b>new</b> orders — orders already created keep their own copy.</p></div>
      <div class="pm-actions"><button class="btn btn-outline" onclick="pmsSettingsAdd()">+ Add step</button><button class="btn btn-primary" onclick="pmsSettingsSave()">✓ Save workflow</button></div></div>
    <div class="pm-card pm-table-wrap"><table class="pm-settings"><thead><tr><th>#</th><th>Step name</th><th>Doer (label)</th><th>Default doer</th><th>TAT (days)</th><th>Runs only if</th><th>What to fill</th><th>Vendor</th><th>On</th><th></th></tr></thead><tbody>
    ${PMS.edit.map((s, i) => `<tr class="${s.active ? '' : 'pm-off'}">
      <td>${i + 1}</td>
      <td><input value="${pmsEsc(s.name)}" onchange="PMS.edit[${i}].name=this.value"/></td>
      <td><input value="${pmsEsc(s.doer_label)}" onchange="PMS.edit[${i}].doer_label=this.value"/></td>
      <td><select onchange="PMS.edit[${i}].default_user_id=+this.value||null">${pmsUserOpts(s.default_user_id, '—')}</select></td>
      <td><input type="number" min="0" step="0.5" style="width:70px" value="${+s.tat_days}" onchange="PMS.edit[${i}].tat_days=this.value"/></td>
      <td>${i === 0 ? '<span class="pm-muted">Always (decision)</span>' : `<select onchange="PMS.edit[${i}].condition_key=this.value||null"><option value="">Always</option>${Object.entries(conds).map(([k, l]) => `<option value="${k}"${s.condition_key === k ? ' selected' : ''}>${pmsEsc(l)}</option>`).join('')}</select>`}</td>
      <td><input value="${pmsEsc(s.fill_label)}" placeholder="optional" onchange="PMS.edit[${i}].fill_label=this.value"/></td>
      <td><input type="checkbox"${s.uses_vendor ? ' checked' : ''} onchange="PMS.edit[${i}].uses_vendor=this.checked"/></td>
      <td><input type="checkbox"${s.active ? ' checked' : ''} onchange="PMS.edit[${i}].active=this.checked;pmsRenderSettings()"/></td>
      <td class="pm-nowrap"><button class="btn btn-outline btn-sm" ${i ? '' : 'disabled'} onclick="pmsSettingsMove(${i},-1)">↑</button>
        <button class="btn btn-outline btn-sm" ${i < PMS.edit.length - 1 ? '' : 'disabled'} onclick="pmsSettingsMove(${i},1)">↓</button>
        <button class="btn btn-outline btn-sm" onclick="PMS.edit.splice(${i},1);pmsRenderSettings()">✕</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="pm-muted" style="margin-top:10px">The first step is always the PM Decision: whoever closes it ticks which conditional steps apply and picks the doer / vendor for every later step.
      Office hours are 10:00 AM – 6:00 PM, Sunday off.</div>`);
}
function pmsSettingsMove(i, d) { const a = PMS.edit; [a[i], a[i + d]] = [a[i + d], a[i]]; pmsRenderSettings(); }
function pmsSettingsAdd() { PMS.edit.push({ name: 'New step', doer_label: '', default_user_id: null, tat_days: 1, condition_key: null, fill_label: '', uses_vendor: 0, active: 1 }); pmsRenderSettings(); }
async function pmsSettingsSave() {
  if (PMS.edit[0]) PMS.edit[0].condition_key = null;
  const r = await api('/api/pms/workflow', 'PUT', { steps: PMS.edit });
  if (r.error) return showToast(r.error, 'error');
  showToast('Workflow saved');
  PMS.meta = await api('/api/pms/meta');
  pmsSettings();
}
