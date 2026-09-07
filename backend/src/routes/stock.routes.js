// ══════════════════════════════════════════════════════
// STOCK — live warehouse stock pulled from Vinculum (Vin eRetail).
// This reads the tables vinculum-sync.js fills; it never calls Vinculum itself,
// so a slow or rate-limited API can never make the page hang. If the sync has
// not run, the page says so rather than showing an empty table as the truth.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin, requireCronSecret } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errors');
const { runVinculumSync } = require('../services/scheduler');
const vin = require('../../vinculum');
const skuGroup = require('../services/skuGroup');

const router = express.Router();

const ROW_LIMIT = 500;
// Clubbing has to see every row before it can add anything up — a product cut
// off at row 500 would report a fraction of its stock as the whole. This cap
// only exists so a runaway table cannot take the page down; hitting it is
// reported as truncated, the same as any other trim.
const GROUP_SCAN_LIMIT = 50000;

router.get('/stock', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    // "low" is a threshold, not a flag — different categories reorder at
    // different levels, so the caller decides what counts as low.
    const low = req.query.low ? Number(req.query.low) : null;
    // Window for the "sold" / reorder column (days). Validated to a bare int so
    // it is safe to interpolate into the INTERVAL below.
    const soldDays = Math.min(365, Math.max(1, parseInt(req.query.soldDays, 10) || 45));
    // Reorder view: only SKUs selling faster than they are stocked. Computed
    // after the sold column is joined in, so it can't be a plain WHERE.
    const reorder = req.query.reorder === '1';
    // Club every size (and optionally every colour) of a product onto one row.
    // A kurta in five sizes and two colours is ten SKUs, so an unclubbed page of
    // stock is really a page of one product. 'sku' — the default — is off.
    const asked = String(req.query.groupBy || 'sku');
    const grouping = (skuGroup.isMode(asked) && asked !== 'sku') ? asked : null;

    const where = [];
    const args = [];
    if (q) { where.push('(i.sku LIKE ? OR s.description LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    // The low threshold is skipped in reorder mode — reorder is its own filter,
    // applied after the sold figures are known.
    // It is also skipped when clubbing: filtering single sizes and then adding
    // them up would report a product as low on stock because one size is.
    if (!reorder && !grouping && Number.isFinite(low)) { where.push('i.qty <= ?'); args.push(low); }

    // Five independent reads, issued together.
    let [rows, totals, lastSync, lastOk, counts] = await Promise.all([
      db.rows(
        `SELECT i.sku, i.warehouse, i.qty, i.synced_at, COALESCE(s.description, '') AS description
           FROM vin_inventory i
           LEFT JOIN vin_skus s ON s.sku = i.sku
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY i.qty ASC, i.sku ASC
          LIMIT ${grouping ? GROUP_SCAN_LIMIT : reorder ? 2000 : ROW_LIMIT}`, args),
      db.rows(
        `SELECT warehouse, COUNT(*) AS skus, COALESCE(SUM(qty),0) AS units
           FROM vin_inventory WHERE qty > 0 GROUP BY warehouse ORDER BY warehouse`),
      // Two questions, not one. "How old is this data?" is answered by the last
      // run that actually succeeded; "is anything wrong?" by the most recent
      // attempt. Reporting only the latest row makes good data look broken the
      // moment a retry fails after a successful run.
      db.one(
        `SELECT started_at, ended_at, rows_seen, ok, error
           FROM vin_sync_log WHERE kind='inventory' ORDER BY id DESC LIMIT 1`),
      db.one(
        `SELECT started_at, ended_at, rows_seen
           FROM vin_sync_log WHERE kind='inventory' AND ok=1 ORDER BY id DESC LIMIT 1`),
      db.one(
        `SELECT COUNT(*) AS tracked, SUM(CASE WHEN qty <= 0 THEN 1 ELSE 0 END) AS out_of_stock
           FROM vin_inventory`),
    ]);

    // Enrich each row with units sold in the window (from live orders), turning
    // the stock list into a reorder view. Separate, guarded query — if orders
    // were never synced the column is simply blank, not an error.
    try {
      if (grouping) {
        // Grouping needs every row, so the SKU list would be thousands long.
        // Asking for the whole window's sales in one go is cheaper than an IN
        // clause that size, and the extra SKUs simply go unclaimed.
        const sold = await db.rows(
          `SELECT it.sku, SUM(it.order_qty) sold
             FROM vin_order_items it JOIN vin_orders o ON o.order_id = it.order_id
            WHERE LOWER(it.status) <> 'cancelled'
              AND o.order_date >= DATE_SUB(CURDATE(), INTERVAL ${soldDays} DAY)
            GROUP BY it.sku`);
        const m = {};
        for (const s of sold) m[s.sku] = Number(s.sold) || 0;
        rows.forEach(r => { r.sold = m[r.sku] || 0; });
      } else {
        const skus = [...new Set(rows.map(r => r.sku))];
        if (skus.length) {
          const sold = await db.rows(
            `SELECT it.sku, SUM(it.order_qty) sold
               FROM vin_order_items it JOIN vin_orders o ON o.order_id = it.order_id
              WHERE LOWER(it.status) <> 'cancelled'
                AND o.order_date >= DATE_SUB(CURDATE(), INTERVAL ${soldDays} DAY)
                AND it.sku IN (${skus.map(() => '?').join(',')})
              GROUP BY it.sku`, skus);
          const m = {};
          for (const s of sold) m[s.sku] = Number(s.sold) || 0;
          rows.forEach(r => { r.sold = m[r.sku] || 0; });
        }
      }
    } catch (_) { rows.forEach(r => { r.sold = 0; }); }

    // Club sizes (and optionally colours) onto one row per product. This has to
    // happen after the sold figures land, so a clubbed row's sales are the sum
    // of its members' — and before the filters below, so "10 or fewer" means ten
    // of the product, not ten of one size.
    // Whether the scan itself was cut short — once rows are clubbed the raw
    // count is gone, and a clubbed row built from a truncated scan under-reports
    // its own stock, so this has to be remembered here.
    const scanCutShort = grouping ? rows.length >= GROUP_SCAN_LIMIT : false;
    if (grouping) {
      rows = skuGroup.collapse(rows, grouping);
      rows.sort((a, b) => (a.qty - b.qty) || String(a.sku).localeCompare(String(b.sku)));
      if (!reorder && Number.isFinite(low)) rows = rows.filter(r => Number(r.qty) <= low);
    }

    // In reorder mode, keep only SKUs whose sales outrun their stock, most
    // under-stocked first, then trim to the display limit.
    let outRows = rows;
    if (reorder) {
      outRows = rows
        .filter(r => Number(r.sold) > 0 && Number(r.sold) > Number(r.qty))
        .sort((a, b) => (Number(b.sold) - Number(b.qty)) - (Number(a.sold) - Number(a.qty)))
        .slice(0, ROW_LIMIT);
    }

    // Period cards — units sold and how many SKUs need reorder in the chosen
    // window. Guarded: without synced orders these simply don't render.
    let period = { soldDays, hasOrders: false };
    try {
      const u = await db.one(
        `SELECT ROUND(SUM(it.order_qty)) units, COUNT(DISTINCT it.sku) skus
           FROM vin_order_items it JOIN vin_orders o ON o.order_id = it.order_id
          WHERE LOWER(it.status) <> 'cancelled'
            AND o.order_date >= DATE_SUB(CURDATE(), INTERVAL ${soldDays} DAY)`);
      const rc = await db.one(
        `SELECT COUNT(*) n FROM (
           SELECT i.qty, COALESCE(sold.s, 0) sold
             FROM vin_inventory i
             LEFT JOIN (
               SELECT it.sku, SUM(it.order_qty) s
                 FROM vin_order_items it JOIN vin_orders o ON o.order_id = it.order_id
                WHERE LOWER(it.status) <> 'cancelled'
                  AND o.order_date >= DATE_SUB(CURDATE(), INTERVAL ${soldDays} DAY)
                GROUP BY it.sku
             ) sold ON sold.sku = i.sku
            WHERE COALESCE(sold.s, 0) > i.qty AND COALESCE(sold.s, 0) > 0
         ) t`);
      period = {
        soldDays, hasOrders: true,
        soldUnits: Number(u?.units) || 0,
        skusSold: Number(u?.skus) || 0,
        reorderCount: Number(rc?.n) || 0,
      };
    } catch (_) { /* orders not synced yet */ }

    res.json({
      rows: grouping ? outRows.slice(0, ROW_LIMIT) : outRows,
      totals, lastSync, lastOk, counts, soldDays, period,
      groupBy: grouping || 'sku',
      truncated: scanCutShort || (reorder
        ? outRows.length === ROW_LIMIT
        : outRows.length > ROW_LIMIT || (!grouping && rows.length === ROW_LIMIT)),
    });
  } catch (e) {
    // A missing table means the sync has never been set up on this deployment.
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ rows: [], totals: [], lastSync: null, counts: null, notConfigured: true });
    }
    console.error('  ❌ /api/stock:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Live per-SKU check — skips the snapshot and asks Vinculum right now.
// One call covers up to 20 SKUs (the API's per-call cap) and finishes in a
// second or two, so unlike the full six-minute sync it runs inside a normal
// request — and works on Vercel. The snapshot is updated with what comes back,
// so the freshly-checked rows stay correct after the page reloads.
router.get('/stock/live', requireAuth, asyncRoute(async (req, res) => {
  const asked = String(req.query.skus || '').split(',').map(s => s.trim()).filter(Boolean);
  const skus = [...new Set(asked)].slice(0, 20);   // API cap is 20 per call
  if (!skus.length) return res.status(400).json({ error: 'No SKUs to check' });
  if (!vin.isConfigured()) return res.status(400).json({ error: 'Vinculum is not configured on this server' });

  let rows;
  try {
    rows = await vin.fetchInventoryBatch(skus);
  } catch (e) {
    return res.status(502).json({ error: 'Vinculum: ' + (e.message || 'call failed') });
  }

  // Push live values into the snapshot so the table reflects them.
  if (rows.length) {
    await db.rows(
      `INSERT INTO vin_inventory (sku, warehouse, qty) VALUES ?
       ON DUPLICATE KEY UPDATE qty = VALUES(qty), synced_at = CURRENT_TIMESTAMP`,
      [rows.map(r => [r.sku, r.warehouse, r.qty])]);
  }

  // A checked SKU absent from the response is out of stock now. Zero only the
  // (sku, warehouse) rows we already track — don't invent new warehouse rows.
  const seen = new Set(rows.map(r => r.sku + '|' + r.warehouse));
  const existing = await db.rows(
    `SELECT sku, warehouse FROM vin_inventory WHERE sku IN (${skus.map(() => '?').join(',')})`, skus);
  const stale = existing.filter(e => !seen.has(e.sku + '|' + e.warehouse));
  if (stale.length) {
    await db.rows(
      `UPDATE vin_inventory SET qty = 0, synced_at = CURRENT_TIMESTAMP
        WHERE (sku, warehouse) IN (${stale.map(() => '(?,?)').join(',')})`,
      stale.flatMap(e => [e.sku, e.warehouse]));
  }

  res.json({ checked: skus.length, found: rows.length, live: rows });
}));

// Manual trigger (admin) — the Stock page's "Sync now" button. Runs the same
// job the scheduler runs, so what you test is what runs at 6 AM.
// It starts the sync and returns immediately. A full run takes about ten
// minutes (20 SKUs per call, plus a forced wait when the 40-call quota trips),
// and holding an HTTP request open that long is a promise nothing can keep: a
// restart, a sleeping laptop or a proxy timeout kills it and the browser
// reports a failure for a sync that is running fine. On Vercel it could never
// work at all. So: kick it off, say it started, let the page watch vin_sync_log.
router.post('/stock/sync', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const sync = require('../../vinculum-sync');
  await sync.ensureTables();
  const running = await sync.runInProgress();
  if (running) {
    const mins = Math.round((Date.now() - new Date(running.started_at).getTime()) / 60000);
    return res.status(409).json({
      alreadyRunning: true, startedMinutesAgo: mins,
      error: `A stock sync is already running (started ${mins} min ago). It will finish on its own.`,
    });
  }

  // Detached on purpose. Errors are recorded in vin_sync_log by the job itself,
  // so this catch only prevents an unhandled rejection.
  runVinculumSync().catch(e => console.error('  ❌ background stock sync:', e.message));
  res.json({ started: true });
}));

// Cron entry point, for Vercel. Shared-secret auth — cron has no session.
router.get('/cron/vinculum-sync', requireCronSecret, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await runVinculumSync()) });
}));

module.exports = router;
