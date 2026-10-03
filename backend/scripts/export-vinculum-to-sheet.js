// ════════════════════════════════════════════════════════════════════════
//  export-vinculum-to-sheet.js — Vin eRetail ka saara data ek Google Sheet
//  mein, platform Unicommerce par shift hone se pehle.
//
//    node backend/scripts/export-vinculum-to-sheet.js [sheetId]
//
//  WHY: Vinculum chhodne ke baad uska historical data kahin nahi bachega —
//  Unicommerce mein purana transactional data migrate nahi hota. Yeh sheet
//  us data ka portable archive hai, jise baad mein Unicommerce ke naye data
//  ke saath wapas DB mein jodna hai.
//
//  Teen tab, jaisa maanga gaya: Stock, Sales, Returns.
//    Stock   — ek row per (sku, warehouse); aaj ka snapshot
//    Sales   — ek row per order LINE (orders × items joined)
//    Returns — ek row per return LINE (returns × items joined)
//
//  Sales/Returns line level par flatten kiye hain kyunki yeh archive baad
//  mein wapas import hoga — line level se order level nikal sakte hain, ulta
//  nahi. Zyadatar orders single-line hain, to duplication na ke barabar hai.
//
//  raw_json column chhoda hai: har row mein poora API response dobara rakhna
//  sheet ko bhaari karta hai aur woh DB mein waise bhi maujood hai.
//
//  Idempotent — har run tab ko clear karke dobara likhta hai, to cutover se
//  pehle jitni baar chahe chala sakte hain.
// ════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');
const { getWriteClient, serviceAccountEmail } = require(path.join(__dirname, '..', 'src', 'services', 'google'));

const SHEET_ID = process.argv[2] || process.env.VIN_ARCHIVE_SHEET_ID || '';

// Sheets ek request mein bahut saare cells nahi leta; itne rows par comfortable hai.
const CHUNK = 2000;

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: String(process.env.DB_SSL) === 'true' ? { rejectUnauthorized: false } : undefined,
  waitForConnections: true,
  connectionLimit: 4,
});

// Date ko string bana kar bhejte hain. Raw Date object JSON ke through UTC ISO
// ban jaata hai aur sheet mein galat din dikha sakta hai; yahan local (IST)
// ke hisaab se pehle hi format kar lete hain.
function cell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate()) + ' ' +
           p(v.getHours()) + ':' + p(v.getMinutes()) + ':' + p(v.getSeconds());
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

async function fetchTable(sql) {
  const [rows] = await pool.query(sql);
  if (!rows.length) return { headers: [], values: [] };
  const headers = Object.keys(rows[0]);
  const values = rows.map(r => headers.map(h => cell(r[h])));
  return { headers, values };
}

// ── Tab maujood karao ────────────────────────────────────────────────────
async function ensureTab(sheets, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const found = (meta.data.sheets || []).find(s => s.properties.title === title);
  if (found) return found.properties.sheetId;

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

// Naya tab default 1000 × 26 ka hota hai, aur usse bahar likhne par Sheets
// "exceeds grid limits" de deta hai — rows apne aap nahi badhte. Isliye
// likhne se pehle grid ko zaroorat ke naap par set karte hain.
async function resizeGrid(sheets, sheetId, rows, cols) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { rowCount: rows, columnCount: cols } },
          fields: 'gridProperties.rowCount,gridProperties.columnCount',
        },
      }],
    },
  });
}

async function writeTab(sheets, title, headers, values) {
  const sheetId = await ensureTab(sheets, title);
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: title + '!A:ZZ' });

  if (!headers.length) {
    console.log('  ' + title.padEnd(9) + ' — koi data nahi');
    return;
  }

  // +1 header ke liye, thoda margin taaki agli baar resize na karna pade.
  await resizeGrid(sheets, sheetId, values.length + 10, Math.max(headers.length, 26));

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: title + '!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [headers] },
  });

  for (let i = 0; i < values.length; i += CHUNK) {
    const slice = values.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: title + '!A' + (i + 2),
      valueInputOption: 'RAW',
      requestBody: { values: slice },
    });
    process.stdout.write('\r  ' + title.padEnd(9) + ' ' +
      Math.min(i + CHUNK, values.length) + '/' + values.length + ' rows');
  }
  console.log('\r  ' + title.padEnd(9) + ' ' + values.length + ' rows, ' +
    headers.length + ' columns   ');
}

// ── Queries ──────────────────────────────────────────────────────────────
// Column list haath se likhi hai (SELECT * nahi) taaki raw_json bahar rahe
// aur order/item ke ek jaise naam (status) alag-alag dikhein.

const STOCK_SQL = `
  SELECT i.sku, s.description, i.warehouse, i.qty, i.synced_at
    FROM vin_inventory i
    LEFT JOIN vin_skus s ON s.sku = i.sku
   ORDER BY i.sku, i.warehouse`;

const SALES_SQL = `
  SELECT o.order_id, o.ext_order_no, o.order_date, o.status AS order_status,
         o.payment_method, o.order_amount, o.order_currency,
         o.channel_name, o.channel_code, o.order_source, o.order_type,
         o.ship_by_date, o.ship_date, o.delivery_date, o.updated_date,
         o.fulfillment_loc, o.total_lines,
         o.customer_name, o.customer_phone, o.customer_email, o.customer_gstin,
         o.ship_address, o.ship_city, o.ship_state, o.ship_pincode, o.ship_country,
         o.bill_name, o.bill_city, o.bill_state, o.bill_pincode,
         o.discount_amount, o.tax_amount, o.shipping_charges, o.cod_charge,
         o.collectible_amount, o.store_credit, o.voucher_code, o.promo_name,
         o.is_verified, o.is_on_hold, o.is_replacement,
         o.order_remarks, o.cancel_remark, o.pickup_location, o.distribution_type,
         it.line_no, it.sku, it.sku_name, it.brand, it.status AS item_status,
         it.order_qty, it.shipped_qty, it.cancelled_qty, it.return_qty,
         it.unit_price, it.discount_amt AS item_discount, it.tax_amount AS item_tax,
         o.synced_at
    FROM vin_orders o
    LEFT JOIN vin_order_items it ON it.order_id = o.order_id
   ORDER BY o.order_date, o.order_id, it.line_no`;

const RETURNS_SQL = `
  SELECT r.return_no, r.return_type, r.status AS return_status,
         r.return_amount, r.return_date, r.return_confirmdate, r.return_closedate,
         r.refund_date, r.refund_status, r.credit_note_no,
         r.order_no, r.eretail_order_no, r.order_type, r.channel_name,
         r.return_location, r.return_location_name,
         r.invoice_no, r.delivery_no, r.tracking_no, r.return_tracking_no,
         r.customer_code, r.customer_name, r.customer_phone, r.customer_email,
         r.customer_address, r.customer_city, r.customer_state, r.customer_pincode,
         r.return_amount_cur, r.remarks, r.refund_remarks,
         r.ext_return_no, r.ext_invoice_no, r.total_lines,
         it.line_no, it.sku, it.sku_name, it.brand, it.status AS item_status,
         it.order_qty, it.return_qty, it.received_qty,
         it.unit_price, it.line_amount, it.discount_amt AS item_discount,
         it.tax_amount AS item_tax, it.taxable_amount, it.hsn_code, it.return_reason,
         r.synced_at
    FROM vin_returns r
    LEFT JOIN vin_return_items it ON it.return_no = r.return_no
   ORDER BY r.return_date, r.return_no, it.line_no`;

(async () => {
  if (!SHEET_ID) {
    throw new Error('Sheet id chahiye: node backend/scripts/export-vinculum-to-sheet.js <sheetId>');
  }

  console.log('Sheet    : ' + SHEET_ID);
  console.log('Service  : ' + (serviceAccountEmail() || '(unknown)') + '\n');

  const sheets = await getWriteClient();

  // Access pehle check — warna teen bhaari query chala kar aakhir mein 403 milta.
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    console.log('Khul gayi: "' + meta.data.properties.title + '"\n');
  } catch (e) {
    const who = serviceAccountEmail() || 'the service account';
    throw new Error('Sheet nahi khul rahi (' + (e.code || e.message) + '). ' +
      'Sheet ko ' + who + ' ke saath Editor banakar share karein.');
  }

  console.log('DB se padh raha hoon ...');
  const stock   = await fetchTable(STOCK_SQL);
  const sales   = await fetchTable(SALES_SQL);
  const returns = await fetchTable(RETURNS_SQL);
  console.log('  Stock ' + stock.values.length + ' · Sales ' + sales.values.length +
              ' · Returns ' + returns.values.length + '\n');

  console.log('Sheet mein likh raha hoon ...');
  await writeTab(sheets, 'Stock',   stock.headers,   stock.values);
  await writeTab(sheets, 'Sales',   sales.headers,   sales.values);
  await writeTab(sheets, 'Returns', returns.headers, returns.values);

  console.log('\nHo gaya — https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit');
  await pool.end();
})().catch(async e => {
  console.error('\n✗', e.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
