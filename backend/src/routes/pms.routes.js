// ══════════════════════════════════════════════════════
// PMS — Production Management.
// An order comes in (New Order form, or picked from the synced Unicommerce
// orders), gets an ORD-0001 code, and walks the workflow one step at a time:
// the first step is the PM Decision, which says which conditional steps apply
// and who does each one. Done on a step opens the next; Planned = Actual of the
// previous step + TAT, counted in office hours.
//
// Time: every PMS DATETIME is IST wall-clock and is written as a string built
// here from Date.now(). Prod MySQL runs in UTC and the server's own zone is
// not something to trust, so neither NOW() nor new Date() decides "today".
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();

const MANAGERS = ['admin', 'pc', 'hod'];
const isManager = req => MANAGERS.includes(req.session.role);
const requireManager = (req, res, next) =>
  isManager(req) ? next() : res.status(403).json({ error: 'Only Admin / PC / HOD can do this.' });

// Conditional steps run only when the PM Decision ticks their flag.
const CONDITIONS = {
  sample: 'Sample required',
  dyeing: 'Dyeing / Washing',
  embellish: 'Embroidery / Print',
};

// The default knitwear workflow, seeded once into pms_steps. Settings edits it.
const DEFAULT_STEPS = [
  ['Order Review / PM Decision', 'Production Manager', 1, null, 'Steps that apply + doers', 0],
  ['Design & Tech Pack', 'Designer', 2, null, '', 0],
  ['Sample Making', 'Sampling Team', 3, 'sample', '', 0],
  ['Sample Approval', 'Sales Person / Client', 2, 'sample', '', 0],
  ['Yarn Sourcing', 'Purchase Team', 4, null, 'Yarn qty (kg)', 1],
  ['Knitting', 'Knitting Unit', 3, null, 'Pcs knitted', 1],
  ['Linking', 'Linking Team', 2, null, 'Pcs linked', 0],
  ['Dyeing / Washing', 'Dyeing / Washing vendor', 3, 'dyeing', '', 1],
  ['Embroidery / Print', 'Embellishment vendor', 3, 'embellish', '', 1],
  ['Checking / QC', 'Quality Checker', 1, null, 'Pcs passed QC', 0],
  ['Ironing & Finishing', 'Finishing Team', 1, null, '', 0],
  ['Labels & Tagging', 'Inventory Team', 1, null, 'SKU / Barcode', 0],
  ['Packing', 'Packing Team', 1, null, 'Pcs packed', 0],
  ['Dispatch', 'Logistics', 1, null, 'AWB / Tracking no.', 0],
];

const OFFICE_START = 10;   // TAT counts from 10:00 AM
const OFFICE_END = 18;     // done after 6 PM → counts from 10:00 next working day
const OFFICE_HOURS = OFFICE_END - OFFICE_START;

// ── IST clock ─────────────────────────────────────────
// A "wall" Date holds IST wall-clock in its UTC fields, so getUTC*() read IST
// no matter what zone the process runs in.
const pad = n => String(n).padStart(2, '0');
const wallNow = () => new Date(Date.now() + 330 * 60000);
const toWall = s => new Date(String(s).replace(' ', 'T') + (String(s).length <= 10 ? 'T00:00:00Z' : 'Z'));
const fmtWall = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const nowIST = () => fmtWall(wallNow());
const todayIST = () => nowIST().slice(0, 10);

const setHour = (d, h) => { d.setUTCHours(h, 0, 0, 0); return d; };
const nextDay = d => { d.setUTCDate(d.getUTCDate() + 1); return d; };
const skipSunday = d => { while (d.getUTCDay() === 0) setHour(nextDay(d), OFFICE_START); return d; };

// Planned = start + TAT working days. Whole days skip Sundays; a half day is
// half the office hours and rolls into the next morning if it runs past 6 PM.
function planFrom(startStr, tatDays) {
  const d = toWall(startStr);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (h < OFFICE_START) setHour(d, OFFICE_START);
  else if (h >= OFFICE_END) setHour(nextDay(d), OFFICE_START);
  skipSunday(d);
  const tat = Math.max(0, Number(tatDays) || 0);
  for (let i = 0; i < Math.floor(tat); i++) { nextDay(d); while (d.getUTCDay() === 0) nextDay(d); }
  let extra = (tat % 1) * OFFICE_HOURS * 60;   // minutes
  if (extra > 0) {
    const left = (OFFICE_END * 60) - (d.getUTCHours() * 60 + d.getUTCMinutes());
    if (extra <= left) d.setUTCMinutes(d.getUTCMinutes() + extra);
    else { setHour(nextDay(d), OFFICE_START); skipSunday(d); d.setUTCMinutes(extra - left); }
  }
  return fmtWall(d);
}

// DATETIMEs are read back as text so the driver never shifts them by a zone.
const dt = (col, as) => `DATE_FORMAT(${col},'%Y-%m-%d %H:%i:%s') AS ${as || col.split('.').pop()}`;
const dd = (col, as) => `DATE_FORMAT(${col},'%Y-%m-%d') AS ${as || col.split('.').pop()}`;

const flagList = s => String(s || '').split(',').map(x => x.trim()).filter(x => CONDITIONS[x]);
const cleanFlags = arr => [...new Set((Array.isArray(arr) ? arr : flagList(arr)).filter(x => CONDITIONS[x]))].join(',');

async function ensureSteps() {
  const row = await db.one('SELECT COUNT(*) AS n FROM pms_steps');
  if (row && row.n > 0) return;
  for (let i = 0; i < DEFAULT_STEPS.length; i++) {
    const [name, doer, tat, cond, fill, vendor] = DEFAULT_STEPS[i];
    await db.query(
      `INSERT INTO pms_steps (step_no,name,doer_label,tat_days,condition_key,fill_label,uses_vendor) VALUES (?,?,?,?,?,?,?)`,
      [i + 1, name, doer, tat, cond, fill, vendor]);
  }
}

async function logUpdate(q, orderId, userId, kind, text) {
  await q.query('INSERT INTO pms_order_updates (order_id,user_id,kind,text,created_at) VALUES (?,?,?,?,?)',
    [orderId, userId || null, kind, text, nowIST()]);
}

// Opens the next step that applies, skipping the ones whose condition is off.
// No step left = the order is complete.
async function advance(conn, orderId, fromStr) {
  const [[order]] = await conn.query('SELECT flags FROM pms_orders WHERE id=?', [orderId]);
  const flags = flagList(order && order.flags);
  const [waiting] = await conn.query(
    `SELECT id,name,tat_days,condition_key FROM pms_order_steps WHERE order_id=? AND status='waiting' ORDER BY step_no`, [orderId]);
  for (const s of waiting) {
    if (s.condition_key && !flags.includes(s.condition_key)) {
      await conn.query(`UPDATE pms_order_steps SET status='skipped' WHERE id=?`, [s.id]);
      continue;
    }
    await conn.query(`UPDATE pms_order_steps SET status='open', planned_at=? WHERE id=?`, [planFrom(fromStr, s.tat_days), s.id]);
    return s;
  }
  await conn.query(`UPDATE pms_orders SET status='completed', completed_at=? WHERE id=?`, [fromStr, orderId]);
  return null;
}

async function inTx(fn) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) { await conn.rollback().catch(() => {}); throw e; }
  finally { conn.release(); }
}

// ── Shared order list ─────────────────────────────────
// One query for orders, one for their steps; everything per-order (current
// step, progress, late) is worked out here so every screen agrees.
async function loadOrders(where = '1=1', params = []) {
  const orders = await db.rows(
    `SELECT o.id,o.order_code,o.order_no,o.source,o.uni_order_code,o.client_name,o.client_phone,o.party,o.channel,
            o.sales_person_id, sp.name AS sales_person, o.product,o.sku,o.category,o.yarn,o.color,o.sizes,o.qty,
            o.order_type,o.priority,o.flags,o.status,o.created_by, cb.name AS created_by_name,
            ${dd('o.order_date', 'order_date')}, ${dd('o.delivery_date', 'delivery_date')},
            ${dt('o.created_at', 'created_at')}, ${dt('o.completed_at', 'completed_at')},
            (o.photo IS NOT NULL AND o.photo<>'') AS has_photo
       FROM pms_orders o
       LEFT JOIN users sp ON sp.id=o.sales_person_id
       LEFT JOIN users cb ON cb.id=o.created_by
      WHERE ${where} ORDER BY o.id DESC`, params);
  if (!orders.length) return [];
  const ids = orders.map(o => o.id);
  const steps = await db.rows(
    `SELECT s.id,s.order_id,s.step_no,s.name,s.status,s.doer_id,u.name AS doer_name,s.vendor_id,
            ${dt('s.planned_at', 'planned_at')}, ${dt('s.actual_at', 'actual_at')}
       FROM pms_order_steps s LEFT JOIN users u ON u.id=s.doer_id
      WHERE s.order_id IN (?) ORDER BY s.order_id, s.step_no`, [ids]);
  const byOrder = new Map(ids.map(id => [id, []]));
  steps.forEach(s => byOrder.get(s.order_id).push(s));
  const now = nowIST(), today = now.slice(0, 10);
  return orders.map(o => {
    const st = byOrder.get(o.id) || [];
    const open = st.find(s => s.status === 'open') || null;
    const applicable = st.filter(s => s.status !== 'skipped');
    const done = st.filter(s => s.status === 'done').length;
    const stepLate = !!(open && open.planned_at && open.planned_at < now);
    const deliveryLate = o.status === 'active' && o.delivery_date && o.delivery_date < today;
    return {
      ...o,
      flags: flagList(o.flags),
      has_photo: !!o.has_photo,
      current: open ? { id: open.id, step_no: open.step_no, name: open.name, doer_id: open.doer_id,
        doer_name: open.doer_name, planned_at: open.planned_at } : null,
      steps_done: done,
      steps_total: applicable.length,
      progress: applicable.length ? Math.round((done / applicable.length) * 100) : 0,
      delayed: o.status === 'active' && (stepLate || deliveryLate),
      step_late: o.status === 'active' && stepLate,
    };
  });
}

// ── Meta: workflow, people, vendors ───────────────────
router.get('/pms/meta', requireAuth, asyncRoute(async (req, res) => {
  await ensureSteps();
  const [steps, users, vendors] = await Promise.all([
    db.rows(`SELECT s.*, u.name AS default_user_name FROM pms_steps s LEFT JOIN users u ON u.id=s.default_user_id WHERE s.step_no<1000 ORDER BY s.step_no`),
    db.rows(`SELECT id,name,department,role FROM users ORDER BY name`),
    db.rows(`SELECT id,name,phone,category,active FROM pms_vendors ORDER BY name`),
  ]);
  res.json({
    steps, users, vendors, conditions: CONDITIONS,
    me: { id: req.session.userId, name: req.session.name, role: req.session.role, manager: isManager(req) },
    office: { start: OFFICE_START, end: OFFICE_END },
    today: todayIST(),
  });
}));

// ── Dashboard ─────────────────────────────────────────
router.get('/pms/dashboard', requireAuth, asyncRoute(async (req, res) => {
  await ensureSteps();
  const orders = await loadOrders(`o.status IN ('active','completed')`);
  const active = orders.filter(o => o.status === 'active');
  const month = todayIST().slice(0, 7);
  const me = req.session.userId;
  const steps = await db.rows('SELECT step_no,name FROM pms_steps WHERE active=1 ORDER BY step_no');
  const pipeline = steps.map(s => {
    const at = active.filter(o => o.current && o.current.step_no === s.step_no);
    return { step_no: s.step_no, name: s.name, pending: at.length, late: at.filter(o => o.step_late).length };
  });
  const today = todayIST();
  const in7 = fmtWall(new Date(toWall(today).getTime() + 7 * 864e5)).slice(0, 10);
  res.json({
    counts: {
      active: active.length,
      delayed: active.filter(o => o.delayed).length,
      myPending: active.filter(o => o.current && o.current.doer_id === me).length,
      completedMonth: orders.filter(o => o.status === 'completed' && (o.completed_at || '').startsWith(month)).length,
    },
    pipeline,
    upcoming: active.filter(o => o.delivery_date && o.delivery_date <= in7)
      .sort((a, b) => a.delivery_date.localeCompare(b.delivery_date)).slice(0, 8),
    recent: orders.slice(0, 8),
  });
}));

// ── Orders ────────────────────────────────────────────
router.get('/pms/orders', requireAuth, asyncRoute(async (req, res) => {
  // Cancelled orders vanish for doers; managers still see them under Hold / Cancelled.
  const where = isManager(req) ? '1=1' : `o.status<>'cancelled'`;
  res.json({ orders: await loadOrders(where) });
}));

router.get('/pms/orders/:id', requireAuth, asyncRoute(async (req, res) => {
  const [order] = await loadOrders('o.id=?', [req.params.id]);
  if (!order) throw httpError(404, 'Order not found');
  const [photo, steps, updates] = await Promise.all([
    db.one('SELECT photo,description FROM pms_orders WHERE id=?', [req.params.id]),
    db.rows(`SELECT s.id,s.step_no,s.name,s.status,s.tat_days,s.condition_key,s.fill_label,s.uses_vendor,
                    s.doer_id,u.name AS doer_name,s.vendor_id,v.name AS vendor_name,
                    ${dt('s.planned_at', 'planned_at')},${dt('s.actual_at', 'actual_at')},
                    s.done_by,db.name AS done_by_name,s.fill_value,s.remarks
               FROM pms_order_steps s
               LEFT JOIN users u ON u.id=s.doer_id
               LEFT JOIN users db ON db.id=s.done_by
               LEFT JOIN pms_vendors v ON v.id=s.vendor_id
              WHERE s.order_id=? ORDER BY s.step_no`, [req.params.id]),
    db.rows(`SELECT p.id,p.kind,p.text,${dt('p.created_at', 'created_at')},u.name AS user_name
               FROM pms_order_updates p LEFT JOIN users u ON u.id=p.user_id
              WHERE p.order_id=? ORDER BY p.created_at DESC, p.id DESC`, [req.params.id]),
  ]);
  const now = nowIST();
  steps.forEach(s => { s.late = s.status === 'open' && s.planned_at && s.planned_at < now; });
  res.json({ order: { ...order, photo: photo.photo || null, description: photo.description || '' }, steps, updates,
    canCancel: isManager(req) || (order.created_by === req.session.userId
      && (toWall(now) - toWall(order.created_at)) < 864e5) });
}));

const ORDER_FIELDS = ['order_no', 'client_name', 'client_phone', 'party', 'channel', 'sales_person_id', 'product', 'sku',
  'category', 'yarn', 'color', 'sizes', 'qty', 'order_type', 'priority', 'description', 'order_date', 'delivery_date'];

function readOrderBody(b) {
  const o = {};
  ORDER_FIELDS.forEach(k => { if (b[k] !== undefined) o[k] = b[k] === '' ? null : b[k]; });
  ['client_name', 'product'].forEach(k => { if (o[k] !== undefined) o[k] = String(o[k] || '').trim(); });
  if (o.qty !== undefined) o.qty = Math.max(1, parseInt(o.qty, 10) || 1);
  if (o.sales_person_id !== undefined) o.sales_person_id = o.sales_person_id ? Number(o.sales_person_id) : null;
  ['order_no', 'client_phone', 'party', 'channel', 'sku', 'category', 'yarn', 'color', 'sizes', 'description']
    .forEach(k => { if (o[k] === null) o[k] = ''; });
  if (b.flags !== undefined) o.flags = cleanFlags(b.flags);
  if (b.photo !== undefined) {
    if (b.photo && !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(b.photo)) throw httpError(400, 'Photo must be an image.');
    if (b.photo && b.photo.length > 3 * 1024 * 1024) throw httpError(400, 'Photo is too large — keep it under 2 MB.');
    o.photo = b.photo || null;
  }
  return o;
}

router.post('/pms/orders', requireAuth, asyncRoute(async (req, res) => {
  await ensureSteps();
  const o = readOrderBody(req.body || {});
  if (!o.client_name) throw httpError(400, 'Client name is required.');
  if (!o.product) throw httpError(400, 'Product is required.');
  o.order_date = o.order_date || todayIST();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.order_date)) throw httpError(400, 'Order date is not a date.');
  const uni = req.body.uni_order_code ? String(req.body.uni_order_code) : null;
  if (uni) {
    const dup = await db.one(`SELECT order_code FROM pms_orders WHERE uni_order_code=? AND status<>'cancelled'`, [uni]);
    if (dup) throw httpError(409, `This Unicommerce order is already in PMS as ${dup.order_code}.`);
  }
  const now = nowIST();
  const out = await inTx(async conn => {
    const cols = Object.keys(o);
    const [r] = await conn.query(
      `INSERT INTO pms_orders (${cols.join(',')},source,uni_order_code,status,created_by,created_at)
       VALUES (${cols.map(() => '?').join(',')},?,?,'active',?,?)`,
      [...cols.map(k => o[k]), uni ? 'unicommerce' : 'manual', uni, req.session.userId, now]);
    const id = r.insertId;
    const code = 'ORD-' + String(id).padStart(4, '0');
    await conn.query(`UPDATE pms_orders SET order_code=?, order_no=IF(order_no='' OR order_no IS NULL, ?, order_no) WHERE id=?`, [code, code, id]);
    const [tpl] = await conn.query('SELECT * FROM pms_steps WHERE active=1 ORDER BY step_no');
    if (!tpl.length) throw httpError(400, 'The workflow has no active steps — add one in PMS → Settings.');
    for (const s of tpl) {
      await conn.query(
        `INSERT INTO pms_order_steps (order_id,step_id,step_no,name,tat_days,condition_key,fill_label,uses_vendor,doer_id,status)
         VALUES (?,?,?,?,?,?,?,?,?,'waiting')`,
        [id, s.id, s.step_no, s.name, s.tat_days, s.condition_key, s.fill_label, s.uses_vendor, s.default_user_id]);
    }
    // Step 1 counts from the order date at 10:00 — not from when it was typed in.
    await advance(conn, id, o.order_date + ' 09:00:00');
    await logUpdate(conn, id, req.session.userId, 'created',
      `Order created${uni ? ' from Unicommerce ' + uni : ''} — ${o.product} × ${o.qty || 1}`);
    return { id, order_code: code };
  });
  res.json({ success: true, ...out });
}));

router.put('/pms/orders/:id', requireAuth, requireManager, asyncRoute(async (req, res) => {
  const o = readOrderBody(req.body || {});
  delete o.flags;   // flags belong to the PM Decision, which also re-plans
  const cols = Object.keys(o);
  if (!cols.length) return res.json({ success: true });
  if (o.client_name === '' || o.product === '') throw httpError(400, 'Client name and product cannot be empty.');
  await db.query(`UPDATE pms_orders SET ${cols.map(k => k + '=?').join(',')} WHERE id=?`, [...cols.map(k => o[k]), req.params.id]);
  await logUpdate(db, req.params.id, req.session.userId, 'edit', 'Order details edited');
  res.json({ success: true });
}));

// Hold / resume / cancel. A creator may cancel their own order inside 24 h.
router.post('/pms/orders/:id/status', requireAuth, asyncRoute(async (req, res) => {
  const status = req.body.status;
  if (!['active', 'hold', 'cancelled'].includes(status)) throw httpError(400, 'Unknown status.');
  const o = await db.one(`SELECT status,created_by,${dt('created_at')} FROM pms_orders WHERE id=?`, [req.params.id]);
  if (!o) throw httpError(404, 'Order not found');
  if (o.status === 'completed') throw httpError(400, 'A completed order cannot change status.');
  const ownEarly = status === 'cancelled' && o.created_by === req.session.userId
    && (toWall(nowIST()) - toWall(o.created_at)) < 864e5;
  if (!isManager(req) && !ownEarly) throw httpError(403, 'Only Admin / PC / HOD can do this (or the creator within 24 hours).');
  await db.query('UPDATE pms_orders SET status=? WHERE id=?', [status, req.params.id]);
  const reason = String(req.body.reason || '').trim();
  const label = { active: 'Resumed', hold: 'Put on hold', cancelled: 'Cancelled' }[status];
  await logUpdate(db, req.params.id, req.session.userId, 'status', label + (reason ? ' — ' + reason : ''));
  res.json({ success: true });
}));

router.post('/pms/orders/:id/updates', requireAuth, asyncRoute(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) throw httpError(400, 'Write the update first.');
  const o = await db.one('SELECT id FROM pms_orders WHERE id=?', [req.params.id]);
  if (!o) throw httpError(404, 'Order not found');
  await logUpdate(db, req.params.id, req.session.userId, 'note', text.slice(0, 4000));
  res.json({ success: true });
}));

// ── Steps ─────────────────────────────────────────────
// Mark Done. On the first step (PM Decision) the body also carries the flags
// and the doer/vendor for each later step, and those are saved before the
// next step is opened — so the skip decision uses the PM's answer.
router.post('/pms/order-steps/:id/done', requireAuth, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const out = await inTx(async conn => {
    const [[s]] = await conn.query(
      `SELECT s.*, o.status AS order_status FROM pms_order_steps s JOIN pms_orders o ON o.id=s.order_id WHERE s.id=? FOR UPDATE`, [req.params.id]);
    if (!s) throw httpError(404, 'Step not found');
    if (s.status !== 'open') throw httpError(400, 'This step is not open.');
    if (s.order_status !== 'active') throw httpError(400, 'The order is on hold or closed.');
    if (!isManager(req) && s.doer_id && s.doer_id !== req.session.userId) throw httpError(403, 'This step is assigned to someone else.');
    const [[first]] = await conn.query('SELECT MIN(step_no) AS n FROM pms_order_steps WHERE order_id=?', [s.order_id]);
    if (s.step_no === first.n) {
      if (b.flags !== undefined) await conn.query('UPDATE pms_orders SET flags=? WHERE id=?', [cleanFlags(b.flags), s.order_id]);
      for (const a of Array.isArray(b.assign) ? b.assign : []) {
        await conn.query(`UPDATE pms_order_steps SET doer_id=?, vendor_id=? WHERE id=? AND order_id=? AND status='waiting'`,
          [a.doer_id || null, a.vendor_id || null, a.id, s.order_id]);
      }
    } else if (b.vendor_id !== undefined && s.uses_vendor) {
      await conn.query('UPDATE pms_order_steps SET vendor_id=? WHERE id=?', [b.vendor_id || null, s.id]);
    }
    const now = nowIST();
    const fill = String(b.fill_value || '').trim().slice(0, 300);
    const remarks = String(b.remarks || '').trim();
    await conn.query(`UPDATE pms_order_steps SET status='done', actual_at=?, done_by=?, fill_value=?, remarks=? WHERE id=?`,
      [now, req.session.userId, fill, remarks, s.id]);
    await logUpdate(conn, s.order_id, req.session.userId, 'step',
      `Step ${s.step_no} · ${s.name} done${fill ? ` — ${s.fill_label || 'value'}: ${fill}` : ''}${remarks ? ` — ${remarks}` : ''}`);
    const next = await advance(conn, s.order_id, now);
    return { next: next ? next.name : null };
  });
  res.json({ success: true, ...out });
}));

// Reassign a step (or its vendor) — managers only.
router.put('/pms/order-steps/:id', requireAuth, requireManager, asyncRoute(async (req, res) => {
  const s = await db.one('SELECT id,order_id,step_no,name,status FROM pms_order_steps WHERE id=?', [req.params.id]);
  if (!s) throw httpError(404, 'Step not found');
  if (s.status === 'done' || s.status === 'skipped') throw httpError(400, 'This step is already closed.');
  const sets = [], vals = [];
  if (req.body.doer_id !== undefined) { sets.push('doer_id=?'); vals.push(req.body.doer_id || null); }
  if (req.body.vendor_id !== undefined) { sets.push('vendor_id=?'); vals.push(req.body.vendor_id || null); }
  if (req.body.planned_at && s.status === 'open') {
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(req.body.planned_at)) throw httpError(400, 'Planned date is not a date.');
    sets.push('planned_at=?'); vals.push(req.body.planned_at.length === 10 ? req.body.planned_at + ' 18:00:00' : req.body.planned_at);
  }
  if (!sets.length) return res.json({ success: true });
  await db.query(`UPDATE pms_order_steps SET ${sets.join(',')} WHERE id=?`, [...vals, s.id]);
  await logUpdate(db, s.order_id, req.session.userId, 'assign', `Step ${s.step_no} · ${s.name} reassigned`);
  res.json({ success: true });
}));

// My Tasks: the open steps assigned to me, and (for managers) open steps
// nobody owns yet.
router.get('/pms/my-tasks', requireAuth, asyncRoute(async (req, res) => {
  const base = `SELECT s.id,s.order_id,s.step_no,s.name,s.fill_label,s.uses_vendor,s.vendor_id,s.doer_id,
                       ${dt('s.planned_at', 'planned_at')}, o.order_code,o.order_no,o.client_name,o.product,o.qty,o.color,o.sizes,
                       ${dd('o.delivery_date', 'delivery_date')}, o.priority
                  FROM pms_order_steps s JOIN pms_orders o ON o.id=s.order_id
                 WHERE s.status='open' AND o.status='active'`;
  const mine = await db.rows(`${base} AND s.doer_id=? ORDER BY s.planned_at`, [req.session.userId]);
  const unassigned = isManager(req) ? await db.rows(`${base} AND s.doer_id IS NULL ORDER BY s.planned_at`) : [];
  const vendorOpen = await db.rows(
    `SELECT s.id,s.name,s.step_no,v.name AS vendor_name,v.phone AS vendor_phone,${dt('s.planned_at', 'planned_at')},
            o.order_code,o.client_name,o.product,o.qty
       FROM pms_order_steps s JOIN pms_orders o ON o.id=s.order_id JOIN pms_vendors v ON v.id=s.vendor_id
      WHERE s.status='open' AND o.status='active' ORDER BY s.planned_at`);
  const now = nowIST();
  [mine, unassigned, vendorOpen].forEach(list => list.forEach(t => { t.late = !!(t.planned_at && t.planned_at < now); }));
  res.json({ mine, unassigned, vendorOpen });
}));

// ── Order Update (history across orders) ──────────────
router.get('/pms/updates', requireAuth, asyncRoute(async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayIST();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : todayIST();
  const q = String(req.query.q || '').trim();
  const params = [from + ' 00:00:00', to + ' 23:59:59'];
  let search = '';
  if (q) {
    search = ` AND (o.order_code LIKE ? OR o.order_no LIKE ? OR o.client_name LIKE ? OR o.client_phone LIKE ? OR o.product LIKE ? OR o.uni_order_code LIKE ?)`;
    for (let i = 0; i < 6; i++) params.push(`%${q}%`);
  }
  const hidden = isManager(req) ? '' : ` AND o.status<>'cancelled'`;
  const rows = await db.rows(
    `SELECT o.id,o.order_code,o.order_no,o.client_name,o.product,o.status, COUNT(p.id) AS updates,
            DATE_FORMAT(MAX(p.created_at),'%Y-%m-%d %H:%i:%s') AS last_at
       FROM pms_order_updates p JOIN pms_orders o ON o.id=p.order_id
      WHERE p.created_at BETWEEN ? AND ?${search}${hidden}
      GROUP BY o.id ORDER BY last_at DESC LIMIT 300`, params);
  res.json({ from, to, orders: rows });
}));

// ── Orders to pull in: Shopify and Unicommerce ────────
// Unicommerce masks the customer on every order it hands over - name and
// mobile come back as "********" on Shopify orders and empty on Myntra ones -
// so searching it by name or phone could never find anything. Shopify itself
// gives the real name, phone and email, and every Shopify order is already in
// sfy_orders, so website orders are found there: by name, phone, email or order
// number. Unicommerce is still searched for the marketplace (Myntra) orders,
// which Shopify never sees; those can only be found by their order code.
const skuGroup = require('../services/skuGroup');

async function shopifyOrders(q) {
  const digits = q.replace(/\D/g, '');
  const where = [];
  const args = [];
  if (digits.length >= 10) {
    // A phone, however it was written: +91 98792 54702, 098792-54702 ...
    where.push('s.phone10 = ?');
    args.push(digits.slice(-10));
  } else if (/^\d{3,9}$/.test(q.replace(/^#?bunai/i, ''))) {
    // An order number: 483102, #483102 or Bunai483102.
    where.push('s.order_ref = ?');
    args.push(q.replace(/^#?bunai/i, ''));
  } else {
    where.push('(s.customer_name LIKE ? OR s.customer_email LIKE ? OR s.order_no LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const orders = await db.rows(
    `SELECT s.order_no, s.order_ref, s.customer_name, s.customer_email, s.customer_phone,
            s.ship_city, s.ship_state, s.status, s.cancelled_at,
            DATE_FORMAT(s.order_date, '%Y-%m-%d %H:%i:%s') order_date,
            u.code AS uni_code
       FROM sfy_orders s
       LEFT JOIN uni_orders u ON u.channel = 'SHOPIFY' AND u.display_code = s.order_ref
      WHERE ${where.join(' AND ')}
      ORDER BY s.order_date DESC LIMIT 20`, args);
  if (!orders.length) return [];
  const [items, linked] = await Promise.all([
    db.rows('SELECT order_no, sku, sku_name, order_qty FROM sfy_order_items WHERE order_no IN (?)', [orders.map(o => o.order_no)]),
    db.rows(`SELECT uni_order_code, order_code FROM pms_orders WHERE status <> 'cancelled' AND uni_order_code IN (?)`,
      [orders.flatMap(o => [o.order_no, o.uni_code].filter(Boolean))]),
  ]);
  const pms = Object.fromEntries(linked.map(r => [r.uni_order_code, r.order_code]));
  return orders.map(o => ({
    source: 'shopify',
    // Linked by the Unicommerce code when Unicommerce has the order, so an
    // order pulled either way is recognised as already in PMS.
    code: o.uni_code || o.order_no,
    display_code: o.order_no,
    channel: 'Shopify',
    status: o.cancelled_at ? 'Cancelled' : (o.status || ''),
    customer_name: (o.customer_name || '').trim(),
    notification_mobile: (o.customer_phone || '').trim(),
    email: (o.customer_email || '').trim(),
    ship_city: [o.ship_city, o.ship_state].filter(Boolean).join(', '),
    order_date: o.order_date,
    pms_code: pms[o.uni_code] || pms[o.order_no] || null,
    // One entry per piece, as Unicommerce lists them, so the form's quantity
    // and size counts read the same whichever source the order came from.
    items: items.filter(i => i.order_no === o.order_no).flatMap(i =>
      Array.from({ length: Math.max(1, Number(i.order_qty) || 1) }, () => ({
        sku: i.sku, item_name: i.sku_name, color: '', size: (skuGroup.splitSize(i.sku || '').size || ''),
      }))),
  }));
}

router.get('/pms/uni-orders', requireAuth, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const params = [];
  // Shopify orders come from Shopify; Unicommerce supplies the rest.
  let where = "u.channel <> 'SHOPIFY'";
  if (q) {
    where += ' AND (u.code LIKE ? OR u.display_code LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  const [shop, orders] = await Promise.all([
    q ? shopifyOrders(q) : [],
    db.rows(
      `SELECT u.code,u.display_code,u.channel,u.status,u.customer_name,u.notification_mobile,u.ship_city,u.item_count,
              ${dd('u.order_date', 'order_date')}, p.order_code AS pms_code
         FROM uni_orders u
         LEFT JOIN pms_orders p ON p.uni_order_code=u.code AND p.status<>'cancelled'
        WHERE ${where} ORDER BY u.order_date DESC LIMIT ${q ? 25 : 15}`, params),
  ]);
  if (orders.length) {
    const items = await db.rows(
      `SELECT order_code,sku,item_name,color,size FROM uni_order_items WHERE order_code IN (?)`, [orders.map(o => o.code)]);
    orders.forEach(o => {
      o.source = 'unicommerce';
      o.items = items.filter(i => i.order_code === o.code);
      // Myntra never shares the buyer; say so rather than show asterisks.
      if (/^\*+$/.test(o.customer_name || '')) o.customer_name = '';
      if (/^\*+$/.test(o.notification_mobile || '')) o.notification_mobile = '';
    });
  }
  res.json({ orders: [...shop, ...orders] });
}));

// ── Vendors ───────────────────────────────────────────
router.get('/pms/vendors', requireAuth, asyncRoute(async (req, res) => {
  res.json(await db.rows(
    `SELECT v.*,
            (SELECT COUNT(DISTINCT s.order_id) FROM pms_order_steps s JOIN pms_orders o ON o.id=s.order_id
              WHERE s.vendor_id=v.id AND o.status='active') AS open_orders,
            (SELECT COUNT(DISTINCT s.order_id) FROM pms_order_steps s WHERE s.vendor_id=v.id) AS total_orders
       FROM pms_vendors v ORDER BY v.active DESC, v.name`));
}));

function readVendor(b) {
  const v = {
    name: String(b.name || '').trim(), phone: String(b.phone || '').trim(), category: String(b.category || '').trim(),
    address: String(b.address || '').trim(), notes: String(b.notes || '').trim(),
  };
  if (b.active !== undefined) v.active = b.active ? 1 : 0;
  if (!v.name) throw httpError(400, 'Vendor name is required.');
  return v;
}

router.post('/pms/vendors', requireAuth, requireManager, asyncRoute(async (req, res) => {
  const v = readVendor(req.body || {});
  const cols = Object.keys(v);
  const [r] = await db.query(`INSERT INTO pms_vendors (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(k => v[k]));
  res.json({ success: true, id: r.insertId });
}));

router.put('/pms/vendors/:id', requireAuth, requireManager, asyncRoute(async (req, res) => {
  const v = readVendor(req.body || {});
  const cols = Object.keys(v);
  await db.query(`UPDATE pms_vendors SET ${cols.map(k => k + '=?').join(',')} WHERE id=?`, [...cols.map(k => v[k]), req.params.id]);
  res.json({ success: true });
}));

// ── Workflow settings ─────────────────────────────────
// Saves the whole step list at once. Orders already created keep their own
// copy; only new orders pick the change up.
router.put('/pms/workflow', requireAuth, requireManager, asyncRoute(async (req, res) => {
  const list = Array.isArray(req.body.steps) ? req.body.steps : [];
  if (!list.length) throw httpError(400, 'The workflow needs at least one step.');
  await inTx(async conn => {
    const keep = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const name = String(s.name || '').trim();
      if (!name) throw httpError(400, `Step ${i + 1} has no name.`);
      const vals = [i + 1, name, String(s.doer_label || '').trim(), s.default_user_id || null,
        Math.max(0, Number(s.tat_days) || 0), CONDITIONS[s.condition_key] ? s.condition_key : null,
        String(s.fill_label || '').trim(), s.uses_vendor ? 1 : 0, s.active === false || s.active === 0 ? 0 : 1];
      if (s.id) {
        await conn.query(`UPDATE pms_steps SET step_no=?,name=?,doer_label=?,default_user_id=?,tat_days=?,condition_key=?,fill_label=?,uses_vendor=?,active=? WHERE id=?`, [...vals, s.id]);
        keep.push(Number(s.id));
      } else {
        const [r] = await conn.query(`INSERT INTO pms_steps (step_no,name,doer_label,default_user_id,tat_days,condition_key,fill_label,uses_vendor,active) VALUES (?,?,?,?,?,?,?,?,?)`, vals);
        keep.push(r.insertId);
      }
    }
    // Removed steps are deactivated, not deleted — old orders still point at them.
    await conn.query(`UPDATE pms_steps SET active=0, step_no=step_no+1000 WHERE id NOT IN (?) AND step_no<1000`, [keep]);
  });
  res.json({ success: true });
}));

module.exports = router;
module.exports.planFrom = planFrom;
