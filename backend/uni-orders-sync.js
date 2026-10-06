// ════════════════════════════════════════════════════════════════════════
//  uni-orders-sync.js — Uniware ke sale orders MySQL mein.
//
//    node backend/uni-orders-sync.js sync            pichhle 30 din
//    node backend/uni-orders-sync.js sync 90         pichhle 90 din
//    node backend/uni-orders-sync.js sync 2026-09-01 2026-10-05
//    node backend/uni-orders-sync.js sync 10 updated  status badle hue orders
//    node backend/uni-orders-sync.js status
//
//  DO CALL PER ORDER, AUR ISKA KOI SHORTCUT NAHI:
//  saleOrder/search sirf header deta hai — code, channel, status, tareekh.
//  Na line items, na rakam, na pata. Woh sab saleorder/get se aata hai, ek
//  call per order. Isliye 2,000 orders ka backfill 2,000 call hai aur minaton
//  lagta hai. Rozaana sync chhota hota hai, isliye yeh kharcha sirf pehli
//  baar lagta hai.
//
//  dateType ka farq samajhna zaroori hai:
//    CREATED  — jo orders is daur mein BANE. Backfill ke liye yahi.
//    UPDATED  — jo is daur mein BADLE. Rozaana refresh ke liye yahi, kyunki
//               purana order aaj dispatch ho sakta hai aur CREATED usse
//               kabhi nahi pakdega.
//
//  HAR saleOrderItem EK UNIT HAI. totalQuantity null aata hai; ek hi SKU ke
//  do piece do alag rows hain, har ek ka apna code aur status. Isliye
//  uni_order_items ka PK item ka code hai, (order, sku) nahi — warna do piece
//  aapas mein overwrite ho jaate. Quantity = rows ki ginti.
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

const PAGE = Number(process.env.UNI_ORDER_PAGE || 500);
const GET_GAP_MS = Number(process.env.UNI_GET_GAP_MS || 120);   // detail calls ke beech
// saleOrder/search 30 din se bade range par code 300216 deta hai; 28 par rehte
// hain taaki timezone/boundary ka ek din kinare par na le jaye.
const WINDOW_MS = Number(process.env.UNI_WINDOW_DAYS || 28) * 86400000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const log = m => console.log(m);
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const bool = v => (v === true || v === 'true' ? 1 : 0);
// Uniware epoch milliseconds bhejta hai; MySQL DATETIME chahiye.
const dt = ms => (ms ? new Date(Number(ms)) : null);

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_orders (
      code              VARCHAR(120) NOT NULL PRIMARY KEY,
      display_code      VARCHAR(120) NULL,
      channel           VARCHAR(80)  NULL,
      source            VARCHAR(80)  NULL,
      status            VARCHAR(60)  NULL,
      order_category    VARCHAR(60)  NULL,
      order_date        DATETIME NULL,
      created_at_uni    DATETIME NULL,
      updated_at_uni    DATETIME NULL,
      fulfillment_tat   DATETIME NULL,
      cod               TINYINT(1) NOT NULL DEFAULT 0,
      currency          VARCHAR(10)  NULL,
      priority          VARCHAR(40)  NULL,
      customer_code     VARCHAR(120) NULL,
      customer_name     VARCHAR(255) NULL,
      customer_gstin    VARCHAR(40)  NULL,
      notification_email VARCHAR(255) NULL,
      notification_mobile VARCHAR(60) NULL,
      ship_address      VARCHAR(500) NULL,
      ship_city         VARCHAR(120) NULL,
      ship_state        VARCHAR(120) NULL,
      ship_pincode      VARCHAR(20)  NULL,
      ship_country      VARCHAR(80)  NULL,
      facility          VARCHAR(80)  NULL,
      item_count        INT NOT NULL DEFAULT 0,
      order_amount      DECIMAL(14,2) NULL,
      total_discount    DECIMAL(14,2) NULL,
      shipping_charges  DECIMAL(14,2) NULL,
      synced_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_uni_ord_date (order_date),
      KEY idx_uni_ord_status (status),
      KEY idx_uni_ord_channel (channel),
      KEY idx_uni_ord_facility (facility)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // PK item ka apna code — har row ek unit. Dekho file ke upar wala note.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_order_items (
      code            VARCHAR(120) NOT NULL PRIMARY KEY,
      order_code      VARCHAR(120) NOT NULL,
      sku             VARCHAR(120) NULL,
      seller_sku      VARCHAR(120) NULL,
      item_name       VARCHAR(500) NULL,
      status          VARCHAR(60)  NULL,
      facility        VARCHAR(80)  NULL,
      selling_price   DECIMAL(12,2) NULL,
      total_price     DECIMAL(12,2) NULL,
      discount        DECIMAL(12,2) NULL,
      shipping_charges DECIMAL(12,2) NULL,
      max_retail_price DECIMAL(12,2) NULL,
      tax_percentage  DECIMAL(8,3) NULL,
      total_gst       DECIMAL(12,2) NULL,
      hsn_code        VARCHAR(40)  NULL,
      color           VARCHAR(120) NULL,
      size            VARCHAR(60)  NULL,
      brand           VARCHAR(120) NULL,
      shipping_package VARCHAR(120) NULL,
      cancellation_reason VARCHAR(255) NULL,
      created_at_uni  DATETIME NULL,
      updated_at_uni  DATETIME NULL,
      KEY idx_uni_oi_order (order_code),
      KEY idx_uni_oi_sku (sku),
      KEY idx_uni_oi_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Tracking aur invoice. Yeh data orders ke saath hi aa jaata hai — iske liye
  // koi alag API call nahi lagti — isliye use phenkna fizool hota.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_shipments (
      code             VARCHAR(120) NOT NULL PRIMARY KEY,
      order_code       VARCHAR(120) NOT NULL,
      channel_shipment VARCHAR(120) NULL,
      status           VARCHAR(60)  NULL,
      courier          VARCHAR(160) NULL,
      shipping_provider VARCHAR(160) NULL,
      shipping_method  VARCHAR(120) NULL,
      tracking_number  VARCHAR(160) NULL,
      tracking_status  VARCHAR(80)  NULL,
      courier_status   VARCHAR(120) NULL,
      invoice_code     VARCHAR(120) NULL,
      invoice_date     DATETIME NULL,
      dispatched_at    DATETIME NULL,
      delivered_at     DATETIME NULL,
      city             VARCHAR(120) NULL,
      no_of_items      INT NULL,
      collectable_amount DECIMAL(14,2) NULL,
      collected_amount DECIMAL(14,2) NULL,
      actual_weight    DECIMAL(12,3) NULL,
      created_at_uni   DATETIME NULL,
      updated_at_uni   DATETIME NULL,
      KEY idx_uni_shp_order (order_code),
      KEY idx_uni_shp_tracking (tracking_number),
      KEY idx_uni_shp_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uni_order_sync_log (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      started_at  DATETIME NOT NULL,
      ended_at    DATETIME NULL,
      from_date   VARCHAR(40) NULL,
      to_date     VARCHAR(40) NULL,
      date_type   VARCHAR(20) NULL,
      orders_seen INT NOT NULL DEFAULT 0,
      ok          TINYINT(1) NOT NULL DEFAULT 0,
      error       TEXT NULL,
      KEY idx_uni_ols (started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// ── Store ────────────────────────────────────────────────────────────────
async function storeOrder(so) {
  const items = so.saleOrderItems || [];
  const packs = so.shippingPackages || [];

  // Order-level totalDiscount/totalShippingCharges aksar null aate hain —
  // asli rakam items par hoti hai, isliye wahin se jodte hain.
  const sum = (f) => {
    const vals = items.map(i => Number(i[f]) || 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };

  const addr = (so.addresses && so.addresses[0]) || so.billingAddress || {};
  const facility = (items.find(i => i.facilityCode) || {}).facilityCode || null;

  await pool.query(
    `INSERT INTO uni_orders
       (code, display_code, channel, source, status, order_category, order_date,
        created_at_uni, updated_at_uni, fulfillment_tat, cod, currency, priority,
        customer_code, customer_name, customer_gstin, notification_email,
        notification_mobile, ship_address, ship_city, ship_state, ship_pincode,
        ship_country, facility, item_count, order_amount, total_discount,
        shipping_charges)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       display_code=VALUES(display_code), channel=VALUES(channel),
       source=VALUES(source), status=VALUES(status),
       order_category=VALUES(order_category), order_date=VALUES(order_date),
       created_at_uni=VALUES(created_at_uni), updated_at_uni=VALUES(updated_at_uni),
       fulfillment_tat=VALUES(fulfillment_tat), cod=VALUES(cod),
       currency=VALUES(currency), priority=VALUES(priority),
       customer_code=VALUES(customer_code), customer_name=VALUES(customer_name),
       customer_gstin=VALUES(customer_gstin),
       notification_email=VALUES(notification_email),
       notification_mobile=VALUES(notification_mobile),
       ship_address=VALUES(ship_address), ship_city=VALUES(ship_city),
       ship_state=VALUES(ship_state), ship_pincode=VALUES(ship_pincode),
       ship_country=VALUES(ship_country), facility=VALUES(facility),
       item_count=VALUES(item_count), order_amount=VALUES(order_amount),
       total_discount=VALUES(total_discount),
       shipping_charges=VALUES(shipping_charges),
       synced_at=CURRENT_TIMESTAMP`,
    [so.code, so.displayOrderCode || null, so.channel || null, so.source || null,
     so.status || null, so.orderCategory || null, dt(so.displayOrderDateTime),
     dt(so.created), dt(so.updated), dt(so.fulfillmentTat), bool(so.cod),
     so.currencyCode || null, so.priority || null, so.customerCode || null,
     addr.name || null, so.customerGSTIN || null, so.notificationEmail || null,
     so.notificationMobile || null,
     [addr.addressLine1, addr.addressLine2].filter(Boolean).join(', ') || null,
     addr.city || null, addr.stateName || addr.state || null,
     addr.pincode || null, addr.country || null, facility,
     items.length, sum('totalPrice'),
     num(so.totalDiscount) !== null ? num(so.totalDiscount) : sum('discount'),
     num(so.totalShippingCharges) !== null ? num(so.totalShippingCharges) : sum('shippingCharges')]);

  if (items.length) {
    const rows = items.map(i => [
      String(i.code), so.code, i.itemSku || null, i.sellerSkuCode || null,
      uni.fixBrand(i.itemName) || null, i.statusCode || null, i.facilityCode || null,
      num(i.sellingPrice), num(i.totalPrice), num(i.discount),
      num(i.shippingCharges), num(i.maxRetailPrice), num(i.taxPercentage),
      (Number(i.totalIntegratedGst) || 0) + (Number(i.totalStateGst) || 0) +
        (Number(i.totalCentralGst) || 0) + (Number(i.totalUnionTerritoryGst) || 0),
      i.hsnCode || null, i.color || null, i.size || null, i.brand || null,
      i.shippingPackageCode || null, i.cancellationReason || null,
      dt(i.created), dt(i.updated),
    ]);
    await pool.query(
      `INSERT INTO uni_order_items
         (code, order_code, sku, seller_sku, item_name, status, facility,
          selling_price, total_price, discount, shipping_charges,
          max_retail_price, tax_percentage, total_gst, hsn_code, color, size,
          brand, shipping_package, cancellation_reason, created_at_uni, updated_at_uni)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         status=VALUES(status), facility=VALUES(facility),
         selling_price=VALUES(selling_price), total_price=VALUES(total_price),
         discount=VALUES(discount), shipping_charges=VALUES(shipping_charges),
         shipping_package=VALUES(shipping_package),
         cancellation_reason=VALUES(cancellation_reason),
         updated_at_uni=VALUES(updated_at_uni)`,
      [rows]);
  }

  if (packs.length) {
    const rows = packs.map(p => [
      String(p.code), so.code, p.channelShipmentCode || null, p.status || null,
      p.shippingCourier || null, p.shippingProvider || null, p.shippingMethod || null,
      p.trackingNumber || null, p.trackingStatus || null, p.courierStatus || null,
      p.invoiceCode || p.invoiceDisplayCode || null, dt(p.invoiceDate),
      dt(p.dispatched), dt(p.delivered), p.city || null, num(p.noOfItems),
      num(p.collectableAmount), num(p.collectedAmount), num(p.actualWeight),
      dt(p.created), dt(p.updated),
    ]);
    await pool.query(
      `INSERT INTO uni_shipments
         (code, order_code, channel_shipment, status, courier, shipping_provider,
          shipping_method, tracking_number, tracking_status, courier_status,
          invoice_code, invoice_date, dispatched_at, delivered_at, city,
          no_of_items, collectable_amount, collected_amount, actual_weight,
          created_at_uni, updated_at_uni)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         status=VALUES(status), courier=VALUES(courier),
         tracking_number=VALUES(tracking_number),
         tracking_status=VALUES(tracking_status),
         courier_status=VALUES(courier_status),
         invoice_code=VALUES(invoice_code), invoice_date=VALUES(invoice_date),
         dispatched_at=VALUES(dispatched_at), delivered_at=VALUES(delivered_at),
         collected_amount=VALUES(collected_amount),
         updated_at_uni=VALUES(updated_at_uni)`,
      [rows]);
  }
}

// ── Sync ─────────────────────────────────────────────────────────────────
async function syncOrders({ fromDate, toDate, dateType = 'CREATED' } = {}) {
  const [r0] = await pool.query(
    'INSERT INTO uni_order_sync_log (started_at, from_date, to_date, date_type) VALUES (NOW(),?,?,?)',
    [fromDate, toDate, dateType]);
  const runId = r0.insertId;

  try {
    // 1) Headers. saleOrder/search ek request mein 30 din se zyada nahi leta
    //    (code 300216 SALE_ORDER_SEARCH_DATE_RANGE_LIMIT_EXCEEDED), isliye
    //    poore span ko chhote windows mein chalte hain. Codes ko Set mein
    //    rakhte hain: UPDATED mode mein ek hi order do windows mein aa sakta
    //    hai, aur detail call mehngi hai — do baar nahi karni.
    const seen = new Set();
    const start0 = new Date(fromDate), end0 = new Date(toDate);

    for (let ws = new Date(start0); ws < end0; ws = new Date(ws.getTime() + WINDOW_MS)) {
      let we = new Date(ws.getTime() + WINDOW_MS);
      if (we > end0) we = new Date(end0);

      let start = 0, total = null;
      do {
        const r = await uni.uniCall('ORDER_SEARCH', {
          fromDate: ws.toISOString(), toDate: we.toISOString(), dateType,
          searchOptions: { displayStart: start, displayLength: PAGE, getCount: true },
        });
        if (!r.successful) throw new Error('saleOrder/search failed: ' + (uni.explain(r) || r.status));

        const els = (r.json && r.json.elements) || [];
        if (total === null) total = Number(r.json.totalRecords) || els.length;
        els.forEach(e => seen.add(e.code));
        start += els.length;
        if (!els.length || els.length < PAGE) break;
      } while (start < total);

      if (total) log(`  ${ws.toISOString().slice(0, 10)} → ${we.toISOString().slice(0, 10)}: ${total}`);
    }

    const codes = [...seen];
    log(`  ${codes.length} orders mile (${dateType} ${fromDate.slice(0, 10)} → ${toDate.slice(0, 10)})`);

    // 2) Detail — ek call per order. Yahi mehnga hissa hai.
    let done = 0, failed = 0;
    for (const code of codes) {
      const g = await uni.uniCall('ORDER_GET', { code });
      const so = g.json && g.json.saleOrderDTO;
      if (!g.successful || !so) {
        failed++;
        log(`  ⚠ ${code}: ${uni.explain(g) || 'saleOrderDTO nahi mila'}`);
      } else {
        await storeOrder(so);
      }
      done++;
      if (done % 25 === 0 || done === codes.length) {
        log(`  ${done}/${codes.length} store hue${failed ? `, ${failed} fail` : ''}`);
      }
      if (done < codes.length) await sleep(GET_GAP_MS);
    }

    await pool.query(
      'UPDATE uni_order_sync_log SET ended_at=NOW(), orders_seen=?, ok=1 WHERE id=?',
      [done - failed, runId]);
    return { orders: done - failed, failed };
  } catch (e) {
    await pool.query(
      'UPDATE uni_order_sync_log SET ended_at=NOW(), ok=0, error=? WHERE id=?',
      [String(e.message).slice(0, 2000), runId]);
    throw e;
  }
}

async function status() {
  const [[o]] = await pool.query(
    'SELECT COUNT(*) n, MIN(order_date) a, MAX(order_date) b, SUM(order_amount) amt FROM uni_orders');
  const [[i]] = await pool.query('SELECT COUNT(*) n FROM uni_order_items');
  const [[s]] = await pool.query('SELECT COUNT(*) n FROM uni_shipments');
  const [byCh] = await pool.query(
    'SELECT channel, COUNT(*) n FROM uni_orders GROUP BY channel ORDER BY n DESC LIMIT 8');
  const [last] = await pool.query(
    `SELECT started_at, ended_at, orders_seen, ok, date_type, LEFT(COALESCE(error,''),100) err
       FROM uni_order_sync_log ORDER BY id DESC LIMIT 3`);
  return { orders: o, items: i.n, shipments: s.n, byChannel: byCh, recent: last };
}

module.exports = { pool, ensureTables, syncOrders, storeOrder, status };

// ── CLI ──────────────────────────────────────────────────────────────────
const iso = d => new Date(d).toISOString();

if (require.main === module) {
  (async () => {
    const gaps = uni.missingConfig();
    if (gaps.length) throw new Error('Unicommerce configured nahi — .env mein chahiye: ' + gaps.join(', '));

    const [cmd, a, b] = process.argv.slice(2);
    await ensureTables();

    if (cmd === 'sync') {
      // "sync 90" ya "sync 2026-09-01 2026-10-05"; aakhri arg "updated" ho to
      // dateType UPDATED (status badlav pakadne ke liye).
      const args = process.argv.slice(3);
      const useUpdated = args.some(x => String(x).toLowerCase() === 'updated');
      const dates = args.filter(x => String(x).toLowerCase() !== 'updated');

      let from, to = new Date();
      if (dates.length >= 2) { from = new Date(dates[0]); to = new Date(dates[1]); }
      else { from = new Date(Date.now() - (Number(dates[0]) || 30) * 86400000); }

      const r = await syncOrders({
        fromDate: iso(from), toDate: iso(to),
        dateType: useUpdated ? 'UPDATED' : 'CREATED',
      });
      console.log(`\nDone — ${r.orders} orders store hue` + (r.failed ? `, ${r.failed} fail` : ''));

    } else if (cmd === 'status') {
      const s = await status();
      console.log(`orders    : ${s.orders.n}` +
        (s.orders.a ? `  (${String(s.orders.a).slice(4, 15)} → ${String(s.orders.b).slice(4, 15)})` : ''));
      console.log(`line items: ${s.items}   shipments: ${s.shipments}`);
      if (s.orders.amt) console.log(`value     : ₹${Number(s.orders.amt).toLocaleString('en-IN')}`);
      console.log('channels  :');
      s.byChannel.forEach(c => console.log(`  ${String(c.channel).padEnd(22)} ${c.n}`));
      console.log('recent    :');
      s.recent.forEach(r => console.log(`  ${String(r.started_at).slice(4, 24)} ${r.date_type} ` +
        `orders=${r.orders_seen} ok=${r.ok} ${r.err}`));

    } else {
      console.log('Usage: node backend/uni-orders-sync.js [sync [days | from to] [updated] | status]');
    }
    await pool.end();
  })().catch(e => { console.error('\n✗', e.message); process.exit(1); });
}
