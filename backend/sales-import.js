// ══════════════════════════════════════════════════════════════════════════
//  sales-import.js — load Vin eRetail order exports into vin_orders.
//
//  Vinculum's order API is blocked (OrgId not linked to the key), so sales come
//  from the dashboard's own "Order Enquiry → Export" instead — the same manual
//  route the SKU list already uses. This reads that export (converted to CSV)
//  and upserts one row per order. Re-running with a fresh export just updates.
//
//    node backend/sales-import.js data/vin-orders.csv
//
//  Only analytical fields are kept — no customer names, emails, phones or
//  street addresses. City/State stay for geography.
// ══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 4,
});

const COLUMNS = [
  'order_no', 'ext_order_no', 'order_date', 'order_type', 'status', 'order_amount',
  'voucher_code', 'voucher_amount', 'shipping_charges', 'ship_date', 'delivery_date',
  'ship_by_date', 'bill_city', 'bill_state', 'ship_city', 'ship_state',
];
const DATE_COLS = new Set(['order_date', 'ship_date', 'delivery_date', 'ship_by_date']);
const NUM_COLS = new Set(['order_amount', 'voucher_amount', 'shipping_charges']);

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vin_orders (
      order_no         VARCHAR(60)  NOT NULL PRIMARY KEY,
      ext_order_no     VARCHAR(120) NULL,
      order_date       DATETIME     NULL,
      order_type       VARCHAR(30)  NULL,
      status           VARCHAR(60)  NULL,
      order_amount     DECIMAL(12,2) NOT NULL DEFAULT 0,
      voucher_code     VARCHAR(60)  NULL,
      voucher_amount   DECIMAL(12,2) NOT NULL DEFAULT 0,
      shipping_charges DECIMAL(12,2) NOT NULL DEFAULT 0,
      ship_date        DATETIME     NULL,
      delivery_date    DATETIME     NULL,
      ship_by_date     DATETIME     NULL,
      bill_city        VARCHAR(120) NULL,
      bill_state       VARCHAR(120) NULL,
      ship_city        VARCHAR(120) NULL,
      ship_state       VARCHAR(120) NULL,
      imported_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_vin_orders_date   (order_date),
      KEY idx_vin_orders_status (status),
      KEY idx_vin_orders_type   (order_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// ── CSV parser: RFC-4180-ish, handles quoted fields with commas/newlines ──
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// "21/08/2026 12:39 PM" (DD/MM/YYYY hh:mm AM/PM) -> "YYYY-MM-DD HH:MM:SS" or null
function parseVinDate(s) {
  s = String(s || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
  if (!m) return null;
  let [, d, mo, y, hh, mm, ap] = m;
  let H = hh ? parseInt(hh, 10) : 0;
  if (ap) { const up = ap.toUpperCase(); if (up === 'PM' && H < 12) H += 12; if (up === 'AM' && H === 12) H = 0; }
  const p = n => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)} ${p(H)}:${p(mm || 0)}:00`;
}

async function importCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('empty CSV');
  const header = rows[0].map(h => h.trim());
  const colIdx = COLUMNS.map(c => header.indexOf(c));
  const missing = COLUMNS.filter((c, i) => colIdx[i] === -1);
  if (missing.length) throw new Error('CSV missing columns: ' + missing.join(', '));

  const values = [];
  for (let r = 1; r < rows.length; r++) {
    const raw = rows[r];
    if (!raw || !String(raw[colIdx[0]] || '').trim()) continue;   // no order_no
    values.push(COLUMNS.map((c, i) => {
      let v = raw[colIdx[i]];
      v = v === undefined ? '' : String(v).trim();
      if (DATE_COLS.has(c)) return parseVinDate(v);
      if (NUM_COLS.has(c)) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
      return v === '' ? null : v;
    }));
  }
  if (!values.length) throw new Error('no order rows found in CSV');

  // Upsert in chunks — a fresh export refreshes existing orders' status/dates.
  const setClause = COLUMNS.slice(1).map(c => `${c} = VALUES(${c})`).join(', ');
  const CHUNK = 500;
  for (let i = 0; i < values.length; i += CHUNK) {
    await pool.query(
      `INSERT INTO vin_orders (${COLUMNS.join(', ')}) VALUES ?
       ON DUPLICATE KEY UPDATE ${setClause}`,
      [values.slice(i, i + CHUNK)]);
  }
  return values.length;
}

module.exports = { pool, ensureTable, importCsv, parseVinDate };

// ── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const file = process.argv[2];
    if (!file) throw new Error('Usage: node backend/sales-import.js data/vin-orders.csv');
    await ensureTable();
    const n = await importCsv(file);
    const [[c]] = await pool.query('SELECT COUNT(*) n, ROUND(SUM(order_amount)) rev FROM vin_orders');
    console.log(`Imported ${n} orders from ${file}`);
    console.log(`vin_orders now holds ${c.n} orders, ₹${Number(c.rev).toLocaleString('en-IN')} total`);
    await pool.end();
  })().catch(e => { console.error('\n✗', e.message); process.exit(1); });
}
