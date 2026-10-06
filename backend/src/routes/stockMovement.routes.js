// ══════════════════════════════════════════════════════
// STOCK MOVEMENT — what changed, and when (admin only).
// Reads ims_inventory_daily, the per-day snapshot unicommerce-sync writes.
//
// This exists because the question "where did 36,000 units come from?" had no
// answer anywhere in the app. Unicommerce has no read API for adjustments —
// inventory/adjust only writes, and the ledger is a UI report — so the only
// record of a change is the difference between two of our own snapshots.
//
// It is also the gap that made the Vin eRetail stock going to zero so hard to
// explain: there was one row per SKU, overwritten daily, and no way to see
// when it happened.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// mysql2 hands a DATE back as a JS Date, and String() on that is
// "Tue Oct 06 2026 00:00:00 GMT+0530" — which MySQL then refuses. toISOString
// is no good either: a DATE is local midnight, and in IST that lands on the
// previous day in UTC, silently shifting every comparison back one. So the
// parts are read locally.
const ymd = d => {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  const p = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
};

router.get('/stock/movement', requireAuth, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(120, Math.max(2, Number(req.query.days) || 30));
    const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 25));

    // Every day we hold, newest last. With one day there is nothing to compare
    // and the page says so rather than drawing a flat line.
    const daily = await db.rows(
      `SELECT day, warehouse, SUM(qty) units, COUNT(*) rows_n,
              SUM(qty > 0) stocked
         FROM ims_inventory_daily
        WHERE day >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY day, warehouse ORDER BY day, warehouse`, [days]);

    const dayList = [...new Set(daily.map(r => ymd(r.day)))];
    if (dayList.length < 2) {
      return res.json({ days, dayList, daily: daily.map(r => ({ ...r, day: ymd(r.day) })), movers: [], pair: null, onlyOneDay: true });
    }

    // Compare the two most recent days we actually have, not "today and
    // yesterday" — a missed sync would otherwise make the page go blank
    // instead of comparing across the gap.
    const to = dayList[dayList.length - 1], from = dayList[dayList.length - 2];

    const movers = await db.rows(
      `SELECT a.sku, COALESCE(NULLIF(i.name,''), a.sku) name,
              SUM(b.qty) was, SUM(a.qty) now_qty, SUM(a.qty) - SUM(b.qty) diff
         FROM ims_inventory_daily a
         JOIN ims_inventory_daily b
              ON b.sku = a.sku AND b.warehouse = a.warehouse AND b.day = ?
         LEFT JOIN uni_items i ON i.sku = a.sku
        WHERE a.day = ?
        GROUP BY a.sku, i.name
       HAVING diff <> 0
        ORDER BY ABS(diff) DESC LIMIT ?`, [from, to, limit]);

    // SKUs that appear on the newer day with no row on the older one. These are
    // not "gains" in the usual sense — they are SKUs the facility started
    // tracking — so they are counted apart rather than folded into the totals.
    const appeared = await db.one(
      `SELECT COUNT(*) n, COALESCE(SUM(a.qty), 0) units
         FROM ims_inventory_daily a
         LEFT JOIN ims_inventory_daily b
                ON b.sku = a.sku AND b.warehouse = a.warehouse AND b.day = ?
        WHERE a.day = ? AND b.sku IS NULL`, [from, to]);

    const totals = await db.one(
      `SELECT COALESCE(SUM(CASE WHEN d > 0 THEN d END), 0) up,
              COALESCE(SUM(CASE WHEN d < 0 THEN d END), 0) down,
              SUM(d > 0) up_skus, SUM(d < 0) down_skus
         FROM (SELECT SUM(a.qty) - SUM(b.qty) d
                 FROM ims_inventory_daily a
                 JOIN ims_inventory_daily b
                      ON b.sku = a.sku AND b.warehouse = a.warehouse AND b.day = ?
                WHERE a.day = ?
                GROUP BY a.sku HAVING d <> 0) t`, [from, to]);

    res.json({ days, dayList, daily: daily.map(r => ({ ...r, day: ymd(r.day) })), movers, appeared, totals, pair: { from, to } });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ notConfigured: true });
    res.status(500).json({ error: e.message });
  }
});

// One SKU's whole history — what the Stock page could never answer before.
router.get('/stock/history', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sku = String(req.query.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'No SKU' });
    const rows = await db.rows(
      `SELECT day, warehouse, qty FROM ims_inventory_daily
        WHERE sku = ? ORDER BY day, warehouse`, [sku]);
    rows.forEach(r => { r.day = ymd(r.day); });
    const item = await db.one('SELECT sku, name FROM uni_items WHERE sku = ?', [sku]);
    res.json({ sku, item, rows });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ notConfigured: true });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
