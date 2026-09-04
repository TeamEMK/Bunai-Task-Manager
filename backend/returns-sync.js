// ══════════════════════════════════════════════════════════════════════════
//  returns-sync.js — pull Return / RTO orders from Vin eRetail into
//  vin_returns / vin_return_items.
//
//  Endpoint: POST v1/order/orderreturn — same auth as orderPullV2 (creds in the
//  FORM BODY: ApiKey / ApiOwner as fields, no OrgId, the APIUSER key). Read-only.
//  Vinculum caps one request at a 7-day date range (code 805), so the span is
//  walked in ≤7-day windows, and each window is paged with pageNumber.
//
//    node backend/returns-sync.js sync [days]            # default 90 days back
//    node backend/returns-sync.js sync 2026-06-01 2026-08-25
//    node backend/returns-sync.js status
// ══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const mysql = require('mysql2/promise');

const BASE        = (process.env.VIN_BASE_URL || 'https://bunai.vineretail.com/RestWS/api/eretail').replace(/\/+$/, '');
const ORDER_KEY   = process.env.VIN_ORDER_API_KEY   || '';
const ORDER_OWNER = process.env.VIN_ORDER_API_OWNER || 'APIUSER';
const PAGE_GAP_MS = Number(process.env.VIN_ORDER_PAGE_GAP_MS || 800);
// Return statuses to pull. Vinculum's own example used Confirmed + Closed.
const RETURN_STATUS = (process.env.VIN_RETURN_STATUS || 'Confirmed,Closed').split(',').map(s => s.trim()).filter(Boolean);

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME, waitForConnections: true, connectionLimit: 4,
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Schema ─────────────────────────────────────────────────────────────────
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vin_returns (
      return_no            VARCHAR(60)  NOT NULL PRIMARY KEY,
      return_type          VARCHAR(30)  NULL,
      status               VARCHAR(40)  NULL,
      return_amount        DECIMAL(12,2) NOT NULL DEFAULT 0,
      return_date          DATETIME     NULL,
      return_confirmdate   DATETIME     NULL,
      return_closedate     DATETIME     NULL,
      refund_date          DATETIME     NULL,
      refund_status        VARCHAR(60)  NULL,
      credit_note_no       VARCHAR(80)  NULL,
      order_no             VARCHAR(120) NULL,
      eretail_order_no     VARCHAR(60)  NULL,
      order_type           VARCHAR(20)  NULL,
      channel_name         VARCHAR(120) NULL,
      return_location      VARCHAR(40)  NULL,
      return_location_name VARCHAR(120) NULL,
      invoice_no           VARCHAR(120) NULL,
      delivery_no          VARCHAR(120) NULL,
      tracking_no          VARCHAR(120) NULL,
      return_tracking_no   VARCHAR(120) NULL,
      customer_code        VARCHAR(60)  NULL,
      customer_name        VARCHAR(200) NULL,
      customer_phone       VARCHAR(40)  NULL,
      customer_email       VARCHAR(160) NULL,
      customer_address     VARCHAR(500) NULL,
      customer_city        VARCHAR(120) NULL,
      customer_state       VARCHAR(120) NULL,
      customer_pincode     VARCHAR(20)  NULL,
      return_amount_cur    VARCHAR(10)  NULL,
      remarks              VARCHAR(500) NULL,
      refund_remarks       VARCHAR(500) NULL,
      ext_return_no        VARCHAR(120) NULL,
      ext_invoice_no       VARCHAR(120) NULL,
      total_lines          INT          NOT NULL DEFAULT 0,
      raw_json             LONGTEXT     NULL,
      synced_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_ret_date (return_date),
      KEY idx_ret_status (status),
      KEY idx_ret_type (return_type),
      KEY idx_ret_channel (channel_name),
      KEY idx_ret_order (eretail_order_no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vin_return_items (
      return_no      VARCHAR(60)  NOT NULL,
      line_no        VARCHAR(40)  NOT NULL,
      sku            VARCHAR(120) NULL,
      sku_name       VARCHAR(255) NULL,
      brand          VARCHAR(120) NULL,
      status         VARCHAR(60)  NULL,
      order_qty      DECIMAL(12,2) NOT NULL DEFAULT 0,
      return_qty     DECIMAL(12,2) NOT NULL DEFAULT 0,
      received_qty   DECIMAL(12,2) NOT NULL DEFAULT 0,
      unit_price     DECIMAL(12,2) NOT NULL DEFAULT 0,
      line_amount    DECIMAL(12,2) NOT NULL DEFAULT 0,
      discount_amt   DECIMAL(12,2) NOT NULL DEFAULT 0,
      tax_amount     DECIMAL(12,2) NOT NULL DEFAULT 0,
      taxable_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      hsn_code       VARCHAR(20)  NULL,
      return_reason  VARCHAR(255) NULL,
      PRIMARY KEY (return_no, line_no),
      KEY idx_ritem_sku (sku)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vin_return_sync_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      started_at DATETIME NOT NULL, ended_at DATETIME NULL,
      from_date VARCHAR(30) NULL, to_date VARCHAR(30) NULL,
      returns_seen INT NOT NULL DEFAULT 0, ok TINYINT(1) NOT NULL DEFAULT 0, error TEXT NULL
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
async function pullPage(fromDate, toDate, pageNumber) {
  if (!ORDER_KEY) throw new Error('VIN_ORDER_API_KEY not set (the APIUSER key)');
  const requestBody = JSON.stringify({
    order_no: [], return_no: [], customer_code: [], channel_code: [],
    tracking_no: '', return_tracking_no: '',
    status: RETURN_STATUS,
    date_from: fromDate, date_to: toDate,
    returnSource: '', pageNumber, filterBy: 'CHE', brand: [], returnType: ['1', '2'],
  });
  const form = new URLSearchParams();
  form.set('RequestBody', requestBody);
  form.set('ApiOwner', ORDER_OWNER);
  form.set('ApiKey', ORDER_KEY);

  const res = await fetch(`${BASE}/v1/order/orderreturn`, {
    method: 'POST',
    headers: { accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { throw new Error('Vin returned non-JSON: ' + text.slice(0, 160)); }
  return json;
}

// Pull every page for a date range.
async function pullRange(fromDate, toDate, onProgress) {
  const all = [];
  let page = 1, totalPages = 1;
  do {
    const j = await pullPage(fromDate, toDate, page);
    if (j.responseCode !== 0) {
      // 903 "Order Return Not Found" is the empty-window response, not an error.
      if (j.responseCode === 903 || /no record|not found/i.test(j.responseMessage || '')) break;
      throw new Error(`orderreturn ${j.responseCode}: ${j.responseMessage}`);
    }
    const r = j.response || {};
    const list = r.order || [];
    all.push(...list);
    totalPages = Number(r.totalPages) || 1;
    if (onProgress) onProgress(page, totalPages, all.length);
    page++;
    if (page <= totalPages) await sleep(PAGE_GAP_MS);
  } while (page <= totalPages);
  return all;
}

// ── Store ───────────────────────────────────────────────────────────────────
// Column → extractor. raw_json keeps the whole return object (minus items) so
// nothing the API returns is lost.
const RETURN_COLS = [
  ['return_no', o => o.return_no],
  ['return_type', o => o.return_type || null],
  ['status', o => o.status || null],
  ['return_amount', o => num(o.return_amount)],
  ['return_date', o => vinDate(o.return_date)],
  ['return_confirmdate', o => vinDate(o.return_confirmdate)],
  ['return_closedate', o => vinDate(o.return_closedate)],
  ['refund_date', o => vinDate(o.refund_date)],
  ['refund_status', o => o.refund_status || null],
  ['credit_note_no', o => o.creditNoteNo || null],
  ['order_no', o => o.order_no || null],
  ['eretail_order_no', o => o.eretailorder_no || null],
  ['order_type', o => o.order_type || null],
  ['channel_name', o => o.channelName || null],
  ['return_location', o => o.return_location || null],
  ['return_location_name', o => o.returnLocationName || null],
  ['invoice_no', o => o.invoice_no || null],
  ['delivery_no', o => o.delivery_no || null],
  ['tracking_no', o => o.tracking_no || null],
  ['return_tracking_no', o => o.return_tracking_no || null],
  ['customer_code', o => o.customerCode || null],
  ['customer_name', o => o.customer_name || null],
  ['customer_phone', o => o.customer_phone_no || null],
  ['customer_email', o => o.customer_email || null],
  ['customer_address', o => ([o.customer_address1, o.customer_address2, o.customer_address3, o.customer_address4].filter(Boolean).join(', ') || '').slice(0, 500) || null],
  ['customer_city', o => o.customer_city || null],
  ['customer_state', o => o.customer_state || null],
  ['customer_pincode', o => o.customer_pincode || null],
  ['return_amount_cur', o => o.orderCurrency || null],
  ['remarks', o => (o.remarks || '').slice(0, 500) || null],
  ['refund_remarks', o => (o.refund_remarks || '').slice(0, 500) || null],
  ['ext_return_no', o => o.extReturnNo || null],
  ['ext_invoice_no', o => o.extInvoiceNo || null],
  ['total_lines', o => Array.isArray(o.items) ? o.items.length : 0],
  ['raw_json', o => { const { items, ...rest } = o; return JSON.stringify(rest); }],
];

async function storeReturns(returns) {
  if (!returns.length) return 0;
  const cols = RETURN_COLS.map(c => c[0]);
  const rows = returns.map(o => RETURN_COLS.map(c => c[1](o)));
  const updates = cols.slice(1).map(c => `${c}=VALUES(${c})`).join(', ') + ', synced_at=CURRENT_TIMESTAMP';
  const CH = 200;
  for (let i = 0; i < rows.length; i += CH) {
    await pool.query(
      `INSERT INTO vin_returns (${cols.join(', ')}) VALUES ? ON DUPLICATE KEY UPDATE ${updates}`,
      [rows.slice(i, i + CH)]);
  }

  // Re-pull replaces a return's lines wholesale.
  for (const o of returns) {
    await pool.query('DELETE FROM vin_return_items WHERE return_no = ?', [o.return_no]);
    const items = Array.isArray(o.items) ? o.items : [];
    if (!items.length) continue;
    const itemRows = items.map(it => [
      o.return_no, String(it.lineno || it.orderLineNo || Math.random()),
      it.sku || null, it.skuName || null, it.brand || null, it.status || null,
      num(it.order_qty), num(it.return_qty), num(it.received_qty),
      num(it.line_unitprice), num(it.line_amt), num(it.discount_amt),
      num(it.igstAmt) + num(it.cgstAmt) + num(it.sgstAmt), num(it.taxableAmount),
      it.hsnCode || null, (it.return_reason || '').slice(0, 255) || null,
    ]);
    await pool.query(
      `INSERT INTO vin_return_items
        (return_no, line_no, sku, sku_name, brand, status, order_qty, return_qty,
         received_qty, unit_price, line_amount, discount_amt, tax_amount,
         taxable_amount, hsn_code, return_reason)
       VALUES ? ON DUPLICATE KEY UPDATE sku=VALUES(sku)`,
      [itemRows]);
  }
  return rows.length;
}

// ── Full sync over a range ──────────────────────────────────────────────────
function fmt(d) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

async function syncReturns({ fromDate, toDate } = {}) {
  await ensureTables();
  const started = (await pool.query('SELECT NOW() AS n'))[0][0].n;
  const [ins] = await pool.query(
    'INSERT INTO vin_return_sync_log (started_at, from_date, to_date) VALUES (?,?,?)',
    [started, fromDate, toDate]);
  const runId = ins.insertId;
  try {
    // orderreturn caps a request at a 7-day range (code 805) — walk in windows.
    const parse = s => { const [d, m, y] = s.split('/').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
    const fmtUTC = dt => { const p = n => String(n).padStart(2, '0'); return `${p(dt.getUTCDate())}/${p(dt.getUTCMonth() + 1)}/${dt.getUTCFullYear()}`; };
    const start = parse(fromDate), end = parse(toDate);
    let total = 0;
    for (let ws = new Date(start); ws <= end; ws = new Date(ws.getTime() + 7 * 86400000)) {
      let we = new Date(ws.getTime() + 6 * 86400000);
      if (we > end) we = new Date(end);
      const f = fmtUTC(ws), tt = fmtUTC(we);
      const returns = await pullRange(`${f} 00:00:01`, `${tt} 23:59:59`,
        (pg, tp, n) => log(`  ${f}–${tt}: page ${pg}/${tp}, ${n} returns`));
      total += await storeReturns(returns);
      await sleep(PAGE_GAP_MS);
    }
    await pool.query('UPDATE vin_return_sync_log SET ended_at=NOW(), returns_seen=?, ok=1 WHERE id=?', [total, runId]);
    return { returns: total };
  } catch (e) {
    await pool.query('UPDATE vin_return_sync_log SET ended_at=NOW(), ok=0, error=? WHERE id=?', [String(e.message).slice(0, 2000), runId]);
    throw e;
  }
}

function log(m) { if (process.env.NODE_ENV !== 'test') console.log(m); }

async function status() {
  const [[r]] = await pool.query('SELECT COUNT(*) n FROM vin_returns').catch(() => [[{ n: 0 }]]);
  const [[i]] = await pool.query('SELECT COUNT(*) n FROM vin_return_items').catch(() => [[{ n: 0 }]]);
  const [[l]] = await pool.query('SELECT started_at, ended_at, returns_seen, ok FROM vin_return_sync_log ORDER BY id DESC LIMIT 1').catch(() => [[null]]);
  return { returns: r.n, items: i.n, lastRun: l || null };
}

module.exports = { pool, ensureTables, syncReturns, pullRange, storeReturns, status };

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const [cmd, a, b] = process.argv.slice(2);
    if (cmd === 'sync') {
      const [[{ today }]] = await pool.query('SELECT CURDATE() AS today');
      const to = b ? new Date(b) : today;
      let from;
      if (a && b) from = new Date(a);
      else { const days = a ? Number(a) : 90; from = new Date(to.getTime() - days * 86400000); }
      const fromStr = fmt(from), toStr = fmt(to);
      console.log(`Pulling returns ${fromStr} → ${toStr} …`);
      const r = await syncReturns({ fromDate: fromStr, toDate: toStr });
      console.log(`\nDone — ${r.returns} returns stored`);
      const s = await status();
      console.log(`vin_returns: ${s.returns} returns, ${s.items} line items`);
    } else if (cmd === 'status') {
      const s = await status();
      console.log(`returns: ${s.returns}  |  line items: ${s.items}`);
      console.log('last run:', s.lastRun ? JSON.stringify(s.lastRun) : 'never');
    } else {
      console.log('Usage: node backend/returns-sync.js [sync [days | from to] | status]');
    }
    await pool.end();
  })().catch(e => { console.error('\n✗', e.message); process.exit(1); });
}
