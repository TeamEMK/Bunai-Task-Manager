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
const { runUnicommerceSync } = require('../services/scheduler');
const uni = require('../../unicommerce');
const skuGroup = require('../services/skuGroup');
const brands = require('../services/brands');
const imsData = require('../services/imsData');

// "Needs reorder" is the IMS's own answer, not a second rule: a SKU needs
// reordering when its stock is below its order point - average daily sale over
// the IMS window (net of returns, every channel) times the cover days. The
// Stock page used to flag "sold this month > stock", which named 90 SKUs while
// the IMS named 135 for the same day, and nobody could say which was right.
// Read from the IMS's own calculation, so the two can never disagree.
// It follows the page's Sold dropdown: month to date is the IMS's own month to
// date (withChannel + 'mtd'), any other choice that many days - so Stock and
// the IMS on the same window always name the same SKUs.
async function reorderPlan(soldDays, mtd) {
  try {
    const base = mtd
      ? await imsData.withChannel('', () => imsData.skuBase(), 'mtd')
      : await imsData.skuBase({ windowDays: soldDays });
    return new Map(base.filter(r => r.toBeOrder > 0).map(r => [r.sku, r]));
  } catch (e) {
    console.error('  ⚠ reorder plan:', e.message);
    return null;
  }
}

const router = express.Router();

const ROW_LIMIT = 500;
// Clubbing has to see every row before it can add anything up — a product cut
// off at row 500 would report a fraction of its stock as the whole. This cap
// only exists so a runaway table cannot take the page down; hitting it is
// reported as truncated, the same as any other trim.
const GROUP_SCAN_LIMIT = 50000;

// The Sold and Needs reorder cards, for the chosen window and warehouse, in one
// query. Orders carry no warehouse; the two warehouses share no SKU, so a sale
// is counted for the warehouse whose list holds that SKU. Without synced orders
// the cards simply do not render.
async function periodFigures(soldDays, mtd, wh, brand) {
  const since = `DATE_SUB(DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE), INTERVAL ${soldDays} DAY)`;
  const bIt = brand ? ' AND ' + brands.sql(brand, 'it.sku') : '';
  const bI = brand ? ' AND ' + brands.sql(brand, 'i.sku') : '';
  try {
    const r = await db.one(
      `SELECT
         (SELECT ROUND(SUM(it.order_qty)) FROM ims_order_items it
           WHERE LOWER(it.status) <> 'cancelled' AND it.order_date >= ${since}${bIt}
             ${wh ? 'AND it.sku IN (SELECT sku FROM ims_inventory WHERE warehouse = ?)' : ''}) AS units,
         (SELECT COUNT(DISTINCT it.sku) FROM ims_order_items it
           WHERE LOWER(it.status) <> 'cancelled' AND it.order_date >= ${since}${bIt}
             ${wh ? 'AND it.sku IN (SELECT sku FROM ims_inventory WHERE warehouse = ?)' : ''}) AS skus,
         (SELECT COUNT(*) FROM ims_inventory i
            LEFT JOIN (SELECT it.sku, SUM(it.order_qty) s FROM ims_order_items it
                        WHERE LOWER(it.status) <> 'cancelled' AND it.order_date >= ${since}
                        GROUP BY it.sku) sold ON sold.sku = i.sku
           WHERE COALESCE(sold.s, 0) > i.qty AND COALESCE(sold.s, 0) > 0${bI}
             ${wh ? 'AND i.warehouse = ?' : ''}) AS reorder_n`,
      wh ? [wh, wh, wh] : []);
    return {
      soldDays, mtd, hasOrders: true,
      soldUnits: Number(r && r.units) || 0,
      skusSold: Number(r && r.skus) || 0,
      reorderCount: Number(r && r.reorder_n) || 0,
    };
  } catch (_) {
    return { soldDays, mtd, hasOrders: false };
  }
}

router.get('/stock', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    // "low" is a threshold, not a flag — different categories reorder at
    // different levels, so the caller decides what counts as low.
    const low = req.query.low ? Number(req.query.low) : null;
    // The lists behind two of the cards: "oos" - selling, and none left (the
    // Out of stock card); "sold" - sold in the window, most sold first (the
    // Sold card). Like reorder, both need the sales before they can filter.
    const view = ['oos', 'sold'].includes(req.query.view) ? req.query.view : '';
    // Window for the "sold" / reorder column (days). Validated to a bare int so
    // it is safe to interpolate into the INTERVAL below.
    // "mtd" is the window the page opens on: from the 1st of this month, India's
    // month, through today. The window is counted back from today, so that is
    // today's date minus one fewer than the day of the month - zero on the 1st,
    // which the ordinary clamp to 1 would turn into "since yesterday" and pull
    // last month's final day into a new month's figure.
    const mtd = String(req.query.soldDays) === 'mtd';
    const soldDays = mtd
      ? new Date(Date.now() + 330 * 60000).getUTCDate() - 1
      : Math.min(365, Math.max(1, parseInt(req.query.soldDays, 10) || 45));
    // Reorder view: only SKUs selling faster than they are stocked. Computed
    // after the sold column is joined in, so it can't be a plain WHERE.
    const reorder = req.query.reorder === '1';
    // Club every size (and optionally every colour) of a product onto one row.
    // A kurta in five sizes and two colours is ten SKUs, so an unclubbed page of
    // stock is really a page of one product. 'sku' — the default — is off.
    const asked = String(req.query.groupBy || 'sku');
    const grouping = (skuGroup.isMode(asked) && asked !== 'sku') ? asked : null;

    // One warehouse, or all of them. It only ever reaches a query as a bound
    // parameter; the shape check just keeps nonsense out. A name that is not a
    // real warehouse finds no rows, and the reply says no warehouse was chosen.
    const wh = /^[A-Za-z0-9_-]{1,40}$/.test(String(req.query.warehouse || '')) ? String(req.query.warehouse) : '';
    // The same filter, for each query below that reads ims_inventory as "i".
    // And one brand (Bunai, Aaheli, Mulmul, other), by the SKU's prefix.
    const brand = brands.pick(req.query.brand);
    const whI = (wh ? ' AND i.warehouse = ?' : '') + (brand ? ' AND ' + brands.sql(brand, 'i.sku') : '');
    const whA = wh ? [wh] : [];

    const where = [];
    const args = [];
    if (wh) { where.push('i.warehouse = ?'); args.push(wh); }
    if (brand) where.push(brands.sql(brand, 'i.sku'));
    if (q) { where.push('(i.sku LIKE ? OR s.description LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    // The low threshold is skipped in reorder mode — reorder is its own filter,
    // applied after the sold figures are known.
    // It is also skipped when clubbing: filtering single sizes and then adding
    // them up would report a product as low on stock because one size is.
    if (!reorder && !view && !grouping && Number.isFinite(low)) { where.push('i.qty <= ?'); args.push(low); }
    if (view === 'oos') where.push('i.qty <= 0');

    // Five independent reads, issued together.
    // Started now and awaited at the end, so it runs while the rows are read
    // and their sales looked up, instead of after.
    const periodP = periodFigures(soldDays, mtd, wh, brand);
    const planP = reorderPlan(soldDays, mtd);
    // "__none" is the tab for SKUs the IMS wants reordered that no warehouse
    // lists at all - sold in the window, but Unicommerce holds no stock row for
    // them anywhere. Without it Bunai + Gujarat never added up to All.
    const NONE = '__none';
    const whSkusP = wh && wh !== NONE ? db.rows('SELECT DISTINCT sku FROM ims_inventory WHERE warehouse = ?', [wh]) : null;
    const allSkusP = db.rows('SELECT DISTINCT sku FROM ims_inventory');

    // Every query here is a round trip to a database in another region (about
    // a quarter of a second each), through a pool of two connections. So
    // anything that can be one query is: the warehouse cards, the warehouse
    // tabs and the styles count all come from one read of the stocked SKUs,
    // and both sync-log rows from one.
    let [rows, syncPair, counts, inStockAll] = await Promise.all([
      db.rows(
        `SELECT i.sku, i.warehouse, i.qty, i.synced_at, COALESCE(s.description, '') AS description
           FROM ims_inventory i
           LEFT JOIN ims_skus s ON s.sku = i.sku
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY i.qty ASC, i.sku ASC
          LIMIT ${grouping || reorder || view ? GROUP_SCAN_LIMIT : ROW_LIMIT}`, args),
      // Two questions, not one. "How old is this data?" is answered by the last
      // run that actually succeeded; "is anything wrong?" by the most recent
      // attempt. Reporting only the latest row makes good data look broken the
      // moment a retry fails after a successful run.
      db.rows(
        `(SELECT 'last' AS k, started_at, ended_at, rows_seen, ok, error
            FROM ims_sync_log WHERE kind='inventory' ORDER BY id DESC LIMIT 1)
         UNION ALL
         (SELECT 'ok' AS k, started_at, ended_at, rows_seen, ok, error
            FROM ims_sync_log WHERE kind='inventory' AND ok=1 ORDER BY id DESC LIMIT 1)`),
      // "Out of stock" counts SKUs that were SELLING and have run out, not every
      // row sitting at zero. The raw zero count was 368 against 4 that actually
      // matter: most zeros are SKUs a facility has started tracking and never
      // stocked, and lumping them together turned a figure somebody should act
      // on into one nobody reads. The plain count stays as zero_rows for the
      // sub-label, since "368 rows at zero" is still worth knowing.
      // The sold-SKU set is built once and joined, not asked per row. As a
      // correlated EXISTS this ran the sales lookup for all 3,500 inventory
      // rows and took the page from fast to unusable.
      db.one(
        `SELECT COUNT(*) AS tracked,
                SUM(i.qty <= 0) AS zero_rows,
                SUM(i.qty <= 0 AND sold.sku IS NOT NULL) AS out_of_stock
           FROM ims_inventory i
           LEFT JOIN (
             SELECT DISTINCT oi.sku
               FROM ims_order_items oi
              WHERE LOWER(oi.status) <> 'cancelled'
                AND oi.order_date >= DATE_SUB(DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE), INTERVAL ${soldDays} DAY)
           ) sold ON sold.sku = i.sku
          WHERE 1=1${whI}`, whA),
      // Which SKUs hold stock, so the cards can also say how many products that
      // is. A product is not in the database - only in the SKU's spelling - so
      // it is worked out with the same rule the Club sizes view uses.
      db.rows(`SELECT warehouse, sku, qty FROM ims_inventory WHERE qty > 0`),
    ]);

    // The warehouse tabs and cards count only the chosen brand's stock.
    if (brand) inStockAll = inStockAll.filter(r => brands.of(r.sku) === brand);

    const pickSync = (k) => {
      const r = syncPair.find(x => x.k === k);
      if (!r) return null;
      const { k: _k, ...rest } = r;
      return k === 'ok' ? { started_at: rest.started_at, ended_at: rest.ended_at, rows_seen: rest.rows_seen } : rest;
    };
    const lastSync = pickSync('last');
    const lastOk = pickSync('ok');

    // Per warehouse: SKUs with stock and their units. All of them for the tabs;
    // only the chosen one for the cards.
    const byWh = new Map();
    for (const r of inStockAll) {
      let w = byWh.get(r.warehouse);
      if (!w) byWh.set(r.warehouse, (w = { warehouse: r.warehouse, skus: 0, units: 0 }));
      w.skus++;
      w.units += Number(r.qty) || 0;
    }
    const allWh = [...byWh.values()].sort((a, b) => String(a.warehouse).localeCompare(String(b.warehouse)));
    const known = !!wh && byWh.has(wh);
    const totals = allWh.filter(w => !wh || w.warehouse === wh).map(w => ({ ...w, units: String(w.units) }));
    const inStock = wh ? inStockAll.filter(r => r.warehouse === wh) : inStockAll;

    // One product = one design in one colour, every size of it counted once:
    // the same grouping as "Club sizes", so a card and that view agree.
    const styleSets = new Map();
    for (const r of inStock) {
      if (!styleSets.has(r.warehouse)) styleSets.set(r.warehouse, new Set());
      styleSets.get(r.warehouse).add(skuGroup.styleKey(r.sku));
    }
    totals.forEach(t => { t.styles = (styleSets.get(t.warehouse) || new Set()).size; });

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
             FROM ims_order_items it
            WHERE LOWER(it.status) <> 'cancelled'
              AND it.order_date >= DATE_SUB(DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE), INTERVAL ${soldDays} DAY)
            GROUP BY it.sku`);
        const m = {};
        for (const s of sold) m[s.sku] = Number(s.sold) || 0;
        rows.forEach(r => { r.sold = m[r.sku] || 0; });
      } else {
        const skus = [...new Set(rows.map(r => r.sku))];
        if (skus.length) {
          const sold = await db.rows(
            `SELECT it.sku, SUM(it.order_qty) sold
               FROM ims_order_items it
              WHERE LOWER(it.status) <> 'cancelled'
                AND it.order_date >= DATE_SUB(DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE), INTERVAL ${soldDays} DAY)
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
      if (!reorder && !view && Number.isFinite(low)) rows = rows.filter(r => Number(r.qty) <= low);
    }

    // How many to order, from the IMS, on every row - a clubbed row is the sum
    // of its sizes.
    const [plan, whSkuRows, allSkuRows] = await Promise.all([planP, whSkusP, allSkusP]);
    const toOrderOf = (r) => (plan ? (r.skus || [r.sku]).reduce((a, s) => a + ((plan.get(s) || {}).toBeOrder || 0), 0) : 0);
    rows.forEach(r => { r.toOrder = toOrderOf(r); });
    const stocked = new Set(allSkuRows.map(r => r.sku));
    const noWh = plan ? [...plan.entries()].filter(([s]) => !stocked.has(s) && (!brand || brands.of(s) === brand)
      && (!q || s.toLowerCase().includes(q.toLowerCase()) || String((plan.get(s) || {}).productName || '').toLowerCase().includes(q.toLowerCase()))) : [];

    // In reorder mode, the IMS's list: the most to order first. A SKU the IMS
    // wants that has no stock row anywhere (sold, never stocked here) is still
    // listed, at zero, so the list and the count are the same SKUs.
    let outRows = rows;
    if (reorder) {
      outRows = rows.filter(r => r.toOrder > 0);
      if (plan && !wh && !grouping && !q) {
        const listed = new Set(outRows.map(r => r.sku));
        for (const [sku, p] of plan) {
          if (listed.has(sku) || (brand && brands.of(sku) !== brand)) continue;
          outRows.push({ sku, warehouse: '—', qty: 0, sold: 0, description: p.productName || '', toOrder: p.toBeOrder });
        }
      }
      outRows = outRows.sort((a, b) => b.toOrder - a.toOrder).slice(0, ROW_LIMIT);
    }
    if (view) {
      outRows = rows.filter(r => Number(r.sold) > 0 && (view === 'sold' || Number(r.qty) <= 0))
        .sort((a, b) => Number(b.sold) - Number(a.sold)).slice(0, ROW_LIMIT);
    }
    if (wh === NONE) {
      outRows = noWh.map(([sku, p]) => ({ sku, warehouse: '—', qty: 0, sold: p.soldQty || 0, description: p.productName || '', toOrder: p.toBeOrder }))
        .sort((a, b) => b.toOrder - a.toOrder).slice(0, ROW_LIMIT);
    }

    const period = await periodP;
    // The card counts SKUs, as the IMS does - for the brand and warehouse chosen.
    if (period && plan) {
      const inWh = whSkuRows ? new Set(whSkuRows.map(r => r.sku)) : null;
      period.reorderCount = wh === NONE ? noWh.length : [...plan.keys()]
        .filter(s => (!brand || brands.of(s) === brand) && (!inWh || inWh.has(s))).length;
      period.reorderRule = 'ims';
    }

    res.json({
      rows: grouping ? outRows.slice(0, ROW_LIMIT) : outRows,
      totals, lastSync, lastOk, counts, soldDays, mtd, period,
      warehouses: allWh.map(w => ({ warehouse: w.warehouse, units: Number(w.units) || 0, skus: Number(w.skus) || 0 })),
      warehouse: wh === NONE ? NONE : (known ? wh : ''),
      noWarehouse: noWh.length,
      brand,
      groupBy: grouping || 'sku',
      view,
      truncated: scanCutShort || (reorder || view
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
  // Uniware allows 10,000 SKUs per call, against Vin eRetail's 20. The cap here
  // is about keeping one request quick, not about the API.
  const skus = [...new Set(asked)].slice(0, 200);
  if (!skus.length) return res.status(400).json({ error: 'No SKUs to check' });
  if (!uni.isConfigured()) return res.status(400).json({ error: 'Unicommerce is not configured on this server' });

  // Facilities come from the snapshot rather than the API: it is a local read,
  // and it asks about exactly the warehouses this page already shows.
  const facilities = (await db.rows('SELECT DISTINCT facility FROM uni_inventory'))
    .map(r => r.facility).filter(Boolean);
  if (!facilities.length) return res.status(400).json({ error: 'No facilities synced yet' });

  const rows = [];
  try {
    for (const facility of facilities) {
      const r = await uni.uniCall('INVENTORY_SNAPSHOT', { itemTypeSKUs: skus }, { facility });
      // 60004 means no SKU in this batch has stock at this facility — an
      // answer, not a failure. See unicommerce-sync.js for the full note.
      const empty = (r.errors || []).some(e => Number(e.code) === 60004);
      if (!r.successful && !empty) {
        return res.status(502).json({ error: 'Unicommerce: ' + (uni.explain(r) || 'call failed') });
      }
      for (const s of (empty ? [] : (r.json && r.json.inventorySnapshots) || [])) {
        rows.push({ sku: s.itemTypeSKU, warehouse: facility, qty: Number(s.inventory) || 0 });
      }
    }
  } catch (e) {
    return res.status(502).json({ error: 'Unicommerce: ' + (e.message || 'call failed') });
  }

  // Push live values into the snapshot so the table reflects them.
  if (rows.length) {
    await db.rows(
      `INSERT INTO uni_inventory (sku, facility, inventory) VALUES ?
       ON DUPLICATE KEY UPDATE inventory = VALUES(inventory), synced_at = CURRENT_TIMESTAMP`,
      [rows.map(r => [r.sku, r.warehouse, r.qty])]);
  }

  // A checked SKU absent from the response is out of stock now. Zero only the
  // (sku, facility) rows we already track — don't invent new warehouse rows.
  const seen = new Set(rows.map(r => r.sku + '|' + r.warehouse));
  const existing = await db.rows(
    `SELECT sku, facility FROM uni_inventory WHERE sku IN (${skus.map(() => '?').join(',')})`, skus);
  const stale = existing.filter(e => !seen.has(e.sku + '|' + e.facility));
  if (stale.length) {
    await db.rows(
      `UPDATE uni_inventory SET inventory = 0, synced_at = CURRENT_TIMESTAMP
        WHERE (sku, facility) IN (${stale.map(() => '(?,?)').join(',')})`,
      stale.flatMap(e => [e.sku, e.facility]));
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
// work at all. So: kick it off, say it started, let the page watch ims_sync_log.
router.post('/stock/sync', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const sync = require('../../unicommerce-sync');
  await sync.ensureTables();
  const running = await sync.runInProgress();
  if (running) {
    const mins = Math.round((Date.now() - new Date(running.started_at).getTime()) / 60000);
    return res.status(409).json({
      alreadyRunning: true, startedMinutesAgo: mins,
      error: `A stock sync is already running (started ${mins} min ago). It will finish on its own.`,
    });
  }

  // Detached on purpose. Errors are recorded in ims_sync_log by the job itself,
  // so this catch only prevents an unhandled rejection.
  runUnicommerceSync().catch(e => console.error('  ❌ background stock sync:', e.message));
  res.json({ started: true });
}));

// Cron entry point, for Vercel. Shared-secret auth — cron has no session.
router.get('/cron/vinculum-sync', requireCronSecret, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await runUnicommerceSync()) });
}));

module.exports = router;
