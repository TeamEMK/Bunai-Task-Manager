// ══════════════════════════════════════════════════════
// PRODUCTION CHECKLIST (/api/prodcheck)
//
// One row per style being made, one tick per production step: fabric received,
// cutting, stitching and on to ready to dispatch. A tick records who did it and
// when; untick takes it back. A style's progress is how many of the current
// steps are ticked, and the step it is waiting at is the first one that is not.
//
// The steps are the team's to change: an Admin can rename, reorder, add or
// switch off a step. A switched-off step keeps its ticks (so switching it back
// on loses nothing) but stops counting.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin, requirePage } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();
const PAGE = requirePage('prodcheck');

// What the checklist starts with, the first time it is opened.
const DEFAULT_STEPS = ['Fabric received', 'Cutting', 'Stitching', 'Handwork', 'QC', 'Ironing', 'Packing', 'Ready to dispatch'];

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const ymdOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);
const intOrNull = (v) => { const n = parseInt(String(v == null ? '' : v).replace(/[, ]/g, ''), 10); return Number.isFinite(n) && n >= 0 ? n : null; };

async function steps() {
  let rows = await db.rows('SELECT id, label, position, active FROM prodcheck_steps ORDER BY position, id');
  if (!rows.length) {
    await db.query('INSERT INTO prodcheck_steps (label, position, active) VALUES ?',
      [DEFAULT_STEPS.map((l, i) => [l, i + 1, 1])]);
    rows = await db.rows('SELECT id, label, position, active FROM prodcheck_steps ORDER BY position, id');
  }
  return rows.map(s => ({ ...s, active: !!Number(s.active) }));
}

async function whoAmI(req) {
  const me = await db.one('SELECT name FROM users WHERE id = ?', [req.session.userId]);
  return (me && me.name) || req.session.name || '';
}

const IST = (col) => `DATE_FORMAT(${col} + INTERVAL 330 MINUTE, '%e %b %Y, %l:%i %p')`;

router.get('/prodcheck', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const all = await steps();
  const items = await db.rows(
    `SELECT id, style_id, product, qty, notes, DATE_FORMAT(due_date, '%Y-%m-%d') due_date,
            created_by_name, ${IST('created_at')} created_at, ${IST('updated_at')} updated_at
       FROM prodcheck_items ORDER BY due_date IS NULL, due_date, id DESC LIMIT 2000`);
  const ticks = items.length
    ? await db.rows(`SELECT item_id, step_id, done_by_name, ${IST('done_at')} done_at
                       FROM prodcheck_ticks WHERE item_id IN (?)`, [items.map(i => i.id)])
    : [];
  const byItem = {};
  ticks.forEach(t => { (byItem[t.item_id] = byItem[t.item_id] || {})[t.step_id] = { by: t.done_by_name, at: t.done_at }; });
  // Style IDs already in Sampling, offered when a style is added.
  const styles = await db.rows('SELECT style_id FROM sample_styles ORDER BY updated_at DESC LIMIT 1000').catch(() => []);
  res.json({
    steps: all,
    items: items.map(i => ({ ...i, ticks: byItem[i.id] || {} })),
    styleIds: styles.map(s => s.style_id),
    canEditSteps: req.session.role === 'admin',
  });
}));

function itemFromBody(b) {
  const style_id = clip(b.style_id, 120);
  if (!style_id) throw httpError(400, 'Style ID is required.');
  return { style_id, product: clip(b.product, 255), qty: intOrNull(b.qty), notes: clip(b.notes, 2000), due_date: ymdOrNull(b.due_date) };
}

router.post('/prodcheck/items', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const v = itemFromBody(req.body || {});
  const [r] = await db.query(
    `INSERT INTO prodcheck_items (style_id, product, qty, notes, due_date, created_by, created_by_name, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [v.style_id, v.product, v.qty, v.notes, v.due_date, req.session.userId, await whoAmI(req)]);
  res.json({ id: r.insertId });
}));

router.put('/prodcheck/items/:id', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const v = itemFromBody(req.body || {});
  const [r] = await db.query(
    'UPDATE prodcheck_items SET style_id=?, product=?, qty=?, notes=?, due_date=?, updated_at=UTC_TIMESTAMP() WHERE id=?',
    [v.style_id, v.product, v.qty, v.notes, v.due_date, parseInt(req.params.id, 10)]);
  if (!r.affectedRows) throw httpError(404, 'That style is no longer on the checklist.');
  res.json({ success: true });
}));

router.delete('/prodcheck/items/:id', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.query('DELETE FROM prodcheck_ticks WHERE item_id = ?', [id]);
  await db.query('DELETE FROM prodcheck_items WHERE id = ?', [id]);
  res.json({ success: true });
}));

// Tick or untick one step of one style.
router.post('/prodcheck/items/:id/tick', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stepId = parseInt((req.body || {}).step_id, 10);
  if (!(await db.one('SELECT id FROM prodcheck_items WHERE id = ?', [id]))) throw httpError(404, 'That style is no longer on the checklist.');
  if (!(await db.one('SELECT id FROM prodcheck_steps WHERE id = ?', [stepId]))) throw httpError(400, 'That step does not exist.');
  if ((req.body || {}).done) {
    await db.query(
      `INSERT INTO prodcheck_ticks (item_id, step_id, done_by, done_by_name, done_at) VALUES (?,?,?,?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE done_by = VALUES(done_by), done_by_name = VALUES(done_by_name), done_at = VALUES(done_at)`,
      [id, stepId, req.session.userId, await whoAmI(req)]);
  } else {
    await db.query('DELETE FROM prodcheck_ticks WHERE item_id = ? AND step_id = ?', [id, stepId]);
  }
  await db.query('UPDATE prodcheck_items SET updated_at = UTC_TIMESTAMP() WHERE id = ?', [id]);
  res.json({ success: true });
}));

// ── steps (Admin) ─────────────────────────────────────
router.post('/prodcheck/steps', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const label = clip((req.body || {}).label, 80);
  if (!label) throw httpError(400, 'Name the step.');
  const last = await db.one('SELECT COALESCE(MAX(position), 0) p FROM prodcheck_steps');
  const [r] = await db.query('INSERT INTO prodcheck_steps (label, position, active) VALUES (?,?,1)', [label, Number(last.p) + 1]);
  res.json({ id: r.insertId });
}));

// The whole list at once: names, order and on/off, as the Steps dialog edits it.
router.put('/prodcheck/steps', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const list = Array.isArray((req.body || {}).steps) ? req.body.steps : [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const label = clip(s.label, 80);
    if (!label) throw httpError(400, 'Every step needs a name.');
    await db.query('UPDATE prodcheck_steps SET label = ?, position = ?, active = ? WHERE id = ?',
      [label, i + 1, s.active ? 1 : 0, parseInt(s.id, 10)]);
  }
  res.json({ success: true });
}));

module.exports = router;
