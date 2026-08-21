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

const router = express.Router();

const ROW_LIMIT = 500;

router.get('/stock', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    // "low" is a threshold, not a flag — different categories reorder at
    // different levels, so the caller decides what counts as low.
    const low = req.query.low ? Number(req.query.low) : null;

    const where = [];
    const args = [];
    if (q) { where.push('(i.sku LIKE ? OR s.description LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    if (Number.isFinite(low)) { where.push('i.qty <= ?'); args.push(low); }

    // Five independent reads, issued together.
    const [rows, totals, lastSync, lastOk, counts] = await Promise.all([
      db.rows(
        `SELECT i.sku, i.warehouse, i.qty, i.synced_at, COALESCE(s.description, '') AS description
           FROM vin_inventory i
           LEFT JOIN vin_skus s ON s.sku = i.sku
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY i.qty ASC, i.sku ASC
          LIMIT ${ROW_LIMIT}`, args),
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

    res.json({ rows, totals, lastSync, lastOk, counts, truncated: rows.length === ROW_LIMIT });
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
