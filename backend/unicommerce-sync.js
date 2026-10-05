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
        e.skuCode, e.name || null, e.categoryCode || null, e.categoryName || null,
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
  const started = new Date();
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

module.exports = { pool, ensureTables, facilityCodes, syncItems, syncStock, runInProgress, status };

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
      console.log('Usage: node backend/unicommerce-sync.js [items | stock | all | status]');
    }
    await pool.end();
  })().catch(e => { console.error('\n✗', e.message); process.exit(1); });
}
