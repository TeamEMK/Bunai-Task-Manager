// ════════════════════════════════════════════════════════════════════════
//  vinculum-sync.js — pulls Vin eRetail stock into MySQL on a schedule.
//
//  Run from the repo root:
//    node backend/vinculum-sync.js seed data/vin-skus.csv   load the SKU list
//    node backend/vinculum-sync.js sync                     refresh every SKU
//    node backend/vinculum-sync.js status                   what is in the tables
//
//  WHY A SEEDED SKU LIST: the live-inventory endpoint will not enumerate.
//  It answers "here is the stock for the SKUs you named" and nothing else, so
//  something has to hold the list of SKUs to ask about. The SKU master API
//  would supply it, but that endpoint is still blocked on VIN_ORG_ID — so
//  until that arrives the list is seeded from an Inventory View export
//  (WMS → Inventory → Inventory View → Search → Export).
//
//  Consequence worth stating plainly: a SKU created in Vin eRetail after the
//  last seed is invisible here until someone re-seeds or the org id unblocks
//  the master. Stock levels for known SKUs stay current either way.
// ════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const mysql = require('mysql2/promise');
const vin = require('./vinculum');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 4,
});

// ── Schema ───────────────────────────────────────────────────────────────
// Created on demand so there is no separate migration step to forget.
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vin_skus (
      sku         VARCHAR(120) NOT NULL PRIMARY KEY,
      description VARCHAR(255) NULL,
      is_active   TINYINT(1) NOT NULL DEFAULT 1,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // One row per (sku, warehouse). synced_at moves on every run even when the
  // quantity does not, which is what separates "still zero" from "stale".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vin_inventory (
      sku       VARCHAR(120) NOT NULL,
      warehouse VARCHAR(40)  NOT NULL,
      qty       DECIMAL(12,3) NOT NULL DEFAULT 0,
      synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (sku, warehouse),
      KEY idx_vin_inv_qty (qty),
      KEY idx_vin_inv_wh (warehouse)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vin_sync_log (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      kind       VARCHAR(30) NOT NULL,
      started_at DATETIME NOT NULL,
      ended_at   DATETIME NULL,
      rows_seen  INT NOT NULL DEFAULT 0,
      ok         TINYINT(1) NOT NULL DEFAULT 0,
      error      TEXT NULL,
      KEY idx_vin_log_kind (kind, started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// ── Seeding ──────────────────────────────────────────────────────────────
// Parses the Inventory View export. Quoted fields with embedded commas are
// common in the descriptions ("Kaftan Set (set of 2)"), so this walks the line
// rather than splitting on commas.
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function seedFromCsv(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // Excel's BOM

  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const header = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const skuAt  = header.findIndex(h => h === 'sku' || h === 'sku code');
  const descAt = header.findIndex(h => h.includes('desc'));
  if (skuAt < 0) throw new Error(`No "SKU" column in ${file}. Found: ${header.join(', ')}`);

  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const sku = (cols[skuAt] || '').trim();
    if (sku) rows.push([sku, descAt >= 0 ? (cols[descAt] || '').trim() : null]);
  }
  if (!rows.length) throw new Error(`No SKU rows found in ${file}`);

  for (let i = 0; i < rows.length; i += 500) {
    await pool.query(
      `INSERT INTO vin_skus (sku, description) VALUES ?
       ON DUPLICATE KEY UPDATE description = VALUES(description), is_active = 1`,
      [rows.slice(i, i + 500)]);
  }
  return rows.length;
}

// ── Sync ─────────────────────────────────────────────────────────────────
// A second sync started while one is running is actively harmful, not just
// wasteful: both draw on the same 40-call quota, so each keeps knocking the
// other into its 60-second back-off and neither finishes. The log table is
// already the record of what is in flight, so it doubles as the lock.
// STALE_RUN_MS bounds it — a process killed mid-run leaves ended_at NULL
// forever, and without a cutoff that would block every future sync.
const STALE_RUN_MS = Number(process.env.VIN_STALE_RUN_MS || 30 * 60 * 1000);

async function runInProgress() {
  const [[row]] = await pool.query(
    `SELECT id, started_at FROM vin_sync_log
      WHERE kind = 'inventory' AND ended_at IS NULL
        AND started_at > (NOW() - INTERVAL ? SECOND)
      ORDER BY id DESC LIMIT 1`, [Math.round(STALE_RUN_MS / 1000)]);
  return row || null;
}

async function syncInventory({ log = console.log, force = false } = {}) {
  if (!force) {
    const running = await runInProgress();
    if (running) {
      const mins = Math.round((Date.now() - new Date(running.started_at).getTime()) / 60000);
      const e = new Error(`A stock sync is already running (started ${mins} min ago). It will finish on its own.`);
      e.alreadyRunning = true;
      throw e;
    }
  }

  // Run-start comes from the DB clock, not the client's. A machine in a
  // different timezone than the DB (e.g. an IST laptop syncing a UTC Railway
  // MySQL) would otherwise make every freshly-inserted row look "stale" to the
  // zeroing step below (synced_at < started) and wipe the whole table to zero.
  const [[{ started }]] = await pool.query('SELECT NOW() AS started');
  const [res] = await pool.query(
    'INSERT INTO vin_sync_log (kind, started_at) VALUES (?, ?)', ['inventory', started]);
  const runId = res.insertId;

  try {
    const [skuRows] = await pool.query('SELECT sku FROM vin_skus WHERE is_active = 1 ORDER BY sku');
    const skus = skuRows.map(r => r.sku);
    if (!skus.length) throw new Error('vin_skus is empty — run: node backend/vinculum-sync.js seed data/vin-skus.csv');

    log(`  ${skus.length} SKUs to check across ${vin.WAREHOUSES.join(', ')}`);

    // Persisted batch by batch rather than in one write at the end. The API
    // quota can stall a run mid-way; when it does, everything already fetched
    // is safely in the table instead of being thrown away.
    const rows = await vin.fetchInventoryAll(skus, {
      onBatch: async batch => {
        if (!batch.length) return;
        await pool.query(
          `INSERT INTO vin_inventory (sku, warehouse, qty) VALUES ?
           ON DUPLICATE KEY UPDATE qty = VALUES(qty), synced_at = CURRENT_TIMESTAMP`,
          [batch.map(r => [r.sku, r.warehouse, r.qty])]);
      },
      onProgress: (done, total, found, note) =>
        log(`  ${done}/${total} checked, ${found} stock rows${note ? ' — ' + note : ''}`),
    });

    // A SKU that sold out is absent from the response, not returned as zero.
    // Without this it would keep showing its last known quantity forever —
    // the worst kind of wrong, because it looks fresh.
    const [zeroed] = await pool.query(
      `UPDATE vin_inventory SET qty = 0, synced_at = CURRENT_TIMESTAMP
        WHERE qty > 0 AND synced_at < ?`, [started]);

    await pool.query(
      'UPDATE vin_sync_log SET ended_at = NOW(), rows_seen = ?, ok = 1 WHERE id = ?',
      [rows.length, runId]);

    return { skus: skus.length, rows: rows.length, zeroed: zeroed.affectedRows };
  } catch (e) {
    await pool.query(
      'UPDATE vin_sync_log SET ended_at = NOW(), ok = 0, error = ? WHERE id = ?',
      [String(e.message).slice(0, 2000), runId]);
    throw e;
  }
}

// ── Low stock → tasks ────────────────────────────────────────────────────
// Turns stock into work. A SKU at or below its reorder level raises a task for
// whoever owns reordering.
//
// The whole design problem here is repetition: a SKU sits below its threshold
// for weeks, and a naive rule would raise the same task every single run until
// the doer drowns. vin_stock_alerts is the memory that prevents that — one row
// per (sku, warehouse), holding the task it already raised. A second task is
// only raised after the SKU has recovered above the threshold and fallen back
// under it, which is a genuinely new event.
async function ensureAlertTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vin_stock_alerts (
      sku        VARCHAR(120) NOT NULL,
      warehouse  VARCHAR(40)  NOT NULL,
      task_id    INT NULL,
      qty_at_alert DECIMAL(12,3) NOT NULL DEFAULT 0,
      raised_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cleared_at DATETIME NULL,
      PRIMARY KEY (sku, warehouse)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// threshold  — qty at or below this counts as low
// assignTo   — user id the tasks go to
// assignedBy — user id recorded as the assigner (defaults to assignTo)
// dueInDays  — how long they get
// limit      — safety cap, so a misconfigured threshold cannot raise hundreds
//              of tasks in one run
async function raiseLowStockTasks({
  threshold = Number(process.env.VIN_LOW_STOCK_QTY || 5),
  assignTo,
  assignedBy = null,
  dueInDays = 2,
  limit = Number(process.env.VIN_LOW_STOCK_MAX || 25),
  log = console.log,
} = {}) {
  if (!assignTo) throw new Error('raiseLowStockTasks needs assignTo (a user id)');
  await ensureAlertTable();

  // Clear alerts whose SKU has recovered, so a future dip can alert again.
  const [recovered] = await pool.query(
    `UPDATE vin_stock_alerts a
       JOIN vin_inventory i ON i.sku = a.sku AND i.warehouse = a.warehouse
        SET a.cleared_at = NOW()
      WHERE a.cleared_at IS NULL AND i.qty > ?`, [threshold]);

  // Low right now, and not already sitting on an open alert.
  const [low] = await pool.query(
    `SELECT i.sku, i.warehouse, i.qty, COALESCE(s.description, i.sku) AS description
       FROM vin_inventory i
       LEFT JOIN vin_skus s ON s.sku = i.sku
       LEFT JOIN vin_stock_alerts a
              ON a.sku = i.sku AND a.warehouse = i.warehouse AND a.cleared_at IS NULL
      WHERE i.qty <= ? AND a.sku IS NULL
      ORDER BY i.qty ASC, i.sku ASC
      LIMIT ?`, [threshold, limit]);

  if (!low.length) {
    log(`  no new low-stock SKUs at or below ${threshold}` +
        (recovered.affectedRows ? ` (${recovered.affectedRows} recovered)` : ''));
    return { raised: 0, recovered: recovered.affectedRows };
  }

  const due = new Date(Date.now() + dueInDays * 86400000).toISOString().slice(0, 10);
  let raised = 0;

  for (const r of low) {
    const qty = Number(r.qty);
    const desc = qty <= 0
      ? `Out of stock — ${r.description} (${r.sku}) at ${r.warehouse}`
      : `Low stock — ${r.description} (${r.sku}) at ${r.warehouse}: ${qty} left`;

    const [ins] = await pool.query(
      `INSERT INTO delegation_tasks
         (description, assigned_to, assigned_by, due_date, status, priority,
          approval, waiting_approval, approver_id, remarks, client_id, url)
       VALUES (?,?,?,?,'pending',?, 'no', 0, NULL, ?, NULL, NULL)`,
      [desc, assignTo, assignedBy || assignTo, due,
       qty <= 0 ? 'high' : 'medium',
       'Raised automatically from the Vinculum stock sync.']);

    await pool.query(
      `INSERT INTO vin_stock_alerts (sku, warehouse, task_id, qty_at_alert)
       VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE task_id = VALUES(task_id), qty_at_alert = VALUES(qty_at_alert),
                               raised_at = CURRENT_TIMESTAMP, cleared_at = NULL`,
      [r.sku, r.warehouse, ins.insertId, qty]);
    raised++;
  }

  log(`  raised ${raised} low-stock task(s)` +
      (recovered.affectedRows ? `, ${recovered.affectedRows} recovered` : ''));
  return { raised, recovered: recovered.affectedRows };
}

async function status() {
  const [[skus]] = await pool.query('SELECT COUNT(*) AS n FROM vin_skus WHERE is_active = 1');
  const [byWh] = await pool.query(
    `SELECT warehouse, COUNT(*) AS skus, SUM(qty) AS units
       FROM vin_inventory WHERE qty > 0 GROUP BY warehouse ORDER BY warehouse`);
  const [[last]] = await pool.query(
    `SELECT started_at, ended_at, rows_seen, ok, error
       FROM vin_sync_log WHERE kind = 'inventory' ORDER BY id DESC LIMIT 1`);
  return { skus: skus.n, byWarehouse: byWh, lastRun: last || null };
}

module.exports = { pool, ensureTables, ensureAlertTable, seedFromCsv, syncInventory, runInProgress, raiseLowStockTasks, status };

// ── CLI ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const [cmd, arg] = process.argv.slice(2);
    await ensureTables();

    if (cmd === 'seed') {
      if (!arg) throw new Error('Usage: node backend/vinculum-sync.js seed data/vin-skus.csv');
      console.log(`Seeded ${await seedFromCsv(arg)} SKUs from ${arg}`);

    } else if (cmd === 'sync') {
      const r = await syncInventory();
      console.log(`\nDone — ${r.rows} stock rows across ${r.skus} SKUs` +
                  (r.zeroed ? `, ${r.zeroed} zeroed out` : ''));

    } else if (cmd === 'alerts') {
      // node vinculum-sync.js alerts <userId> [threshold]
      const userId = Number(arg);
      if (!userId) throw new Error('Usage: node vinculum-sync.js alerts <userId> [threshold]');
      const threshold = process.argv[4] !== undefined ? Number(process.argv[4]) : undefined;
      const r = await raiseLowStockTasks({ assignTo: userId, ...(threshold !== undefined ? { threshold } : {}) });
      console.log(`\nDone — ${r.raised} task(s) raised, ${r.recovered} alert(s) cleared`);

    } else if (cmd === 'status') {
      const s = await status();
      console.log(`SKUs tracked : ${s.skus}`);
      for (const w of s.byWarehouse) {
        console.log(`  ${w.warehouse.padEnd(6)} ${String(w.skus).padStart(5)} SKUs   ${Number(w.units).toLocaleString('en-IN')} units`);
      }
      console.log(s.lastRun
        ? `Last sync    : ${s.lastRun.started_at.toISOString().slice(0, 19).replace('T', ' ')} — ${s.lastRun.ok ? 'ok' : 'FAILED: ' + s.lastRun.error}`
        : 'Last sync    : never');

    } else {
      console.log('Usage: node backend/vinculum-sync.js [seed data/vin-skus.csv | sync | alerts <userId> [qty] | status]');
    }
    await pool.end();
  })().catch(e => { console.error('\n✗', e.message); process.exit(1); });
}
