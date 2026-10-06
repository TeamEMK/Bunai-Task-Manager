// ════════════════════════════════════════════════════════════════════════
//  unicommerce-sync.js — Uniware ka SKU master aur stock MySQL mein.
//
//    node backend/unicommerce-sync.js items     SKU master (uni_items)
//    node backend/unicommerce-sync.js stock     har facility ka stock
//    node backend/unicommerce-sync.js all       dono, sahi kram mein
//    node backend/unicommerce-sync.js status    abhi tables mein kya hai
//
//  KRAM MAAYNE RAKHTA HAI: stock se pehle items. inventorySnapshot enumerate
//  nahi karta — aap SKU batao, woh quantity deta hai. SKU list uni_items se
//  aati hai. Vinculum mein yahi list CSV export se aati thi aur naya SKU
//  banne par chupchaap purani ho jaati thi; ab API khud deti hai, to woh
//  dikkat khatam.
//
//  FACILITY KHUD DHOONDTE HAIN: facility/search se codes lete hain, .env se
//  nahi. Naya warehouse khulega to woh apne aap sync mein aa jayega.
//
//  DIN-BA-DIN HISTORY PEHLE DIN SE: uni_inventory par sirf aaj ka haal rehta
//  hai (har run overwrite), aur uni_inventory_daily har din ka snapshot alag
//  rakhti hai. Yeh Vinculum wali galti ka seedha jawab hai — wahan history
//  table der se judi aur jab stock zero hua to yeh bataane ko kuch nahi tha
//  ki woh kab aur kaise hua.
// ════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');
const uni = require(path.join(__dirname, 'unicommerce'));

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: String(process.env.DB_SSL) === 'true' ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  connectionLimit: 4,
});

// itemType/search 2000 par bhi theek jawab deta hai; 1000 par rakha hai taaki
// ek page fail ho to dobara kam kaam ho.
const ITEM_PAGE = Number(process.env.UNI_ITEM_PAGE || 1000);

// inventorySnapshot ek call mein 10,000 SKU tak leta hai (Vinculum 20 leta
// tha). 5,000 par rakha hai — poora catalogue do call mein nipat jaata hai
// aur limit ke kinare par nahi chalte.
const SKU_BATCH = Number(process.env.UNI_SKU_BATCH || 5000);

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_items (
      sku            VARCHAR(120) NOT NULL PRIMARY KEY,
      name           VARCHAR(500) NULL,
      category_code  VARCHAR(120) NULL,
      category_name  VARCHAR(255) NULL,
      brand          VARCHAR(120) NULL,
      color          VARCHAR(120) NULL,
      size           VARCHAR(60)  NULL,
      price          DECIMAL(12,2) NULL,
      base_price     DECIMAL(12,2) NULL,
      hsn_code       VARCHAR(40)  NULL,
      gst_tax_type   VARCHAR(40)  NULL,
      ean            VARCHAR(80)  NULL,
      weight         DECIMAL(12,3) NULL,
      enabled        TINYINT(1) NOT NULL DEFAULT 1,
      synced_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_uni_items_cat (category_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Ek row per (sku, facility) — abhi ka haal. inventory = bikne layak stock;
  // baaki buckets isliye rakhe hain ki "stock hai par bik nahi raha" wale
  // sawaal ka jawab mil sake. Jo buckets hamesha 0 rehte hain woh chhod diye.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_inventory (
      sku            VARCHAR(120) NOT NULL,
      facility       VARCHAR(80)  NOT NULL,
      inventory      INT NOT NULL DEFAULT 0,
      open_sale      INT NOT NULL DEFAULT 0,
      open_purchase  INT NOT NULL DEFAULT 0,
      blocked        INT NOT NULL DEFAULT 0,
      bad_inventory  INT NOT NULL DEFAULT 0,
      putaway_pending INT NOT NULL DEFAULT 0,
      pending_transfer INT NOT NULL DEFAULT 0,
      synced_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (sku, facility),
      KEY idx_uni_inv_qty (inventory),
      KEY idx_uni_inv_fac (facility)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Pehle din se. Ek row per (din, sku, facility) — dobara chalane par us din
  // ka aankda sudhar jaata hai, nayi row nahi banti.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_inventory_daily (
      day        DATE NOT NULL,
      sku        VARCHAR(120) NOT NULL,
      facility   VARCHAR(80)  NOT NULL,
      inventory  INT NOT NULL DEFAULT 0,
      PRIMARY KEY (day, sku, facility),
      KEY idx_uni_invd_day (day)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_sync_log (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      kind       VARCHAR(30) NOT NULL,
      started_at DATETIME NOT NULL,
      ended_at   DATETIME NULL,
      rows_seen  INT NOT NULL DEFAULT 0,
      ok         TINYINT(1) NOT NULL DEFAULT 0,
      error      TEXT NULL,
      KEY idx_uni_log_kind (kind, started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

const log = m => console.log(m);
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const int = v => Math.round(Number(v) || 0);

async function startRun(kind) {
  const [r] = await pool.query(
    'INSERT INTO uni_sync_log (kind, started_at) VALUES (?, NOW())', [kind]);
  return r.insertId;
}
async function endRun(id, ok, rows, error) {
  await pool.query(
    'UPDATE uni_sync_log SET ended_at = NOW(), ok = ?, rows_seen = ?, error = ? WHERE id = ?',
    [ok ? 1 : 0, rows || 0, error ? String(error).slice(0, 2000) : null, id]);
}

// ── Facilities ───────────────────────────────────────────────────────────
async function facilityCodes() {
  const r = await uni.uniCall('FACILITY_SEARCH', {
    facilityStatus: 'ENABLED',
    fromDate: new Date(Date.now() - 5 * 365 * 86400000).toISOString(),
    toDate: new Date().toISOString(),
    dateType: 'CREATED',
  });
  if (!r.successful) throw new Error('facility/search failed: ' + (uni.explain(r) || r.status));
  return ((r.json && r.json.parties) || []).map(p => p.facilityCode).filter(Boolean);
}

// ── SKU master ───────────────────────────────────────────────────────────
async function syncItems() {
  const runId = await startRun('items');
  try {
    let start = 0, total = null, stored = 0;

    do {
      const r = await uni.uniCall('ITEM_SEARCH', {
        searchOptions: { displayStart: start, displayLength: ITEM_PAGE, getCount: true },
      });
      if (!r.successful) throw new Error('itemType/search failed: ' + (uni.explain(r) || r.status));

      const els = (r.json && r.json.elements) || [];
      if (total === null) total = Number(r.json.totalRecords) || els.length;
      if (!els.length) break;

      const rows = els.map(e => [
        e.skuCode, uni.fixBrand(e.name) || null, e.categoryCode || null, e.categoryName || null,
        e.brand || null, e.color || null, e.size || null,
        num(e.price), num(e.basePrice), e.hsnCode || null, e.gstTaxTypeCode || null,
        e.ean || null, num(e.weight), e.enabled === false ? 0 : 1,
      ]);

      await pool.query(
        `INSERT INTO uni_items
           (sku, name, category_code, category_name, brand, color, size,
            price, base_price, hsn_code, gst_tax_type, ean, weight, enabled)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           name = VALUES(name), category_code = VALUES(category_code),
           category_name = VALUES(category_name), brand = VALUES(brand),
           color = VALUES(color), size = VALUES(size), price = VALUES(price),
           base_price = VALUES(base_price), hsn_code = VALUES(hsn_code),
           gst_tax_type = VALUES(gst_tax_type), ean = VALUES(ean),
           weight = VALUES(weight), enabled = VALUES(enabled),
           synced_at = CURRENT_TIMESTAMP`,
        [rows]);

      stored += rows.length;
      start += els.length;
      log(`  items ${stored}/${total}`);
      if (els.length < ITEM_PAGE) break;
    } while (start < total);

    await endRun(runId, true, stored);
    return { items: stored };
  } catch (e) {
    await endRun(runId, false, 0, e.message);
    throw e;
  }
}

// ── Stock ────────────────────────────────────────────────────────────────
// SKU list uni_items se. Ek SKU jiska stock kisi facility par nahi hai, woh
// response se gayab rehta hai (Vinculum jaisa hi) — isliye run ke baad woh
// rows zero kar dete hain jo is baar dikhi hi nahi. Warna bika hua SKU apni
// purani quantity dikhata rehta, jo sabse khatarnak kism ki galti hai:
// dekhne mein taaza lagti hai.
async function syncStock() {
  const runId = await startRun('stock');
  // Ghadi DATABASE ki, Node ki nahi. synced_at MySQL apne CURRENT_TIMESTAMP se
  // likhta hai, aur neeche ka "jo dikha nahi use zero karo" us hi se tulna
  // karta hai. Production ka MySQL UTC par chalta hai jabki yeh process IST
  // par — to JS ka new Date() saadhe paanch ghante aage hota hai, har row
  // "purani" lagti hai, aur POORA stock zero ho jaata hai. Dev par ghadiyan
  // milti thi isliye yeh chhupa raha; prod par pehli hi run mein 61,030 units
  // mit gaye.
  const [[{ started }]] = await pool.query('SELECT NOW() AS started');
  try {
    const [skuRows] = await pool.query('SELECT sku FROM uni_items WHERE enabled = 1 ORDER BY sku');
    const skus = skuRows.map(r => r.sku);
    if (!skus.length) {
      throw new Error('uni_items khaali hai — pehle chalao: node backend/unicommerce-sync.js items');
    }

    const facilities = await facilityCodes();
    log(`  ${skus.length} SKUs × ${facilities.length} facility (${facilities.join(', ')})`);

    let seen = 0;
    for (const facility of facilities) {
      for (let i = 0; i < skus.length; i += SKU_BATCH) {
        const batch = skus.slice(i, i + SKU_BATCH);
        const r = await uni.uniCall('INVENTORY_SNAPSHOT',
          { itemTypeSKUs: batch }, { facility });

        // 60004 INVENTORY_NOT_AVAILABLE ka matlab failure nahi hai — iska
        // matlab hai ki is batch ke KISI bhi SKU ka is facility par stock
        // nahi hai. Uniware tab khaali success dene ke bajaye error deta hai.
        // (Vin eRetail bhi yahi karta tha, code 9189 ke saath.) Ek facility
        // par aadha catalogue na hona bilkul normal hai, isliye isko
        // "khaali batch" maankar aage badhte hain.
        const notAvailable = (r.errors || []).some(e => Number(e.code) === 60004);
        if (!r.successful && !notAvailable) {
          throw new Error(`inventorySnapshot (${facility}) failed: ` + (uni.explain(r) || r.status));
        }

        const snaps = notAvailable ? [] : ((r.json && r.json.inventorySnapshots) || []);
        if (snaps.length) {
          const rows = snaps.map(s => [
            s.itemTypeSKU, facility, int(s.inventory), int(s.openSale),
            int(s.openPurchase), int(s.inventoryBlocked), int(s.badInventory),
            int(s.putawayPending), int(s.pendingStockTransfer),
          ]);
          await pool.query(
            `INSERT INTO uni_inventory
               (sku, facility, inventory, open_sale, open_purchase, blocked,
                bad_inventory, putaway_pending, pending_transfer)
             VALUES ?
             ON DUPLICATE KEY UPDATE
               inventory = VALUES(inventory), open_sale = VALUES(open_sale),
               open_purchase = VALUES(open_purchase), blocked = VALUES(blocked),
               bad_inventory = VALUES(bad_inventory),
               putaway_pending = VALUES(putaway_pending),
               pending_transfer = VALUES(pending_transfer),
               synced_at = CURRENT_TIMESTAMP`,
            [rows]);
          seen += rows.length;
        }
        log(`  ${facility}: ${Math.min(i + SKU_BATCH, skus.length)}/${skus.length} poochhe, ${seen} rows`);
      }
    }

    // Jo is run mein nahi dikhe — unka stock ab zero hai.
    const [zeroed] = await pool.query(
      `UPDATE uni_inventory SET inventory = 0, synced_at = CURRENT_TIMESTAMP
        WHERE inventory > 0 AND synced_at < ?`, [started]);

    // Aaj ka snapshot history mein.
    await pool.query(
      `INSERT INTO uni_inventory_daily (day, sku, facility, inventory)
       SELECT CURDATE(), sku, facility, inventory FROM uni_inventory
       ON DUPLICATE KEY UPDATE inventory = VALUES(inventory)`);

    await endRun(runId, true, seen);
    return { rows: seen, zeroed: zeroed.affectedRows, facilities: facilities.length };
  } catch (e) {
    await endRun(runId, false, 0, e.message);
    throw e;
  }
}

// Ek sync chalte hue doosra shuru karna nuksaandeh hai — dono ek hi catalogue
// par likhte hain aur "jo dikha nahi use zero karo" wala kadam ek-doosre ka
// kaam ulat sakta hai. Log table hi record hai ki kya chal raha hai, to wahi
// lock ka kaam bhi karti hai. STALE_RUN_MS iski hadd hai: beech mein mara hua
// process ended_at hamesha NULL chhod jaata, aur bina cutoff ke woh har agle
// sync ko rok deta.
const STALE_RUN_MS = Number(process.env.UNI_STALE_RUN_MS || 30 * 60 * 1000);

async function runInProgress(kind = 'stock') {
  const [[row]] = await pool.query(
    `SELECT id, started_at FROM uni_sync_log
      WHERE kind = ? AND ended_at IS NULL
        AND started_at > (NOW() - INTERVAL ? SECOND)
      ORDER BY id DESC LIMIT 1`, [kind, Math.round(STALE_RUN_MS / 1000)]);
  return row || null;
}

// ── Reorder → tasks ──────────────────────────────────────────────────────
// Turns stock into work for whoever owns reordering.
//
// THE RULE IS NOT A FLAT THRESHOLD. "qty <= 5" flags a SKU nobody has bought
// in months and stays quiet about one that sold twelve and has two left. What
// matters is whether demand is outrunning stock, so a SKU qualifies when it
// sold MORE in the window than it currently holds. That is the same rule the
// Stock page's reorder view already uses — one definition, not two.
//
// Stock is summed across facilities before the comparison. Sales are not split
// by facility, so comparing one warehouse's shelf against the whole country's
// demand would flag the same SKU once per warehouse and overstate both.
//
// uni_stock_alerts is what stops the same SKU raising a task every morning for
// weeks. One row per SKU holding the task already raised; a second task only
// comes after the SKU recovers and falls behind again, which is a genuinely
// new event rather than the same one restated.
async function ensureAlertTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_stock_alerts (
      sku           VARCHAR(120) NOT NULL PRIMARY KEY,
      task_id       INT NULL,
      qty_at_alert  INT NOT NULL DEFAULT 0,
      sold_at_alert INT NOT NULL DEFAULT 0,
      raised_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cleared_at    DATETIME NULL,
      KEY idx_uni_alert_open (cleared_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

const REORDER_DAYS  = Number(process.env.REORDER_DAYS  || 45);
const REORDER_MAX   = Number(process.env.REORDER_MAX   || process.env.VIN_LOW_STOCK_MAX || 25);
const REORDER_ASSIGN = process.env.REORDER_ASSIGN_TO || process.env.VIN_LOW_STOCK_ASSIGN_TO || '';

async function raiseReorderTasks({
  assignTo = Number(REORDER_ASSIGN) || 0,
  assignedBy = null,
  soldDays = REORDER_DAYS,
  dueInDays = 3,
  limit = REORDER_MAX,
  log = console.log,
} = {}) {
  if (!assignTo) return { skipped: 'no assignee (REORDER_ASSIGN_TO)' };
  await ensureAlertTable();

  // Same guard the stock sweep carries: a catalogue reading zero everywhere is
  // a broken feed, not a warehouse that sold out, and acting on it would hand
  // someone every SKU at once.
  const [[stocked]] = await pool.query('SELECT COUNT(*) AS n FROM uni_inventory WHERE inventory > 0');
  if (!stocked.n) {
    log('  stock feed reads zero everywhere — raising nothing');
    return { raised: 0, recovered: 0, skipped: 'empty-feed' };
  }

  const days = Math.max(1, Math.min(365, Number(soldDays) || 45));

  // Demand vs stock, per SKU, over the window.
  const [rows] = await pool.query(
    `SELECT i.sku, i.qty, s.sold, COALESCE(NULLIF(it.name,''), i.sku) AS name
       FROM (SELECT sku, SUM(inventory) qty FROM uni_inventory GROUP BY sku) i
       JOIN (SELECT oi.sku, SUM(oi.order_qty) sold
               FROM ims_order_items oi JOIN ims_orders o ON o.order_id = oi.order_id
              WHERE LOWER(oi.status) <> 'cancelled'
                AND o.order_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
              GROUP BY oi.sku) s ON s.sku = i.sku
       LEFT JOIN uni_items it ON it.sku = i.sku
      WHERE s.sold > i.qty
      ORDER BY (s.sold - i.qty) DESC`, [days]);

  // Recovered: an open alert whose SKU is no longer behind. Clearing it is what
  // lets a future dip alert again.
  const behind = new Set(rows.map(r => r.sku));
  const [open] = await pool.query('SELECT sku FROM uni_stock_alerts WHERE cleared_at IS NULL');
  const recoveredSkus = open.map(r => r.sku).filter(s => !behind.has(s));
  if (recoveredSkus.length) {
    await pool.query(
      `UPDATE uni_stock_alerts SET cleared_at = NOW()
        WHERE cleared_at IS NULL AND sku IN (${recoveredSkus.map(() => '?').join(',')})`,
      recoveredSkus);
  }

  const openSet = new Set(open.map(r => r.sku));
  const fresh = rows.filter(r => !openSet.has(r.sku)).slice(0, limit);

  if (!fresh.length) {
    log(`  no new reorder SKUs (${rows.length} behind, all already raised)` +
        (recoveredSkus.length ? `, ${recoveredSkus.length} recovered` : ''));
    return { raised: 0, recovered: recoveredSkus.length, behind: rows.length };
  }

  const due = new Date(Date.now() + dueInDays * 86400000).toISOString().slice(0, 10);
  let raised = 0;

  for (const r of fresh) {
    const qty = Number(r.qty) || 0, sold = Number(r.sold) || 0;
    const desc = qty <= 0
      ? `Out of stock — ${r.name} (${r.sku}): ${sold} sold in ${days} days, none left`
      : `Reorder — ${r.name} (${r.sku}): ${sold} sold in ${days} days, ${qty} left`;

    const [ins] = await pool.query(
      `INSERT INTO delegation_tasks
         (description, assigned_to, assigned_by, due_date, status, priority,
          approval, waiting_approval, approver_id, remarks, client_id, url)
       VALUES (?,?,?,?,'pending',?, 'no', 0, NULL, ?, NULL, NULL)`,
      [desc, assignTo, assignedBy || assignTo, due,
       qty <= 0 ? 'high' : 'medium',
       'Raised automatically from the Unicommerce stock sync.']);

    await pool.query(
      `INSERT INTO uni_stock_alerts (sku, task_id, qty_at_alert, sold_at_alert)
       VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE task_id = VALUES(task_id), qty_at_alert = VALUES(qty_at_alert),
                               sold_at_alert = VALUES(sold_at_alert),
                               raised_at = CURRENT_TIMESTAMP, cleared_at = NULL`,
      [r.sku, ins.insertId, qty, sold]);
    raised++;
  }

  log(`  raised ${raised} reorder task(s) of ${rows.length} behind` +
      (recoveredSkus.length ? `, ${recoveredSkus.length} recovered` : '') +
      (rows.length > limit + openSet.size ? ` — capped at ${limit}/run` : ''));
  return { raised, recovered: recoveredSkus.length, behind: rows.length };
}

async function status() {
  const [[items]] = await pool.query('SELECT COUNT(*) n FROM uni_items');
  const [byFac] = await pool.query(
    `SELECT facility, COUNT(*) skus, SUM(inventory) units
       FROM uni_inventory WHERE inventory > 0 GROUP BY facility ORDER BY facility`);
  const [[days]] = await pool.query('SELECT COUNT(DISTINCT day) n FROM uni_inventory_daily');
  const [last] = await pool.query(
    `SELECT kind, started_at, ended_at, rows_seen, ok, LEFT(COALESCE(error,''),120) err
       FROM uni_sync_log ORDER BY id DESC LIMIT 4`);
  return { items: items.n, byFacility: byFac, historyDays: days.n, recent: last };
}

module.exports = { pool, ensureTables, ensureAlertTable, facilityCodes, syncItems, syncStock, runInProgress, raiseReorderTasks, status };

// ── CLI ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const gaps = uni.missingConfig();
    if (gaps.length) throw new Error('Unicommerce configured nahi — .env mein chahiye: ' + gaps.join(', '));

    const cmd = process.argv[2];
    await ensureTables();

    if (cmd === 'items') {
      const r = await syncItems();
      console.log(`\nDone — ${r.items} SKUs`);

    } else if (cmd === 'stock') {
      const r = await syncStock();
      console.log(`\nDone — ${r.rows} stock rows across ${r.facilities} facility` +
                  (r.zeroed ? `, ${r.zeroed} zero kiye` : ''));

    } else if (cmd === 'all') {
      const a = await syncItems();
      console.log(`  ${a.items} SKUs\n`);
      const b = await syncStock();
      console.log(`\nDone — ${a.items} SKUs, ${b.rows} stock rows` +
                  (b.zeroed ? `, ${b.zeroed} zero kiye` : ''));

    } else if (cmd === 'reorder') {
      // node backend/unicommerce-sync.js reorder <userId> [days]
      const userId = Number(process.argv[3]);
      if (!userId) throw new Error('Usage: node backend/unicommerce-sync.js reorder <userId> [days]');
      const soldDays = process.argv[4] ? Number(process.argv[4]) : undefined;
      const r = await raiseReorderTasks({ assignTo: userId, ...(soldDays ? { soldDays } : {}) });
      console.log(`
Done — ${r.raised || 0} task(s) raised, ${r.recovered || 0} cleared` +
                  (r.skipped ? ` (skipped: ${r.skipped})` : ''));

    } else if (cmd === 'status') {
      const s = await status();
      console.log(`SKUs        : ${s.items}`);
      for (const f of s.byFacility) {
        console.log(`  ${String(f.facility).padEnd(16)} ${String(f.skus).padStart(6)} SKUs   ` +
                    `${Number(f.units).toLocaleString('en-IN')} units`);
      }
      console.log(`History days: ${s.historyDays}`);
      console.log('Recent runs :');
      s.recent.forEach(r => console.log(`  ${r.kind.padEnd(7)} ${String(r.started_at).slice(4, 24)} ` +
        `rows=${r.rows_seen} ok=${r.ok} ${r.err}`));

    } else {
      console.log('Usage: node backend/unicommerce-sync.js [items | stock | all | reorder <userId> [days] | status]');
    }
    await pool.end();
  })().catch(e => { console.error('\n✗', e.message); process.exit(1); });
}
