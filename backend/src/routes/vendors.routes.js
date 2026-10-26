// ══════════════════════════════════════════════════════
// VENDOR NAME (/api/vendors) — the vendor book.
//
// Who the vendor is, their company and address, their phone, and the styles
// they make for us (as many as the vendor has, one per line). Each vendor keeps
// a call log the way SCOT does for customers: one row per call, never edited
// into the one before, with an optional next-call date.
//
// Not the PMS vendor list (pms_vendors): that one is job-work vendors picked on
// production steps; this one is the contact book the team rings.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin, requirePage } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();
const PAGE = requirePage('vendors');

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const TODAY_IST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function fromBody(b) {
  const styles = (Array.isArray(b.styles) ? b.styles : []).slice(0, 200).map((s) => clip(s, 160));
  return {
    vendor_name: clip(b.vendor_name, 160),
    company: clip(b.company, 200),
    address: clip(b.address, 600),
    phone: clip(b.phone, 40),
    styles: JSON.stringify(styles),
  };
}

const shape = (r) => {
  let styles = [];
  try { styles = JSON.parse(r.styles || '[]'); } catch (_) { /* a bad cell is no styles */ }
  return { ...r, styles: Array.isArray(styles) ? styles : [], calls: Number(r.calls || 0) };
};

router.get('/vendors', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const rows = await db.rows(
    `SELECT v.id, v.vendor_name, v.company, v.address, v.phone, v.styles,
            DATE_FORMAT(v.updated_at + INTERVAL 330 MINUTE, '%e %b %Y') AS updated_at_ist,
            (SELECT COUNT(*) FROM vendor_calls c WHERE c.vendor_id = v.id) AS calls,
            (SELECT DATE_FORMAT(MAX(c.call_date), '%Y-%m-%d') FROM vendor_calls c WHERE c.vendor_id = v.id) AS last_call,
            (SELECT DATE_FORMAT(c.next_call_date, '%Y-%m-%d') FROM vendor_calls c WHERE c.vendor_id = v.id
              ORDER BY c.call_date DESC, c.id DESC LIMIT 1) AS next_call
       FROM vendor_book v ORDER BY v.vendor_name`);
  res.json(rows.map(shape));
}));

router.post('/vendors', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const d = fromBody(req.body || {});
  if (!d.vendor_name) throw httpError(400, 'The vendor name is required');
  const [ins] = await db.query(
    `INSERT INTO vendor_book (vendor_name, company, address, phone, styles, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [d.vendor_name, d.company, d.address, d.phone, d.styles, req.session.userId]);
  res.json({ id: ins.insertId });
}));

router.put('/vendors/:id', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const d = fromBody(req.body || {});
  if (!d.vendor_name) throw httpError(400, 'The vendor name is required');
  const [r] = await db.query(
    `UPDATE vendor_book SET vendor_name=?, company=?, address=?, phone=?, styles=?, updated_at=UTC_TIMESTAMP() WHERE id=?`,
    [d.vendor_name, d.company, d.address, d.phone, d.styles, id]);
  if (!r.affectedRows) throw httpError(404, 'That vendor no longer exists.');
  res.json({ success: true });
}));

router.delete('/vendors/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.query('DELETE FROM vendor_calls WHERE vendor_id=?', [id]);
  await db.query('DELETE FROM vendor_book WHERE id=?', [id]);
  res.json({ success: true });
}));

// ── calls ─────────────────────────────────────────────
router.get('/vendors/:id/calls', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const rows = await db.rows(
    `SELECT id, notes, created_by_name AS by_name,
            DATE_FORMAT(call_date, '%Y-%m-%d') AS call_date,
            DATE_FORMAT(next_call_date, '%Y-%m-%d') AS next_call_date,
            DATE_FORMAT(created_at + INTERVAL 330 MINUTE, '%e %b %Y, %l:%i %p') AS created_at_ist
       FROM vendor_calls WHERE vendor_id=? ORDER BY call_date DESC, id DESC`, [parseInt(req.params.id, 10)]);
  res.json(rows);
}));

function callFromBody(b) {
  const date = b.call_date ? String(b.call_date) : TODAY_IST();
  if (!isYmd(date)) throw httpError(400, 'That date is not valid.');
  const next = b.next_call_date ? String(b.next_call_date) : null;
  if (next && !isYmd(next)) throw httpError(400, 'The next call date is not valid.');
  const notes = clip(b.notes, 4000);
  if (!notes) throw httpError(400, 'Write what was said on the call.');
  return { date, next, notes };
}

router.post('/vendors/:id/calls', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!await db.one('SELECT id FROM vendor_book WHERE id=?', [id])) throw httpError(404, 'That vendor no longer exists.');
  const c = callFromBody(req.body || {});
  const me = await db.one('SELECT name FROM users WHERE id=?', [req.session.userId]);
  const [ins] = await db.query(
    `INSERT INTO vendor_calls (vendor_id, call_date, notes, next_call_date, created_by, created_by_name, created_at)
     VALUES (?,?,?,?,?,?, UTC_TIMESTAMP())`,
    [id, c.date, c.notes, c.next, req.session.userId, (me && me.name) || '']);
  res.json({ id: ins.insertId });
}));

router.put('/vendors/calls/:callId', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const c = callFromBody(req.body || {});
  await db.query('UPDATE vendor_calls SET call_date=?, notes=?, next_call_date=? WHERE id=?',
    [c.date, c.notes, c.next, parseInt(req.params.callId, 10)]);
  res.json({ success: true });
}));

router.delete('/vendors/calls/:callId', requireAuth, PAGE, asyncRoute(async (req, res) => {
  await db.query('DELETE FROM vendor_calls WHERE id=?', [parseInt(req.params.callId, 10)]);
  res.json({ success: true });
}));

module.exports = router;
