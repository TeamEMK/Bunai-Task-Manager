// ══════════════════════════════════════════════════════
// MULMUL PRODUCT COST (/api/mulmul-costs)
//
// What one Mulmul product costs to make, part by part: main fabric, dye,
// lining, dupatta, laces, handwork, stitching and the rest. The fields are the
// client's own cost sheet: per line a component, the material, a quantity and
// its unit, a rate, the vendor and a note; the amount is quantity x rate and
// the product's cost is the sum of its lines.
//
// The amount is worked out here, not taken from the form, so the total can
// never disagree with the lines it is made of.
//
// A product is saved whole: its lines are replaced on every save, the way the
// sheet is edited, rather than merged one by one.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requirePage } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();
const page = requirePage('mulmulcost');

// The sheet's dropdown, plus the three its own sample rows used that the
// dropdown lacked (Dye, Dupatta Dye, Pikow).
const COMPONENTS = ['Main Fabric', 'Dye', 'Second Fabric', 'Lining', 'Dupatta Fabric', 'Dupatta Dye',
  'Dupatta Making', 'Laces', 'Pikow', 'Handwork', 'Machine Embroidery', 'Stitching', 'Accessories',
  'Packaging', 'Finishing', 'Other'];
const UOMS = ['piece', 'meters', 'kg', 'grams', 'roll', 'job', 'other'];

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
// Blank stays blank: an unpriced line is "not decided", not "free".
// Commas, spaces and a rupee sign are allowed ("1,200", "₹ 92"); anything
// else that is not a number is refused rather than quietly read as blank.
const num = (v) => {
  const t = String(v == null ? '' : v).trim();
  if (t === '') return null;
  const n = Number(t.replace(/[,\s₹]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

function fromBody(b) {
  const sku = clip(b.sku, 120);
  if (!sku) throw httpError(400, 'SKU is required.');
  const lines = [];
  (Array.isArray(b.lines) ? b.lines : []).forEach((l, i) => {
    const material = clip(l.material, 255), vendor = clip(l.vendor, 255), notes = clip(l.notes, 1000);
    const qty = num(l.qty), rate = num(l.rate);
    // A row left as the template laid it out - a component and nothing else -
    // is not a cost line.
    if (!material && !vendor && !notes && qty === null && rate === null) return;
    if (Number.isNaN(qty)) throw httpError(400, 'Line ' + (i + 1) + ': the quantity is not a number.');
    if (Number.isNaN(rate)) throw httpError(400, 'Line ' + (i + 1) + ': the rate is not a number.');
    const component = COMPONENTS.includes(l.component) ? l.component : 'Other';
    const uom = UOMS.includes(l.uom) ? l.uom : '';
    const amount = qty !== null && rate !== null ? Math.round(qty * rate * 100) / 100 : null;
    lines.push({ component, material, qty, uom, rate, amount, vendor, notes });
  });
  if (!lines.length) throw httpError(400, 'Fill in at least one cost line.');
  // Every component has one line of its own; only "Other" may repeat.
  const seen = new Set();
  for (const l of lines) {
    if (l.component === 'Other') continue;
    if (seen.has(l.component)) throw httpError(400, l.component + ' is on two lines. Put both on one line, or use Other for the second.');
    seen.add(l.component);
  }
  return { sku, category: clip(b.category, 120), lines };
}

async function writeLines(costId, lines) {
  await db.query('DELETE FROM mulmul_cost_lines WHERE cost_id = ?', [costId]);
  await db.query(
    `INSERT INTO mulmul_cost_lines (cost_id, position, component, material, qty, uom, rate, amount, vendor, notes)
     VALUES ?`,
    [lines.map((l, i) => [costId, i + 1, l.component, l.material, l.qty, l.uom, l.rate, l.amount, l.vendor, l.notes])]);
}

const IST = (col) => `DATE_FORMAT(${col} + INTERVAL 330 MINUTE, '%e %b %Y, %l:%i %p')`;

router.get('/mulmul-costs', requireAuth, page, asyncRoute(async (req, res) => {
  const q = clip(req.query.q, 120);
  const like = '%' + q + '%';
  const rows = await db.rows(
    `SELECT c.id, c.sku, c.category, ${IST('c.updated_at')} AS updated, c.updated_by_name,
            COUNT(l.id) AS line_count, ROUND(SUM(l.amount), 2) AS total,   -- not "lines": a reserved word in MySQL
            SUM(l.amount IS NULL) AS unpriced
       FROM mulmul_costs c
       LEFT JOIN mulmul_cost_lines l ON l.cost_id = c.id
      ${q ? `WHERE c.sku LIKE ? OR c.category LIKE ?
                OR EXISTS (SELECT 1 FROM mulmul_cost_lines x WHERE x.cost_id = c.id
                            AND (x.material LIKE ? OR x.vendor LIKE ? OR x.component LIKE ?))` : ''}
      GROUP BY c.id
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT 1000`, q ? [like, like, like, like, like] : []);
  res.json({
    components: COMPONENTS, uoms: UOMS,
    rows: rows.map(({ line_count, ...r }) => ({ ...r, lines: Number(line_count), total: r.total == null ? null : Number(r.total), unpriced: Number(r.unpriced) || 0 })),
  });
}));

router.get('/mulmul-costs/:id', requireAuth, page, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = await db.one(`SELECT id, sku, category, ${IST('updated_at')} AS updated, updated_by_name FROM mulmul_costs WHERE id = ?`, [id]);
  if (!c) throw httpError(404, 'That product is no longer on the list.');
  const lines = await db.rows(
    `SELECT component, material, qty, uom, rate, amount, vendor, notes
       FROM mulmul_cost_lines WHERE cost_id = ? ORDER BY position, id`, [id]);
  res.json({ ...c, lines: lines.map(l => ({ ...l, qty: l.qty == null ? null : Number(l.qty), rate: l.rate == null ? null : Number(l.rate), amount: l.amount == null ? null : Number(l.amount) })) });
}));

async function whoAmI(req) {
  const me = await db.one('SELECT name FROM users WHERE id = ?', [req.session.userId]);
  return (me && me.name) || req.session.name || '';
}

router.post('/mulmul-costs', requireAuth, page, asyncRoute(async (req, res) => {
  const p = fromBody(req.body || {});
  const dup = await db.one('SELECT id FROM mulmul_costs WHERE LOWER(sku) = LOWER(?)', [p.sku]);
  if (dup) throw httpError(409, 'SKU ' + p.sku + ' is already on the list. Edit that one instead.');
  const name = await whoAmI(req);
  const [ins] = await db.query(
    `INSERT INTO mulmul_costs (sku, category, created_by, updated_by_name, created_at, updated_at)
     VALUES (?,?,?,?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [p.sku, p.category, req.session.userId, name]);
  await writeLines(ins.insertId, p.lines);
  res.json({ id: ins.insertId });
}));

router.put('/mulmul-costs/:id', requireAuth, page, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!(await db.one('SELECT id FROM mulmul_costs WHERE id = ?', [id]))) throw httpError(404, 'That product is no longer on the list.');
  const p = fromBody(req.body || {});
  const dup = await db.one('SELECT id FROM mulmul_costs WHERE LOWER(sku) = LOWER(?) AND id <> ?', [p.sku, id]);
  if (dup) throw httpError(409, 'SKU ' + p.sku + ' is already on the list.');
  await db.query(
    'UPDATE mulmul_costs SET sku=?, category=?, updated_by_name=?, updated_at=UTC_TIMESTAMP() WHERE id=?',
    [p.sku, p.category, await whoAmI(req), id]);
  await writeLines(id, p.lines);
  res.json({ success: true });
}));

router.delete('/mulmul-costs/:id', requireAuth, page, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.query('DELETE FROM mulmul_cost_lines WHERE cost_id = ?', [id]);
  await db.query('DELETE FROM mulmul_costs WHERE id = ?', [id]);
  res.json({ success: true });
}));

module.exports = router;
