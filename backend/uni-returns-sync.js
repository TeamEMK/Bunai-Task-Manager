// ════════════════════════════════════════════════════════════════════════
//  uni-returns-sync.js — Uniware ke returns (CIR / RTO) MySQL mein.
//
//    node backend/uni-returns-sync.js sync          pichhle 29 din
//    node backend/uni-returns-sync.js sync 29
//    node backend/uni-returns-sync.js status
//
//  ⚠ YEH ABHI TAK ASLI DATA PAR CHALA NAHI HAI.
//  5 October 2026 tak Unicommerce par ek bhi return nahi tha — dono facility,
//  dono returnType, created aur updated, sab par zero. Cutover 1 October ka
//  hai aur returns hamesha orders se kuch din peeche chalte hain, to yeh
//  swabhavik hai.
//
//  Isliye neeche ke saare field names *documentation* se liye gaye hain, kisi
//  dekhi hui response se nahi. Jab pehla return aayega tab inhe milaana hoga.
//  Phir bhi yeh script abhi likhi hai kyunki uska kaam sirf data pakadna hai:
//  jis din pehla return bane, woh us raat ki sync mein aa jaye — warna woh
//  hamesha ke liye chhoot sakta hai.
//
//  DO CALL PER RETURN, orders jaisa hi:
//    return/search  → sirf { code, created, updated }
//    return/get     → poora detail, reversePickupCode ya shipmentCode se
//  Search ka `code` SHIPMENT code hai, reversePickupCode nahi. Yeh pehle hi
//  asli return par pakad mein aa gaya: reversePickupCode bhejne par Uniware
//  90009 INVALID_REVERSE_PICKUP_CODE deta hai, aur RTO mein woh field null
//  hi rehti hai. shipmentCode se detail aa jaata hai.
//
//  returnType MANDATORY hai aur enum sirf CIR aur RTO leta hai (confirmed —
//  COURIER_RETURN/VENDOR_RETURN par enum error aata hai). Date filter
//  createdFrom/createdTo hai, fromDate NAHI, aur 30 din se bada range mana
//  hai.
//
//  RAKAM PAYLOAD MEIN HAI HI NAHI — asli return par ginkar dekh liya: items
//  par sirf GST ke field hain (woh bhi null), koi price nahi. Par har item
//  `saleOrderItemCode` leke aata hai, aur wahi uni_order_items ka primary key
//  hai. Isliye return_amount wahan se jod kar nikala jaata hai. Yeh andaaza
//  nahi hai: woh us order ki asli line value hai jo wapas aa rahi hai.
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

const RETURN_TYPES = ['CIR', 'RTO'];
const WINDOW_MS = Number(process.env.UNI_RETURN_WINDOW_DAYS || 28) * 86400000;
const GET_GAP_MS = Number(process.env.UNI_GET_GAP_MS || 120);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const log = m => console.log(m);
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
// Uniware yahan do shakalein bhejta hai: epoch ms (inventoryReceivedDate,
// returnCompletedDate docs mein number hain) aur "YYYY-MM-DD HH:mm:ss" string.
// Dono ko ek hi tarah se nipta dete hain.
function dt(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' || /^\d+$/.test(String(v)) ? new Date(Number(v)) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
const isoSec = d => new Date(d).toISOString().slice(0, 19);

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_returns (
      code              VARCHAR(120) NOT NULL PRIMARY KEY,
      return_type       VARCHAR(20)  NULL,
      status            VARCHAR(60)  NULL,
      facility          VARCHAR(80)  NULL,
      channel           VARCHAR(80)  NULL,
      order_code        VARCHAR(120) NULL,
      shipment_code     VARCHAR(120) NULL,
      reverse_pickup    VARCHAR(120) NULL,
      challan_no        VARCHAR(120) NULL,
      challan_date      DATETIME NULL,
      return_date       DATETIME NULL,
      channel_return_date DATETIME NULL,
      delivery_date     DATETIME NULL,
      received_date     DATETIME NULL,
      completed_date    DATETIME NULL,
      tracking_number   VARCHAR(160) NULL,
      courier           VARCHAR(160) NULL,
      shipping_provider VARCHAR(160) NULL,
      rto_tracking      VARCHAR(160) NULL,
      rto_courier       VARCHAR(160) NULL,
      rto_reason        VARCHAR(255) NULL,
      invoice_code      VARCHAR(120) NULL,
      putaway_code      VARCHAR(120) NULL,
      customer_name     VARCHAR(255) NULL,
      customer_phone    VARCHAR(60)  NULL,
      customer_city     VARCHAR(120) NULL,
      customer_state    VARCHAR(120) NULL,
      customer_pincode  VARCHAR(20)  NULL,
      -- Documented payload mein koi rakam nahi hai. Column rakha hai taaki
      -- jab source mile to bharne ke liye jagah ho; tab tak NULL.
      return_amount     DECIMAL(14,2) NULL,
      total_lines       INT NOT NULL DEFAULT 0,
      created_at_uni    DATETIME NULL,
      updated_at_uni    DATETIME NULL,
      synced_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_uni_ret_date (return_date),
      KEY idx_uni_ret_type (return_type),
      KEY idx_uni_ret_status (status),
      KEY idx_uni_ret_order (order_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Ek row per (return, sale order item). saleOrderItemCode hi woh cheez hai
  // jo is item ko asli order se jodti hai.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_return_items (
      return_code       VARCHAR(120) NOT NULL,
      sale_order_item   VARCHAR(120) NOT NULL,
      sku               VARCHAR(120) NULL,
      item_name         VARCHAR(500) NULL,
      item_status       VARCHAR(60)  NULL,
      order_code        VARCHAR(120) NULL,
      shipment_code     VARCHAR(120) NULL,
      facility          VARCHAR(80)  NULL,
      inventory_type    VARCHAR(60)  NULL,
      return_reason     VARCHAR(500) NULL,
      qc_comment        VARCHAR(500) NULL,
      remarks           VARCHAR(500) NULL,
      courier_status    VARCHAR(120) NULL,
      tracking_status   VARCHAR(120) NULL,
      PRIMARY KEY (return_code, sale_order_item),
      KEY idx_uni_ri_sku (sku),
      KEY idx_uni_ri_order (order_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_return_sync_log (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      started_at   DATETIME NOT NULL,
      ended_at     DATETIME NULL,
      from_date    VARCHAR(40) NULL,
      to_date      VARCHAR(40) NULL,
      returns_seen INT NOT NULL DEFAULT 0,
      ok           TINYINT(1) NOT NULL DEFAULT 0,
      error        TEXT NULL,
      KEY idx_uni_rls (started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function storeReturn(code, returnType, facility, json) {
  const v = (json && json.returnSaleOrderValue) || {};
  const items = (json && json.returnSaleOrderItems) || [];
  const addr = ((json && json.returnAddressDetailsList) || [])[0] || {};

  await pool.query(
    `INSERT INTO uni_returns
       (code, return_type, status, facility, channel, order_code, shipment_code,
        reverse_pickup, challan_no, challan_date, return_date, channel_return_date, delivery_date,
        received_date, completed_date, tracking_number, courier,
        shipping_provider, rto_tracking, rto_courier, rto_reason, invoice_code,
        putaway_code, customer_name, customer_phone, customer_city,
        customer_state, customer_pincode, total_lines, created_at_uni, updated_at_uni)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       status=VALUES(status), facility=VALUES(facility), channel=VALUES(channel),
       order_code=VALUES(order_code), shipment_code=VALUES(shipment_code),
       reverse_pickup=VALUES(reverse_pickup), challan_no=VALUES(challan_no),
       delivery_date=VALUES(delivery_date), received_date=VALUES(received_date),
       completed_date=VALUES(completed_date),
       tracking_number=VALUES(tracking_number), courier=VALUES(courier),
       rto_tracking=VALUES(rto_tracking), rto_reason=VALUES(rto_reason),
       invoice_code=VALUES(invoice_code), putaway_code=VALUES(putaway_code),
       total_lines=VALUES(total_lines), updated_at_uni=VALUES(updated_at_uni),
       synced_at=CURRENT_TIMESTAMP`,
    [code, returnType, v.returnStatus || null, facility, v.channel || null,
     v.saleOrderCode || (items[0] || {}).saleOrderCode || null,
     v.shipmentCode || code, v.reversePickupCode || null,
     v.deliveryChallanNumber || null, dt(v.deliveryChallanDate),
     dt(v.returnCreatedDate), dt(v.channelReturnCreatedDate), dt(v.returnDeliveryDate),
     dt(v.inventoryReceivedDate), dt(v.returnCompletedDate),
     v.trackingNumber || null, v.courierName || null, v.shippingProviderCode || null,
     v.rtoTrackingNumber || null, v.rtoCourierName || null, v.rtoReason || null,
     v.returnInvoiceCode || null, v.putawayCode || null,
     addr.name || null, addr.phone || null, addr.city || null,
     addr.state || null, addr.pincode || null,
     items.length, dt(v.returnCreatedDate), dt(v.returnCompletedDate)]);

  if (items.length) {
    const rows = items.map(i => [
      code, String(i.saleOrderItemCode || i.skuCode || ''), i.skuCode || null,
      i.itemName || null, i.saleOrderItemStatus || null, i.saleOrderCode || null,
      i.shipmentCode || null, i.forwardItemFacility || facility,
      i.inventoryType || null, i.marketplaceReturnReason || null,
      i.putawayQcComment || null, i.returnRemarks || null,
      i.courierStatus || null, i.trackingStatus || null,
    ]);
    await pool.query(
      `INSERT INTO uni_return_items
         (return_code, sale_order_item, sku, item_name, item_status, order_code,
          shipment_code, facility, inventory_type, return_reason, qc_comment,
          remarks, courier_status, tracking_status)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         item_status=VALUES(item_status), inventory_type=VALUES(inventory_type),
         return_reason=VALUES(return_reason), qc_comment=VALUES(qc_comment),
         remarks=VALUES(remarks), courier_status=VALUES(courier_status),
         tracking_status=VALUES(tracking_status)`,
      [rows]);

    // Rakam order se. saleOrderItemCode seedha uni_order_items ka primary key
    // hai, to yeh wahi line value hai jo wapas aa rahi hai — ginee hui, maani
    // hui nahi. Agar woh order abhi sync nahi hua (returns ka window orders se
    // lamba ho sakta hai) to SUM null rehta hai, aur agli baar order aane par
    // apne aap bhar jaata hai.
    await pool.query(
      `UPDATE uni_returns r
          SET r.return_amount = (
            SELECT SUM(oi.total_price)
              FROM uni_return_items ri
              JOIN uni_order_items oi ON oi.code = ri.sale_order_item
             WHERE ri.return_code = r.code)
        WHERE r.code = ?`, [code]);
  }
}

async function syncReturns({ fromDate, toDate } = {}) {
  const [r0] = await pool.query(
    'INSERT INTO uni_return_sync_log (started_at, from_date, to_date) VALUES (NOW(),?,?)',
    [fromDate, toDate]);
  const runId = r0.insertId;

  try {
    const uniSync = require(path.join(__dirname, 'unicommerce-sync'));
    const facilities = await uniSync.facilityCodes();

    // (code → type, facility). Ek hi return do window mein aa sakta hai aur
    // detail call mehngi hai, isliye Map.
    const found = new Map();

    for (const facility of facilities) {
      for (const returnType of RETURN_TYPES) {
        for (let ws = new Date(fromDate); ws < new Date(toDate);
             ws = new Date(ws.getTime() + WINDOW_MS)) {
          let we = new Date(ws.getTime() + WINDOW_MS);
          if (we > new Date(toDate)) we = new Date(toDate);

          const r = await uni.uniCall('RETURN_SEARCH', {
            returnType, createdFrom: isoSec(ws), createdTo: isoSec(we),
          }, { facility });
          if (!r.successful) {
            throw new Error(`return/search (${facility}/${returnType}): ` + (uni.explain(r) || r.status));
          }
          for (const e of (r.json && r.json.returnOrders) || []) {
            if (e.code) found.set(e.code, { returnType, facility });
          }
        }
      }
    }

    log(`  ${found.size} returns mile (${String(fromDate).slice(0, 10)} → ${String(toDate).slice(0, 10)})`);

    let done = 0, failed = 0;
    for (const [code, meta] of found) {
      const g = await uni.uniCall('RETURN_GET', { shipmentCode: code }, { facility: meta.facility });
      if (!g.successful || !g.json) {
        failed++;
        log(`  ⚠ ${code}: ${uni.explain(g) || 'detail nahi mila'}`);
      } else {
        await storeReturn(code, meta.returnType, meta.facility, g.json);
      }
      done++;
      if (done % 25 === 0 || done === found.size) log(`  ${done}/${found.size} store hue`);
      if (done < found.size) await sleep(GET_GAP_MS);
    }

    await pool.query(
      'UPDATE uni_return_sync_log SET ended_at=NOW(), returns_seen=?, ok=1 WHERE id=?',
      [done - failed, runId]);
    return { returns: done - failed, failed };
  } catch (e) {
    await pool.query(
      'UPDATE uni_return_sync_log SET ended_at=NOW(), ok=0, error=? WHERE id=?',
      [String(e.message).slice(0, 2000), runId]);
    throw e;
  }
}

async function status() {
  const [[r]] = await pool.query(
    'SELECT COUNT(*) n, MIN(return_date) a, MAX(return_date) b FROM uni_returns');
  const [[i]] = await pool.query('SELECT COUNT(*) n FROM uni_return_items');
  const [byType] = await pool.query(
    'SELECT return_type, COUNT(*) n FROM uni_returns GROUP BY return_type');
  const [last] = await pool.query(
    `SELECT started_at, ended_at, returns_seen, ok, LEFT(COALESCE(error,''),100) err
       FROM uni_return_sync_log ORDER BY id DESC LIMIT 3`);
  return { returns: r, items: i.n, byType, recent: last };
}

module.exports = { pool, ensureTables, syncReturns, storeReturn, status };

// ── CLI ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const gaps = uni.missingConfig();
    if (gaps.length) throw new Error('Unicommerce configured nahi — .env mein chahiye: ' + gaps.join(', '));

    const [cmd, a] = process.argv.slice(2);
    await ensureTables();

    if (cmd === 'sync') {
      const days = Number(a) || 29;
      const r = await syncReturns({
        fromDate: new Date(Date.now() - days * 86400000).toISOString(),
        toDate: new Date().toISOString(),
      });
      console.log(`\nDone — ${r.returns} returns` + (r.failed ? `, ${r.failed} fail` : ''));

    } else if (cmd === 'status') {
      const s = await status();
      console.log(`returns   : ${s.returns.n}` +
        (s.returns.a ? `  (${String(s.returns.a).slice(4, 15)} → ${String(s.returns.b).slice(4, 15)})` : ''));
      console.log(`line items: ${s.items}`);
      s.byType.forEach(t => console.log(`  ${String(t.return_type).padEnd(6)} ${t.n}`));
      console.log('recent    :');
      s.recent.forEach(x => console.log(`  ${String(x.started_at).slice(4, 24)} seen=${x.returns_seen} ok=${x.ok} ${x.err}`));

    } else {
      console.log('Usage: node backend/uni-returns-sync.js [sync [days] | status]');
    }
    await pool.end();
  })().catch(e => { console.error('\n✗', e.message); process.exit(1); });
}
