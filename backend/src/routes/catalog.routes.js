// ══════════════════════════════════════════════════════
// CATALOG — the SKU master from Unicommerce (admin only).
// Reads uni_items, with current stock joined on.
//
// Vin eRetail never opened its SKU master, so the SKU list was seeded from a
// CSV and went stale the moment somebody added a product. Unicommerce hands
// over the whole thing — 5,900 SKUs with price, HSN, GST code, weight and EAN —
// and until now none of it was visible anywhere in the app.
//
// Stock is joined because a catalogue without it answers half a question. The
// one people actually ask is "what is this SKU and do we have any".
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const PER = 200;

router.get('/catalog', requireAuth, requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const filter = String(req.query.filter || '').trim();

    const where = [];
    const args = [];
    if (q) {
      where.push('(i.sku LIKE ? OR i.name LIKE ? OR i.ean LIKE ? OR i.hsn_code LIKE ?)');
      const like = `%${q}%`;
      args.push(like, like, like, like);
    }
    // Filters are the gaps worth chasing, not decoration: a SKU with no price
    // cannot be valued and one with no HSN cannot be invoiced.
    if (filter === 'nostock')  where.push('COALESCE(s.qty, 0) <= 0');
    if (filter === 'instock')  where.push('COALESCE(s.qty, 0) > 0');
    if (filter === 'noprice')  where.push('(i.price IS NULL OR i.price = 0)');
    if (filter === 'nohsn')    where.push("(i.hsn_code IS NULL OR i.hsn_code = '')");
    if (filter === 'disabled') where.push('i.enabled = 0');
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const stockJoin = `LEFT JOIN (SELECT sku, SUM(inventory) qty FROM uni_inventory GROUP BY sku) s ON s.sku = i.sku`;

    const [totals, cnt, rows] = await Promise.all([
      db.one(
        `SELECT COUNT(*) skus,
                SUM(price > 0) priced,
                SUM(hsn_code IS NOT NULL AND hsn_code <> '') with_hsn,
                SUM(enabled = 0) disabled,
                ROUND(AVG(NULLIF(price, 0))) avg_price
           FROM uni_items`),
      db.one(`SELECT COUNT(*) n FROM uni_items i ${stockJoin} ${whereSql}`, args),
      db.rows(
        `SELECT i.sku, i.name, i.brand, i.color, i.size, i.price, i.base_price,
                i.hsn_code, i.gst_tax_type, i.ean, i.weight, i.enabled,
                i.category_name, COALESCE(s.qty, 0) qty
           FROM uni_items i ${stockJoin} ${whereSql}
          ORDER BY i.sku
          LIMIT ${PER} OFFSET ${(page - 1) * PER}`, args),
    ]);

    const total = cnt ? cnt.n : 0;
    res.json({
      totals, rows, total, page, per: PER,
      pages: Math.max(1, Math.ceil(total / PER)),
    });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ notConfigured: true });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
