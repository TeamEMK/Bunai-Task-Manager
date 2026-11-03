// ══════════════════════════════════════════════════════
// PRODUCT COST (/api/mulmul-costs) - Mulmul and Bunai
//
// What one product costs to make, part by part: main fabric, dye, lining,
// dupatta, laces, handwork, stitching and the rest. The fields are the client's
// own cost sheet: per line a component, the material, a quantity and its unit,
// a rate, the vendor and a note; the amount is quantity x rate.
//
// Three costings per product:
//   • tentative - the sum of the lines, worked out here, never typed, so it can
//     never disagree with the lines it is made of;
//   • vendor - what the vendor quoted, typed;
//   • final - the cost decided on, typed (often neither of the other two).
//
// One list per brand: Mulmul (the original) and Bunai. Each is its own page
// that can be handed to a person on its own, so the brand decides which page
// grant a request needs.
//
// A product is saved whole: its lines are replaced on every save, the way the
// sheet is edited, rather than merged one by one.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requirePage } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();

const BRAND_PAGE = { mulmul: 'mulmulcost', bunai: 'bunaicost' };
const BRAND_NAME = { mulmul: 'Mulmul', bunai: 'Bunai' };
const brandOf = (v) => (v === 'bunai' ? 'bunai' : 'mulmul');
// The page grant for the brand this request is about: named in the query or
// the body, or - for one product - the brand that product was saved under.
const brandPage = (pick) => (req, res, next) => {
  Promise.resolve(pick(req)).then((b) => {
    req.costBrand = b;
    requirePage(BRAND_PAGE[b])(req, res, next);
  }).catch(next);
};
const byQuery = brandPage((req) => brandOf(req.query.brand));
const byBody = brandPage((req) => brandOf((req.body || {}).brand));
const byRow = brandPage(async (req) => {
  const r = await db.one('SELECT brand FROM mulmul_costs WHERE id = ?', [parseInt(req.params.id, 10)]);
  return brandOf(r && r.brand);
});

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
  const vendorCost = num(b.vendor_cost), finalCost = num(b.final_cost);
  if (Number.isNaN(vendorCost)) throw httpError(400, 'The vendor costing is not a number.');
  if (Number.isNaN(finalCost)) throw httpError(400, 'The final costing is not a number.');
  const lines = [];
  (Array.isArray(b.lines) ? b.lines : []).forEach((l, i) => {
    const material = clip(l.material, 255), vendor = clip(l.vendor, 255), notes = clip(l.notes, 1000);
    const qty = num(l.qty), rate = num(l.rate);
    // A row left as the template laid it out - a component and nothing else -
    // is not a cost line.
    if (!material && !vendor && !notes && qty === null && rate === null) return;
    if (Number.isNaN(qty)) throw httpError(400, 'Line ' + (i + 1) + ': the quantity is not a number.');
    if (Number.isNaN(rate)) throw httpError(400, 'Line ' + (i + 1) + ': the rate is not a number.');
    // A fixed component by its name; anything else is an Other line, saved under
    // the name typed for it ("Buttons"), or as plain "Other" when none was.
    const typed = clip(l.component, 60);
    const fixed = COMPONENTS.find(c => c.toLowerCase() === typed.toLowerCase());
    const component = fixed || typed || 'Other';
    const uom = UOMS.includes(l.uom) ? l.uom : '';
    const amount = qty !== null && rate !== null ? Math.round(qty * rate * 100) / 100 : null;
    lines.push({ component, material, qty, uom, rate, amount, vendor, notes });
  });
  if (!lines.length) throw httpError(400, 'Fill in at least one cost line.');
  // Each component on one line only - a fixed one, or a name typed on an Other
  // line. Plain unnamed "Other" may repeat.
  const seen = new Set();
  for (const l of lines) {
    if (l.component === 'Other') continue;
    const key = l.component.toLowerCase();
    if (seen.has(key)) throw httpError(400, l.component + ' is on two lines. Put both on one line, or give the second a different name.');
    seen.add(key);
  }
  return { sku, category: clip(b.category, 120), vendor_cost: vendorCost, final_cost: finalCost, lines };
}

async function writeLines(costId, lines) {
  await db.query('DELETE FROM mulmul_cost_lines WHERE cost_id = ?', [costId]);
  await db.query(
    `INSERT INTO mulmul_cost_lines (cost_id, position, component, material, qty, uom, rate, amount, vendor, notes)
     VALUES ?`,
    [lines.map((l, i) => [costId, i + 1, l.component, l.material, l.qty, l.uom, l.rate, l.amount, l.vendor, l.notes])]);
}

// SKUs are unique across both lists, so a clash names the list it is on.
async function skuTaken(sku, exceptId) {
  const r = await db.one('SELECT id, brand FROM mulmul_costs WHERE LOWER(sku) = LOWER(?) AND id <> ?', [sku, exceptId || 0]);
  return r ? 'SKU ' + sku + ' is already on the ' + BRAND_NAME[brandOf(r.brand)] + ' Product Cost list. Edit that one instead.' : null;
}

const IST = (col) => `DATE_FORMAT(${col} + INTERVAL 330 MINUTE, '%e %b %Y, %l:%i %p')`;
const money = (v) => (v == null ? null : Number(v));

router.get('/mulmul-costs', requireAuth, byQuery, asyncRoute(async (req, res) => {
  const q = clip(req.query.q, 120);
  const like = '%' + q + '%';
  const rows = await db.rows(
    `SELECT c.id, c.sku, c.category, c.vendor_cost, c.final_cost, ${IST('c.updated_at')} AS updated, c.updated_by_name,
            COUNT(l.id) AS line_count, ROUND(SUM(l.amount), 2) AS total,   -- not "lines": a reserved word in MySQL
            SUM(l.amount IS NULL) AS unpriced
       FROM mulmul_costs c
       LEFT JOIN mulmul_cost_lines l ON l.cost_id = c.id
      WHERE c.brand = ?
      ${q ? `AND (c.sku LIKE ? OR c.category LIKE ?
                OR EXISTS (SELECT 1 FROM mulmul_cost_lines x WHERE x.cost_id = c.id
                            AND (x.material LIKE ? OR x.vendor LIKE ? OR x.component LIKE ?)))` : ''}
      GROUP BY c.id
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT 1000`, q ? [req.costBrand, like, like, like, like, like] : [req.costBrand]);
  res.json({
    brand: req.costBrand, components: COMPONENTS, uoms: UOMS,
    rows: rows.map(({ line_count, ...r }) => ({ ...r, lines: Number(line_count), total: money(r.total),
      vendor_cost: money(r.vendor_cost), final_cost: money(r.final_cost), unpriced: Number(r.unpriced) || 0 })),
  });
}));

router.get('/mulmul-costs/:id', requireAuth, byRow, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = await db.one(`SELECT id, sku, category, brand, vendor_cost, final_cost, ${IST('updated_at')} AS updated, updated_by_name
                            FROM mulmul_costs WHERE id = ?`, [id]);
  if (!c) throw httpError(404, 'That product is no longer on the list.');
  const lines = await db.rows(
    `SELECT component, material, qty, uom, rate, amount, vendor, notes
       FROM mulmul_cost_lines WHERE cost_id = ? ORDER BY position, id`, [id]);
  res.json({ ...c, vendor_cost: money(c.vendor_cost), final_cost: money(c.final_cost),
    lines: lines.map(l => ({ ...l, qty: money(l.qty), rate: money(l.rate), amount: money(l.amount) })) });
}));

async function whoAmI(req) {
  const me = await db.one('SELECT name FROM users WHERE id = ?', [req.session.userId]);
  return (me && me.name) || req.session.name || '';
}

router.post('/mulmul-costs', requireAuth, byBody, asyncRoute(async (req, res) => {
  const p = fromBody(req.body || {});
  const taken = await skuTaken(p.sku);
  if (taken) throw httpError(409, taken);
  const name = await whoAmI(req);
  const [ins] = await db.query(
    `INSERT INTO mulmul_costs (brand, sku, category, vendor_cost, final_cost, created_by, updated_by_name, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [req.costBrand, p.sku, p.category, p.vendor_cost, p.final_cost, req.session.userId, name]);
  await writeLines(ins.insertId, p.lines);
  res.json({ id: ins.insertId });
}));

router.put('/mulmul-costs/:id', requireAuth, byRow, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!(await db.one('SELECT id FROM mulmul_costs WHERE id = ?', [id]))) throw httpError(404, 'That product is no longer on the list.');
  const p = fromBody(req.body || {});
  const taken = await skuTaken(p.sku, id);
  if (taken) throw httpError(409, taken);
  await db.query(
    'UPDATE mulmul_costs SET sku=?, category=?, vendor_cost=?, final_cost=?, updated_by_name=?, updated_at=UTC_TIMESTAMP() WHERE id=?',
    [p.sku, p.category, p.vendor_cost, p.final_cost, await whoAmI(req), id]);
  await writeLines(id, p.lines);
  res.json({ success: true });
}));

router.delete('/mulmul-costs/:id', requireAuth, byRow, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.query('DELETE FROM mulmul_cost_lines WHERE cost_id = ?', [id]);
  await db.query('DELETE FROM mulmul_costs WHERE id = ?', [id]);
  res.json({ success: true });
}));

module.exports = router;
