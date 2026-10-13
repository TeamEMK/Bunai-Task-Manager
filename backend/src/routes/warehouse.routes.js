// ══════════════════════════════════════════════════════
// WAREHOUSE (/api/warehouse)
//
// Bunai and Surat read as one business everywhere else on this site, and they
// are not one warehouse. They hold entirely different ranges — 1,182 SKUs at
// Bunai, 2,365 at Surat, and not a single SKU in both — and they serve
// different channels: Surat fulfils MYNTRAPPMP_GUJRAT, Bunai fulfils
// MYNTRAPPMP and every Shopify order.
//
// Four numbers per variant, which is what the client asked for: what is in
// stock, what has shipped, what came back as RTO, and what came back as a
// return.
//
// STOCK IS NOT PERIOD-BOUND, and the other three are. Stock is what sits on the
// shelf at this moment; there is no history of it per SKU to look back through.
// Shipped, RTO and Return are counted over the window. Mixing the two on one
// row is only honest if the page says so, and it does.
//
// Unicommerce stores no quantity on an order line: one line is one unit, which
// is why these are counts rather than sums.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errors');

const router = express.Router();

// Surat is MYNTRA_GUJRAT in Unicommerce. The code is the Myntra channel it was
// set up for, not the place, so it is translated here rather than shown raw.
const WAREHOUSES = {
  bunai: { code: 'bunai', label: 'Bunai' },
  surat: { code: 'MYNTRA_GUJRAT', label: 'Surat' },
};

// Everything Unicommerce timestamps is UTC; every date this site shows is IST.
const IST = '+ INTERVAL 330 MINUTE';
const TODAY_IST = `DATE(UTC_TIMESTAMP() ${IST})`;

const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);

// Three windows, as asked: everything, this month, or a chosen range.
function window(req, col) {
  const period = String(req.query.period || 'lifetime').toLowerCase();
  if (period === 'month') {
    return {
      sql: `AND ${col} ${IST} >= DATE_FORMAT(${TODAY_IST}, '%Y-%m-01')`,
      args: [], label: 'This month',
    };
  }
  if (period === 'range') {
    const from = ymd(req.query.from);
    const to = ymd(req.query.to);
    if (from && to) {
      return {
        sql: `AND DATE(${col} ${IST}) BETWEEN ? AND ?`,
        args: [from, to], label: `${from} to ${to}`,
      };
    }
  }
  return { sql: '', args: [], label: 'Lifetime' };
}

router.get('/warehouse', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const key = String(req.query.facility || 'surat').toLowerCase();
  const wh = WAREHOUSES[key] || WAREHOUSES.surat;
  const code = wh.code;

  const o = window(req, 'o.order_date');
  const r = window(req, 'rr.return_date');

  // Shipped means it left the building. FULFILLABLE is still on the shelf and
  // CANCELLED never went, so neither counts.
  const SHIPPED = "('DISPATCHED','DELIVERED','SHIPPED','COMPLETE')";

  const [stock, shipped, rto, ret, skuNames] = await Promise.all([
    db.rows(
      `SELECT sku, SUM(inventory) qty FROM uni_inventory
        WHERE facility = ? GROUP BY sku`, [code]),
    db.rows(
      `SELECT i.sku, COUNT(*) units
         FROM uni_order_items i JOIN uni_orders o ON o.code = i.order_code
        WHERE i.facility = ? AND i.status IN ${SHIPPED} ${o.sql}
        GROUP BY i.sku`, [code, ...o.args]),
    db.rows(
      `SELECT ri.sku, COUNT(*) units
         FROM uni_return_items ri JOIN uni_returns rr ON rr.code = ri.return_code
        WHERE rr.facility = ? AND rr.return_type = 'RTO' ${r.sql}
        GROUP BY ri.sku`, [code, ...r.args]),
    db.rows(
      `SELECT ri.sku, COUNT(*) units
         FROM uni_return_items ri JOIN uni_returns rr ON rr.code = ri.return_code
        WHERE rr.facility = ? AND COALESCE(rr.return_type,'') <> 'RTO' ${r.sql}
        GROUP BY ri.sku`, [code, ...r.args]),
    db.rows(`SELECT sku, name FROM uni_items WHERE name IS NOT NULL AND name <> ''`),
  ]);

  const names = new Map(skuNames.map((x) => [x.sku, x.name]));
  const rows = new Map();
  const put = (sku, field, v) => {
    if (!sku) return;
    if (!rows.has(sku)) {
      rows.set(sku, { sku, name: names.get(sku) || '', stock: 0, shipped: 0, rto: 0, returned: 0 });
    }
    rows.get(sku)[field] += Number(v) || 0;
  };
  stock.forEach((x) => put(x.sku, 'stock', x.qty));
  shipped.forEach((x) => put(x.sku, 'shipped', x.units));
  rto.forEach((x) => put(x.sku, 'rto', x.units));
  ret.forEach((x) => put(x.sku, 'returned', x.units));

  // Busiest first, then whatever is left sitting in stock. A SKU that neither
  // moved nor is stocked is noise.
  const list = [...rows.values()]
    .filter((x) => x.stock || x.shipped || x.rto || x.returned)
    .sort((a, b) => (b.shipped - a.shipped) || (b.stock - a.stock));

  res.json({
    facility: { key, code, label: wh.label },
    period: o.label,
    totals: {
      skus: list.length,
      stock: list.reduce((a, b) => a + b.stock, 0),
      shipped: list.reduce((a, b) => a + b.shipped, 0),
      rto: list.reduce((a, b) => a + b.rto, 0),
      returned: list.reduce((a, b) => a + b.returned, 0),
    },
    rows: list.slice(0, 2000),
    truncated: Math.max(0, list.length - 2000),
  });
}));

// Both warehouses side by side, for the headline comparison.
router.get('/warehouse/compare', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const o = window(req, 'o.order_date');
  const r = window(req, 'rr.return_date');
  const out = [];

  for (const key of Object.keys(WAREHOUSES)) {
    const code = WAREHOUSES[key].code;
    const [stock, shipped, rto, ret] = await Promise.all([
      // Only what is actually stocked. uni_inventory keeps a row for a SKU
      // that has gone to zero, and counting those made this tile disagree with
      // the table below it — 2,365 against 2,003 for the same warehouse.
      db.one(`SELECT COUNT(DISTINCT CASE WHEN inventory > 0 THEN sku END) skus,
                     SUM(inventory) qty
                FROM uni_inventory WHERE facility = ?`, [code]),
      db.one(`SELECT COUNT(*) units FROM uni_order_items i
                JOIN uni_orders o ON o.code = i.order_code
               WHERE i.facility = ? AND i.status IN ('DISPATCHED','DELIVERED','SHIPPED','COMPLETE')
                 ${o.sql}`, [code, ...o.args]),
      db.one(`SELECT COUNT(*) units FROM uni_return_items ri
                JOIN uni_returns rr ON rr.code = ri.return_code
               WHERE rr.facility = ? AND rr.return_type = 'RTO' ${r.sql}`, [code, ...r.args]),
      db.one(`SELECT COUNT(*) units FROM uni_return_items ri
                JOIN uni_returns rr ON rr.code = ri.return_code
               WHERE rr.facility = ? AND COALESCE(rr.return_type,'') <> 'RTO' ${r.sql}`,
             [code, ...r.args]),
    ]);
    out.push({
      key, code, label: WAREHOUSES[key].label,
      skus: Number(stock?.skus) || 0,
      stock: Number(stock?.qty) || 0,
      shipped: Number(shipped?.units) || 0,
      rto: Number(rto?.units) || 0,
      returned: Number(ret?.units) || 0,
    });
  }
  res.json({ period: o.label, warehouses: out });
}));

module.exports = router;
