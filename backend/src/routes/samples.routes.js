// ══════════════════════════════════════════════════════
// SAMPLE STYLE MIS (/api/samples)
//
// Where a style lives before it is a product: sampled, costed against a
// vendor's quote, priced for the website and for Myntra, and then either put
// into production or left outstanding.
//
// The columns are the client's, from the workbook they sent — Kurta, Pant and
// Dupatta fabrics kept apart, lining asked as a yes/no with its own fabric,
// three costings and two prices. Nothing is derived: final_costing is a
// decision, often neither of the two quotes, so it is typed rather than
// calculated.
//
// Money fields are null when blank, never zero. A style half way through
// costing has most of them empty for weeks, and a zero would read as "free"
// where the truth is "not decided yet".
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();

const STATUSES = ['Production', 'Outstanding'];

const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
// Blank stays blank. Number('') is 0, which is how an empty costing column
// turns into a style that costs nothing.
const money = (v) => {
  const s = String(v == null ? '' : v).replace(/[^0-9.-]/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function body(req) {
  const b = req.body || {};
  const status = STATUSES.includes(txt(b.status, 20)) ? txt(b.status, 20) : 'Outstanding';
  const lining = ['Yes', 'No'].includes(txt(b.has_lining, 3)) ? txt(b.has_lining, 3) : '';
  return {
    style_id: txt(b.style_id, 120),
    image_url: txt(b.image_url, 1000),
    notes: txt(b.notes, 4000),
    kurta_fabric: txt(b.kurta_fabric, 255),
    pant_fabric: txt(b.pant_fabric, 255),
    dupatta_fabric: txt(b.dupatta_fabric, 255),
    fabric_remarks: txt(b.fabric_remarks, 1000),
    has_lining: lining,
    // A lining fabric with "No" against it is a leftover from changing the
    // answer, and it reads as a contradiction on the page.
    lining_fabric: lining === 'Yes' ? txt(b.lining_fabric, 255) : '',
    status,
    costing_us: money(b.costing_us),
    costing_vendor: money(b.costing_vendor),
    final_costing: money(b.final_costing),
    price_website: money(b.price_website),
    price_myntra: money(b.price_myntra),
  };
}

const COLS = ['style_id', 'image_url', 'notes', 'kurta_fabric', 'pant_fabric',
  'dupatta_fabric', 'fabric_remarks', 'has_lining', 'lining_fabric', 'status',
  'costing_us', 'costing_vendor', 'final_costing', 'price_website', 'price_myntra'];

router.get('/samples', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const q = txt(req.query.q, 120);
  const status = STATUSES.includes(txt(req.query.status, 20)) ? txt(req.query.status, 20) : '';

  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (q) {
    where.push(`(style_id LIKE ? OR kurta_fabric LIKE ? OR pant_fabric LIKE ?
                 OR dupatta_fabric LIKE ? OR lining_fabric LIKE ? OR notes LIKE ?)`);
    for (let i = 0; i < 6; i++) args.push('%' + q + '%');
  }
  const sql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const [rows, counts] = await Promise.all([
    db.rows(`SELECT id, ${COLS.join(', ')}, updated_at
               FROM sample_styles ${sql}
              ORDER BY updated_at DESC, id DESC LIMIT 1000`, args),
    // Counted over everything, not the filtered set: the tiles are what the
    // filter is chosen FROM, so narrowing them to the current filter would
    // leave the other number permanently unreachable.
    db.rows(`SELECT status, COUNT(*) n FROM sample_styles GROUP BY status`),
  ]);

  const by = Object.fromEntries(counts.map(c => [c.status, Number(c.n)]));
  res.json({
    rows,
    counts: {
      all: counts.reduce((a, c) => a + Number(c.n), 0),
      production: by.Production || 0,
      outstanding: by.Outstanding || 0,
    },
  });
}));

router.post('/samples', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const v = body(req);
  if (!v.style_id) throw httpError(400, 'Sample Style ID is required');

  const dup = await db.one('SELECT id FROM sample_styles WHERE style_id = ?', [v.style_id]);
  if (dup) throw httpError(409, `Sample Style ID "${v.style_id}" already exists`);

  const [r] = await db.query(
    `INSERT INTO sample_styles (${COLS.join(', ')}, created_by)
     VALUES (${COLS.map(() => '?').join(', ')}, ?)`,
    [...COLS.map(c => v[c]), req.user?.userId || null]);
  res.json({ ok: true, id: r.insertId });
}));

router.put('/samples/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const v = body(req);
  if (!v.style_id) throw httpError(400, 'Sample Style ID is required');

  const dup = await db.one(
    'SELECT id FROM sample_styles WHERE style_id = ? AND id <> ?', [v.style_id, id]);
  if (dup) throw httpError(409, `Sample Style ID "${v.style_id}" already exists`);

  const [r] = await db.query(
    `UPDATE sample_styles SET ${COLS.map(c => c + ' = ?').join(', ')} WHERE id = ?`,
    [...COLS.map(c => v[c]), id]);
  if (!r.affectedRows) throw httpError(404, 'Sample style not found');
  res.json({ ok: true });
}));

router.delete('/samples/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const [r] = await db.query('DELETE FROM sample_styles WHERE id = ?', [Number(req.params.id)]);
  if (!r.affectedRows) throw httpError(404, 'Sample style not found');
  res.json({ ok: true });
}));

module.exports = router;
