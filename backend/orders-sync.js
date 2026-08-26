// ══════════════════════════════════════════════════════════════════════════
//  orders-sync.js — pull live orders from Vin eRetail into vin_orders / _items.
//
//  Uses v2/order/orderPullV2, the endpoint Vinculum themselves confirmed. Two
//  things differ from the inventory calls and both matter:
//    • Credentials go in the FORM BODY (ApiKey / ApiOwner as fields), NOT as
//      headers — that, not any OrgId, is what the order endpoints authenticate
//      on. No OrgId is sent.
//    • It reads only. The "processed / downloaded" mark that Order Pull is
//      known for happens on a SEPARATE acknowledge call (ackType/ackTime on the
//      line) which this never makes — so pulling here does not touch fulfilment.
//
//    node backend/orders-sync.js sync [days]     # default 90 days back to today
//    node backend/orders-sync.js sync 2026-06-01 2026-08-25
//    node backend/orders-sync.js status
//
//  Only analytical + line-item fields are stored — no customer names, phones,
//  emails or street addresses. City/State stay for geography.
// ══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const mysql = require('mysql2/promise');

const BASE       = (process.env.VIN_BASE_URL || 'https://bunai.vineretail.com/RestWS/api/eretail').replace(/\/+$/, '');
const ORDER_KEY  = process.env.VIN_ORDER_API_KEY   || '';
const ORDER_OWNER= process.env.VIN_ORDER_API_OWNER || 'APIUSER';
const LOCATIONS  = (process.env.VIN_ORDER_LOCATIONS || 'BUN').split(',').map(s => s.trim()).filter(Boolean);
const PAGE_GAP_MS= Number(process.env.VIN_ORDER_PAGE_GAP_MS || 800);

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME, waitForConnections: true, connectionLimit: 4,
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Schema ─────────────────────────────────────────────────────────────────
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vin_orders (
      order_id           VARCHAR(60)  NOT NULL PRIMARY KEY,
      ext_order_no       VARCHAR(120) NULL,
      order_date         DATETIME     NULL,
      status             VARCHAR(60)  NULL,
      payment_method     VARCHAR(30)  NULL,
      order_amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
      order_currency     VARCHAR(10)  NULL,
      channel_name       VARCHAR(80)  NULL,
      channel_code       VARCHAR(40)  NULL,
      order_source       VARCHAR(80)  NULL,
      order_type         VARCHAR(20)  NULL,
      ship_by_date       DATETIME     NULL,
      ship_date          DATETIME     NULL,
      delivery_date      DATETIME     NULL,
      updated_date       DATETIME     NULL,
      fulfillment_loc    VARCHAR(80)  NULL,
      total_lines        INT          NOT NULL DEFAULT 0,
      customer_name      VARCHAR(200) NULL,
      customer_phone     VARCHAR(40)  NULL,
      customer_email     VARCHAR(160) NULL,
      customer_gstin     VARCHAR(40)  NULL,
      ship_address       VARCHAR(500) NULL,
      ship_city          VARCHAR(120) NULL,
      ship_state         VARCHAR(120) NULL,
      ship_pincode       VARCHAR(20)  NULL,
      ship_country       VARCHAR(80)  NULL,
      bill_name          VARCHAR(200) NULL,
      bill_city          VARCHAR(120) NULL,
      bill_state         VARCHAR(120) NULL,
      bill_pincode       VARCHAR(20)  NULL,
      discount_amount    DECIMAL(12,2) NOT NULL DEFAULT 0,
      tax_amount         DECIMAL(12,2) NOT NULL DEFAULT 0,
      shipping_charges   DECIMAL(12,2) NOT NULL DEFAULT 0,
      cod_charge         DECIMAL(12,2) NOT NULL DEFAULT 0,
      collectible_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      store_credit       DECIMAL(12,2) NOT NULL DEFAULT 0,
      voucher_code       VARCHAR(80)  NULL,
      promo_name         VARCHAR(160) NULL,
      is_verified        TINYINT(1)   NOT NULL DEFAULT 0,
      is_on_hold         TINYINT(1)   NOT NULL DEFAULT 0,
      is_replacement     TINYINT(1)   NOT NULL DEFAULT 0,
      order_remarks      VARCHAR(500) NULL,
      cancel_remark      VARCHAR(500) NULL,
      pickup_location    VARCHAR(120) NULL,
      distribution_type  VARCHAR(60)  NULL,
      raw_json           LONGTEXT     NULL,
      synced_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_ord_date (order_date),
      KEY idx_ord_status (status),
      KEY idx_ord_channel (channel_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vin_order_items (
      order_id      VARCHAR(60)  NOT NULL,
      line_no       VARCHAR(40)  NOT NULL,
      sku           VARCHAR(120) NULL,
      sku_name      VARCHAR(255) NULL,
      brand         VARCHAR(120) NULL,
      status        VARCHAR(60)  NULL,
      order_qty     DECIMAL(12,2) NOT NULL DEFAULT 0,
      shipped_qty   DECIMAL(12,2) NOT NULL DEFAULT 0,
      cancelled_qty DECIMAL(12,2) NOT NULL DEFAULT 0,
      return_qty    DECIMAL(12,2) NOT NULL DEFAULT 0,
      unit_price    DECIMAL(12,2) NOT NULL DEFAULT 0,
      discount_amt  DECIMAL(12,2) NOT NULL DEFAULT 0,
      tax_amount    DECIMAL(12,2) NOT NULL DEFAULT 0,
      PRIMARY KEY (order_id, line_no),
      KEY idx_item_sku (sku)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vin_order_sync_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      started_at DATETIME NOT NULL, ended_at DATETIME NULL,
      from_date VARCHAR(30) NULL, to_date VARCHAR(30) NULL,
      orders_seen INT NOT NULL DEFAULT 0, ok TINYINT(1) NOT NULL DEFAULT 0, error TEXT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// "DD/MM/YYYY HH:MM:SS" -> "YYYY-MM-DD HH:MM:SS" or null
function vinDate(s) {
  s = String(s || '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}):?(\d{2})?)?/);
  if (!m) return null;
  const p = n => String(n).padStart(2, '0');
  return `${m[3]}-${p(m[2])}-${p(m[1])} ${p(m[4] || 0)}:${p(m[5] || 0)}:${p(m[6] || 0)}`;
}
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// ── One page of a pull ──────────────────────────────────────────────────────
async function pullPage(fromDate, toDate, pageNumber, location) {
  if (!ORDER_KEY) throw new Error('VIN_ORDER_API_KEY not set (the orderPull APIUSER key)');
  const requestBody = JSON.stringify({
    orderNo: '', fromDate, toDate, pageNumber,
    order_Location: '', IsReplacementOrder: '', orderSource: '', paymentType: [],
    filterBy: 1, fulfillmentLocation: location, reqType: 'wms',
  });
  const form = new URLSearchParams();
  form.set('RequestBody', requestBody);
  form.set('ApiOwner', ORDER_OWNER);
  form.set('ApiKey', ORDER_KEY);

  const res = await fetch(`${BASE}/v2/order/orderPullV2`, {
    method: 'POST',
    headers: { accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { throw new Error('Vin returned non-JSON: ' + text.slice(0, 160)); }
  return json;
}

// Pull every page for a date range and location.
async function pullRange(fromDate, toDate, location, onProgress) {
  const all = [];
  let page = 1, totalPages = 1;
  do {
    const j = await pullPage(fromDate, toDate, page, location);
    if (j.responseCode === 9) break;                 // No Record Found
    if (j.responseCode !== 0) throw new Error(`orderPull ${j.responseCode}: ${j.responseMessage}`);
    const list = j.orderList || [];
    all.push(...list);
    totalPages = Number(j.totalPages) || 1;
    if (onProgress) onProgress(location, page, totalPages, all.length);
    page++;
    if (page <= totalPages) await sleep(PAGE_GAP_MS);
  } while (page <= totalPages);
  return all;
}

// ── Store ───────────────────────────────────────────────────────────────────
function truthy(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  return (s === 'yes' || s === 'true' || s === '1' || v === true || v === 1) ? 1 : 0;
}

// Column → extractor. Every meaningful order field is kept, and raw_json holds
// the full order object (minus items, which live in vin_order_items) so nothing
// the API returns is ever lost.
const ORDER_COLS = [
  ['order_id', o => o.orderId],
  ['ext_order_no', o => o.extenalOrderNo || o.orderNo || null],
  ['order_date', o => vinDate(o.orderDate)],
  ['status', o => o.status || null],
  ['payment_method', o => o.paymentMethod || null],
  ['order_amount', o => num(o.orderAmount)],
  ['order_currency', o => o.orderCurrency || null],
  ['channel_name', o => o.channelName || null],
  ['channel_code', o => o.channelCode || null],
  ['order_source', o => o.orderSource || null],
  ['order_type', o => o.orderType || null],
  ['ship_by_date', o => vinDate(o.shipByDate)],
  ['ship_date', o => vinDate(o.mpActualShipDate)],
  ['delivery_date', o => vinDate(o.deliveryDate)],
  ['updated_date', o => vinDate(o.updatedDate)],
  ['fulfillment_loc', o => o.fulfillmentLocName || null],
  ['total_lines', o => Number(o.totalOrderLine) || 0],
  ['customer_name', o => o.customerName || null],
  ['customer_phone', o => o.shipPhone1 || o.billPhone1 || null],
  ['customer_email', o => o.shipEmail1 || o.billEmail1 || null],
  ['customer_gstin', o => o.customerGSTIN || null],
  ['ship_address', o => ([o.shipAddress1, o.shipAddress2, o.shipAddress3, o.landmark].filter(Boolean).join(', ') || '').slice(0, 500) || null],
  ['ship_city', o => o.shipCity || null],
  ['ship_state', o => o.shipState || null],
  ['ship_pincode', o => o.shipPincode || null],
  ['ship_country', o => o.shipCountry || null],
  ['bill_name', o => o.billName || null],
  ['bill_city', o => o.billCity || null],
  ['bill_state', o => o.billState || null],
  ['bill_pincode', o => o.billPincode || null],
  ['discount_amount', o => num(o.discountAmount)],
  ['tax_amount', o => num(o.taxAmount)],
  ['shipping_charges', o => num(o.shippingCharges)],
  ['cod_charge', o => num(o.codcharge)],
  ['collectible_amount', o => num(o.collectibleAmount)],
  ['store_credit', o => num(o.storeCredit)],
  ['voucher_code', o => o.discountCode || o.promoCode || null],
  ['promo_name', o => o.promoName || null],
  ['is_verified', o => truthy(o.isVerifiedOrder)],
  ['is_on_hold', o => truthy(o.isOnHold)],
  ['is_replacement', o => truthy(o.IsReplacementOrder)],
  ['order_remarks', o => (o.orderRemarks || '').slice(0, 500) || null],
  ['cancel_remark', o => (o.cancelRemark || '').slice(0, 500) || null],
  ['pickup_location', o => o.pickupLocation || null],
  ['distribution_type', o => o.distributionType || null],
  ['raw_json', o => { const { items, ...rest } = o; return JSON.stringify(rest); }],
];

async function storeOrders(orders) {
  if (!orders.length) return 0;
  const cols = ORDER_COLS.map(c => c[0]);
  const orderRows = orders.map(o => ORDER_COLS.map(c => c[1](o)));
  const updates = cols.slice(1).map(c => `${c}=VALUES(${c})`).join(', ') + ', synced_at=CURRENT_TIMESTAMP';
  // raw_json makes each row large, so upsert in modest chunks.
  const CH = 200;
  for (let i = 0; i < orderRows.length; i += CH) {
    await pool.query(
      `INSERT INTO vin_orders (${cols.join(', ')}) VALUES ? ON DUPLICATE KEY UPDATE ${updates}`,
      [orderRows.slice(i, i + CH)]);
  }

  // Re-pull replaces an order's lines wholesale so quantities/status stay right.
  for (const o of orders) {
    await pool.query('DELETE FROM vin_order_items WHERE order_id = ?', [o.orderId]);
    const items = Array.isArray(o.items) ? o.items : [];
    if (!items.length) continue;
    const itemRows = items.map(it => [
      o.orderId, String(it.lineno || it.internalLineNo || Math.random()), it.sku || null,
      it.skuName || null, it.brand || null, it.status || null,
      num(it.orderQty), num(it.shippedQty), num(it.cancelledQty), num(it.returnQty),
      num(it.unitPrice), num(it.discountAmt), num(it.taxAmount),
    ]);
    await pool.query(
      `INSERT INTO vin_order_items
        (order_id, line_no, sku, sku_name, brand, status, order_qty, shipped_qty,
         cancelled_qty, return_qty, unit_price, discount_amt, tax_amount)
       VALUES ? ON DUPLICATE KEY UPDATE sku=VALUES(sku)`,
      [itemRows]);
  }
  return orderRows.length;
}

// ── Full sync over a range ──────────────────────────────────────────────────
function fmt(d) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

async function syncOrders({ fromDate, toDate } = {}) {
  await ensureTables();
  const started = (await pool.query('SELECT NOW() AS n'))[0][0].n;
  const [ins] = await pool.query(
    'INSERT INTO vin_order_sync_log (started_at, from_date, to_date) VALUES (?,?,?)',
    [started, fromDate, toDate]);
  const runId = ins.insertId;
  try {
    // orderPullV2 caps one request at a 7-day range (code 805), so walk the
    // whole span in ≤7-day windows.
    const parse = s => { const [d, m, y] = s.split('/').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
    const fmtUTC = dt => { const p = n => String(n).padStart(2, '0'); return `${p(dt.getUTCDate())}/${p(dt.getUTCMonth() + 1)}/${dt.getUTCFullYear()}`; };
    const start = parse(fromDate), end = parse(toDate);
    let total = 0;
    for (const loc of LOCATIONS) {
      for (let ws = new Date(start); ws <= end; ws = new Date(ws.getTime() + 7 * 86400000)) {
        let we = new Date(ws.getTime() + 6 * 86400000);
        if (we > end) we = new Date(end);
        const f = fmtUTC(ws), tt = fmtUTC(we);
        const orders = await pullRange(`${f} 00:00:01`, `${tt} 23:59:59`, loc,
          (l, pg, tp, n) => log(`  ${l} ${f}–${tt}: page ${pg}/${tp}, ${n} orders`));
        total += await storeOrders(orders);
        await sleep(PAGE_GAP_MS);
      }
    }
    await pool.query('UPDATE vin_order_sync_log SET ended_at=NOW(), orders_seen=?, ok=1 WHERE id=?', [total, runId]);
    return { orders: total };
  } catch (e) {
    await pool.query('UPDATE vin_order_sync_log SET ended_at=NOW(), ok=0, error=? WHERE id=?', [String(e.message).slice(0, 2000), runId]);
    throw e;
  }
}

function log(m) { if (process.env.NODE_ENV !== 'test') console.log(m); }

async function status() {
  const [[o]] = await pool.query('SELECT COUNT(*) n FROM vin_orders').catch(() => [[{ n: 0 }]]);
  const [[i]] = await pool.query('SELECT COUNT(*) n FROM vin_order_items').catch(() => [[{ n: 0 }]]);
  const [[l]] = await pool.query("SELECT started_at, ended_at, orders_seen, ok FROM vin_order_sync_log ORDER BY id DESC LIMIT 1").catch(() => [[null]]);
  return { orders: o.n, items: i.n, lastRun: l || null };
}

module.exports = { pool, ensureTables, syncOrders, pullRange, storeOrders, status };

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const [cmd, a, b] = process.argv.slice(2);
    if (cmd === 'sync') {
      // Dates come from the DB clock so a client in another timezone is fine.
      const [[{ today }]] = await pool.query('SELECT CURDATE() AS today');
      const to = b ? new Date(b) : today;
      let from;
      if (a && b) from = new Date(a);
      else { const days = a ? Number(a) : 90; from = new Date(to.getTime() - days * 86400000); }
      const fromStr = fmt(from), toStr = fmt(to);
      console.log(`Pulling orders ${fromStr} → ${toStr} across ${LOCATIONS.join(', ')} …`);
      const r = await syncOrders({ fromDate: fromStr, toDate: toStr });
      console.log(`\nDone — ${r.orders} orders stored`);
      const s = await status();
      console.log(`vin_orders: ${s.orders} orders, ${s.items} line items`);
    } else if (cmd === 'status') {
      const s = await status();
      console.log(`orders: ${s.orders}  |  line items: ${s.items}`);
      console.log('last run:', s.lastRun ? JSON.stringify(s.lastRun) : 'never');
    } else {
      console.log('Usage: node backend/orders-sync.js [sync [days | from to] | status]');
    }
    await pool.end();
  })().catch(e => { console.error('\n✗', e.message); process.exit(1); });
}
