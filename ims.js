// ════════════════════════════════════════════════════════════════════════
//  ims.js — Bunai IMS read layer for the Task Manager (admin-only).
//
//  This is a FAITHFUL port of the READ functions in your Apps Script Code.gs
//  (getDashboardData, getToBeOrderData, getSalesRankData, getSKUSalesData,
//   getTopProductsData) so the IMS dashboard runs natively inside the task
//   manager via a Google service account — no Apps Script web app needed.
//
//  The DAILY SYNC stays in your Apps Script (the 7AM trigger that writes the
//  sheets). This module only READS the same sheets, so your formulas/logic
//  on the Apps Script side are untouched.
//
//  SETUP (one time):
//   1. Service account: set env var GOOGLE_SERVICE_ACCOUNT_JSON to the full
//      JSON key (one line), OR GOOGLE_SERVICE_ACCOUNT_FILE to a path.
//   2. Share BOTH spreadsheets (IMS + Sales) with the service account email
//      (Viewer is enough).
//   3. Optional: IMS_TZ (default "Asia/Kolkata") only affects the 45-day window edge.
// ════════════════════════════════════════════════════════════════════════
const { google } = require('googleapis');

// ── Same IDs/constants as your Code.gs (so results match) ──
const IMS_SS_ID       = process.env.IMS_SS_ID   || '';
const SALES_SS_ID     = process.env.SALES_SS_ID || '';
const AVG_WINDOW_DAYS = 45;

// ── Service account auth (lazy, cached) ──
let _sheets = null;
// Look for a service-account key file the user dropped into the project
// (e.g. bunai/secrets/credentials.json). Never looks inside public/.
function findKeyFile() {
  const fs = require('fs'); const path = require('path');
  const names = ['service-account.json', 'serviceaccount.json', 'credentials.json',
                 'credential.json', 'sa-key.json', 'key.json', 'google-credentials.json'];
  const dirs = [path.join(__dirname, 'secrets'), __dirname];
  const list = [];
  if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) list.push(process.env.GOOGLE_SERVICE_ACCOUNT_FILE);
  for (const d of dirs) for (const n of names) list.push(path.join(d, n));
  for (const p of list) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return null;
}

function getServiceCreds() {
  let raw = null, source = '';
  const file = findKeyFile();
  if (file) {
    raw = require('fs').readFileSync(file, 'utf8');
    source = 'file ' + file;
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    source = 'GOOGLE_SERVICE_ACCOUNT_JSON';
  } else {
    throw new Error('IMS not configured: drop your service-account key file into the bunai/secrets/ folder (e.g. secrets/credentials.json), or set GOOGLE_SERVICE_ACCOUNT_FILE. Then share both sheets with the service account email.');
  }
  const creds = parseCreds(raw);
  if (!creds) {
    throw new Error('Service account key in ' + source + ' could not be parsed as JSON. Make sure it is the unmodified .json file downloaded from Google Cloud.');
  }
  if (!creds.client_email || !creds.private_key) {
    throw new Error('Service account key is missing client_email or private_key.');
  }
  return creds;
}

// Parse a service-account key that may have been mangled by an env-var UI
// (Hostinger etc. often backslash-escape the JSON because the private_key has
//  \n in it — which is what causes "Unexpected token \ in JSON at position 0").
function parseCreds(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  const tryParse = x => { try { return JSON.parse(x); } catch (_) { return null; } };
  let creds =
       tryParse(s)
    || tryParse(s.replace(/\\"/g, '"'))
    || tryParse(s.replace(/\\"/g, '"').replace(/\\([{}\[\],:])/g, '$1').replace(/^\\+/, ''));
  if (!creds) return null;
  if (creds.private_key && creds.private_key.indexOf('\\n') !== -1) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return creds;
}
async function sheets() {
  if (_sheets) return _sheets;
  const creds = getServiceCreds();
  // google-auth-library v9+ (bundled with googleapis v171) removed the legacy
  // positional constructor new JWT(email, keyFile, key, scopes). Passing
  // positional args silently leaves key/email unset and authorize() then throws
  // "No key or keyFile set". The options-object form below is the supported API.
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  await auth.authorize();
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

// ── Fetch one whole sheet as a rectangular 2D array (like GAS getValues) ──
// Cells: numbers stay numbers, text stays strings, empties become ''. Dates
// come back as serial numbers (handled by cellToDate where a date is expected).
async function fetchSheet(spreadsheetId, sheetName) {
  // Test seam (inert in production — global.__IMS_MOCK__ is never set there).
  if (global.__IMS_MOCK__) {
    const rows = global.__IMS_MOCK__[sheetName];
    if (!rows) throw new Error('mock missing sheet: ' + sheetName);
    let mc = 0; for (const r of rows) if (r.length > mc) mc = r.length;
    const padded = rows.map(r => { const o = r.slice(); while (o.length < mc) o.push(''); return o; });
    return { rows: padded, lastRow: padded.length, lastCol: mc };
  }
  const api = await sheets();
  const res = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName.replace(/'/g, "''")}'`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  });
  const raw = res.data.values || [];
  let maxCols = 0;
  for (const r of raw) if (r.length > maxCols) maxCols = r.length;
  const rows = raw.map(r => {
    const out = r.slice();
    for (let i = 0; i < out.length; i++) if (out[i] === null || out[i] === undefined) out[i] = '';
    while (out.length < maxCols) out.push('');
    return out;
  });
  return { rows, lastRow: rows.length, lastCol: maxCols };
}

// ── Date helpers (locale-proof: serial → UTC-midnight date) ──
function serialToDate(n) {
  const ms = Math.round(n) * 86400000 + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function cellToDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return v > 0 ? serialToDate(v) : null;
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}
function fmtMDY(d) { return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`; }
function fmtYMD(d) { const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`; }
function cutoffDate(days) {
  const d = new Date(Date.now() - days * 86400000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ════════════════════════════════════════════════════════════════════════
//  getDashboardData(fromStr, toStr)
// ════════════════════════════════════════════════════════════════════════
async function getDashboardData(fromStr, toStr) {
  try {
    const { rows, lastRow } = await fetchSheet(IMS_SS_ID, 'IMS');
    if (lastRow < 3) return { success: true, dates: [], skus: [] };

    const DATE_COL_START = 9;
    const headerRow = rows[1] || [];
    const dateColMap = {};
    const allDates = [];
    for (let i = DATE_COL_START - 1; i < headerRow.length; i++) {
      const d = cellToDate(headerRow[i]);
      if (!d) continue;
      const dateKey = fmtYMD(d);
      if (!(dateKey in dateColMap)) { dateColMap[dateKey] = i; allDates.push(dateKey); }
    }
    allDates.sort();
    const filteredDates = allDates.filter(d => d >= fromStr && d <= toStr);

    const data = rows.slice(2);
    const skus = [];
    for (const row of data) {
      const sku = String(row[1] || '').trim();
      if (!sku) continue;
      const stockByDate = {};
      for (const d of filteredDates) {
        const colIdx = dateColMap[d];
        const val = row[colIdx];
        stockByDate[d] = (val !== '' && val !== null && val !== undefined && !isNaN(parseFloat(val))) ? parseFloat(val) : 0;
      }
      skus.push({
        sku,
        productName: String(row[2] || '').trim(),
        maxLevel: parseFloat(row[5]) || 0,
        stockByDate,
      });
    }
    return { success: true, dates: filteredDates, skus };
  } catch (e) { return { success: false, error: e.message }; }
}

// ════════════════════════════════════════════════════════════════════════
//  getToBeOrderData()
// ════════════════════════════════════════════════════════════════════════
async function getToBeOrderData() {
  try {
    const { rows, lastRow } = await fetchSheet(IMS_SS_ID, 'IMS');
    if (lastRow < 3) return { success: true, orders: [] };
    const data = rows.slice(2);
    const orders = [];
    for (const row of data) {
      const sku = String(row[1] || '').trim();
      if (!sku) continue;
      orders.push({
        sku,
        productName: String(row[2] || '').trim(),
        leadTime: parseFloat(row[3]) || '',
        safetyFactor: parseFloat(row[4]) || '',
        todayStock: parseFloat(row[6]) || 0,
        toBeOrder: parseFloat(row[7]) || 0,
      });
    }
    return { success: true, orders };
  } catch (e) { return { success: false, error: e.message }; }
}

// ════════════════════════════════════════════════════════════════════════
//  getSalesRankData()
// ════════════════════════════════════════════════════════════════════════
async function getSalesRankData() {
  try {
    const SD_DATE = 13, SD_PRICE = 83, SD_QTY = 31, SD_SKU = 32, SD_SIZE = 42, RANK_DAYS = 45;
    const cutoff = cutoffDate(RANK_DAYS);

    const sales = await fetchSheet(SALES_SS_ID, 'Sales Data');
    if (sales.lastRow < 2) return { success: true, items: [] };
    const data = sales.rows.slice(1);

    const skuMap = {};
    for (const row of data) {
      const sku = String(row[SD_SKU] || '').trim();
      if (!sku) continue;
      const qty = parseFloat(row[SD_QTY]) || 0;
      if (qty <= 0) continue;
      const d = cellToDate(row[SD_DATE]);
      if (!d || d < cutoff) continue;
      const price = parseFloat(row[SD_PRICE]) || 0;
      if (!skuMap[sku]) skuMap[sku] = { totalQty: 0, totalValue: 0, sizes: {} };
      skuMap[sku].totalQty += qty;
      skuMap[sku].totalValue += price * qty;
      const sz = String(row[SD_SIZE] || '').trim().toUpperCase();
      if (sz) skuMap[sku].sizes[sz] = (skuMap[sku].sizes[sz] || 0) + qty;
    }

    const mrpMap = {};
    try {
      const pricing = await fetchSheet(SALES_SS_ID, 'Final Pricing');
      for (const row of pricing.rows.slice(1)) {
        const s = String(row[0] || '').trim();
        if (!s) continue;
        const mrp = parseFloat(row[8]) || 0;
        if (mrp > 0) mrpMap[s] = mrp;
      }
    } catch (e) {}

    const costMap = {};
    try {
      const cost = await fetchSheet(SALES_SS_ID, 'Cost');
      for (const row of cost.rows.slice(1)) {
        const s = String(row[1] || '').trim();
        if (!s) continue;
        const c = parseFloat(row[5]) || 0;
        if (c > 0) costMap[s] = c;
      }
    } catch (e) {}

    const imsRes = await getToBeOrderData();
    const imsMap = {};
    if (imsRes.success) for (const o of imsRes.orders) imsMap[o.sku] = o;

    const items = [];
    for (const sku in skuMap) {
      const s = skuMap[sku];
      const avgPrice = s.totalQty > 0 ? Math.round(s.totalValue / s.totalQty) : 0;
      const sizesArr = Object.keys(s.sizes).map(k => ({ size: k, count: s.sizes[k] })).sort((a, b) => b.count - a.count);
      const ims = imsMap[sku];
      items.push({
        sku,
        productName: ims ? ims.productName : '',
        totalSales: s.totalQty,
        sizes: sizesArr,
        salePrice: avgPrice,
        mrp: mrpMap[sku] || 0,
        cost: costMap[sku] || 0,
        todayStock: ims ? ims.todayStock : null,
        leadTime: ims ? ims.leadTime : '',
        safetyFactor: ims ? ims.safetyFactor : '',
        toBeOrder: ims ? ims.toBeOrder : 0,
      });
    }
    items.sort((a, b) => b.totalSales - a.totalSales);
    return { success: true, items };
  } catch (e) { return { success: false, error: e.message }; }
}

// ════════════════════════════════════════════════════════════════════════
//  getSKUSalesData(masterSku, productName, imsOrders)
// ════════════════════════════════════════════════════════════════════════
async function getSKUSalesData(masterSku, productName, imsOrders) {
  try {
    const SD_DATE = 13, SD_PRICE = 83, SD_QTY = 31, SD_SKU = 32, SD_SIZE = 42, RANK_DAYS = 45;
    const cutoff = cutoffDate(RANK_DAYS);

    const productNameNorm = String(productName || '').trim().toUpperCase();
    const relatedSkus = {};
    if (imsOrders && imsOrders.length) {
      for (const o of imsOrders) {
        const pn = String(o.productName || '').trim().toUpperCase();
        if (pn && pn === productNameNorm) relatedSkus[o.sku] = o;
      }
    }
    if (Object.keys(relatedSkus).length === 0) relatedSkus[masterSku] = null;

    const sales = await fetchSheet(SALES_SS_ID, 'Sales Data');
    if (sales.lastRow < 2) return { success: true, sizes: [], days: RANK_DAYS, productName, dateColFound: true };
    const data = sales.rows.slice(1);

    const sizeMap = {};
    let dateColFound = true;
    for (const row of data) {
      const sku = String(row[SD_SKU] || '').trim();
      if (!sku || !(sku in relatedSkus)) continue;
      const qty = parseFloat(row[SD_QTY]) || 0;
      if (qty <= 0) continue;
      const d = cellToDate(row[SD_DATE]);
      if (!d) { dateColFound = false; continue; }
      if (d < cutoff) continue;
      const price = parseFloat(row[SD_PRICE]) || 0;
      const sz = String(row[SD_SIZE] || '').trim().toUpperCase() || '—';
      if (!sizeMap[sku]) sizeMap[sku] = { qty: 0, value: 0, size: sz };
      sizeMap[sku].qty += qty;
      sizeMap[sku].value += price * qty;
    }
    for (const sku in relatedSkus) if (!sizeMap[sku]) sizeMap[sku] = { qty: 0, value: 0, size: '—' };

    const sizes = [];
    for (const sku in sizeMap) {
      const m = sizeMap[sku];
      const ims = relatedSkus[sku];
      sizes.push({
        size: m.size,
        totalSales: m.qty,
        imsSku: sku,
        imsStock: ims ? ims.todayStock : null,
        leadTime: ims ? ims.leadTime : '',
        safetyFactor: ims ? ims.safetyFactor : '',
        toBeOrder: ims ? ims.toBeOrder : 0,
        salePrice: m.qty > 0 ? Math.round(m.value / m.qty) : 0,
        cost: 0,
      });
    }
    sizes.sort((a, b) => b.totalSales - a.totalSales);
    return { success: true, sizes, days: RANK_DAYS, productName, dateColFound };
  } catch (e) { return { success: false, error: e.message }; }
}

// ════════════════════════════════════════════════════════════════════════
//  getOrderedQtyMap()  (Order tab → pending/done per entry)
// ════════════════════════════════════════════════════════════════════════
async function getOrderedQtyMap() {
  const out = [];
  try {
    const { rows, lastRow } = await fetchSheet(IMS_SS_ID, 'Order');
    if (lastRow < 2) return out;
    for (const row of rows.slice(1)) {
      const model = String(row[3] || '').trim().toUpperCase();
      const name  = String(row[4] || '').trim().toUpperCase();
      const qty   = parseFloat(row[5]) || 0;
      if (qty <= 0) continue;
      const done  = String(row[6] || '').trim().toLowerCase() === 'yes';
      out.push({ model, name, qty, done });
    }
  } catch (e) { /* Order tab missing -> return what we have */ }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
//  getTopProductsData()
// ════════════════════════════════════════════════════════════════════════
async function getTopProductsData() {
  try {
    const orderEntries = await getOrderedQtyMap();

    const tag = await fetchSheet(IMS_SS_ID, 'Taging');
    if (tag.lastRow < 2) return { success: true, products: [] };
    const tagData = tag.rows.slice(1).map(r => [r[0], r[1]]);

    const taggedNames = new Set();
    const modelToNameUpper = {};
    for (const row of tagData) {
      const model = String(row[0] || '').trim().toUpperCase();
      const name  = String(row[1] || '').trim();
      if (name) taggedNames.add(name.toUpperCase());
      if (model && name) modelToNameUpper[model] = name.toUpperCase();
    }
    if (taggedNames.size === 0) return { success: true, products: [] };

    const orderedByProduct = {};
    for (const e of orderEntries) {
      let nameUp = (e.name && e.name !== '#N/A' && e.name !== '#REF!') ? e.name : '';
      if (!nameUp && e.model) nameUp = modelToNameUpper[e.model] || '';
      if (!nameUp) continue;
      if (!orderedByProduct[nameUp]) orderedByProduct[nameUp] = { pending: 0, done: 0 };
      if (e.done) orderedByProduct[nameUp].done += e.qty;
      else orderedByProduct[nameUp].pending += e.qty;
    }

    // 45-day avg daily sales per SKU + size lookup
    const salesSkuAvgMap = {};
    const skuSizeMap = {};
    try {
      const SD_DATE = 13, SD_QTY = 31, SD_SKU = 32, SD_SIZE = 42;
      const cutoff = cutoffDate(AVG_WINDOW_DAYS);
      const sales = await fetchSheet(SALES_SS_ID, 'Sales Data');
      if (sales.lastRow >= 2) {
        const sData = sales.rows.slice(1);
        const tempMap = {};
        for (const row of sData) {
          const sku = String(row[SD_SKU] || '').trim();
          if (!sku) continue;
          if (!skuSizeMap[sku]) {
            const sz = String(row[SD_SIZE] || '').trim().toUpperCase();
            if (sz) skuSizeMap[sku] = sz;
          }
          const qty = parseFloat(row[SD_QTY]) || 0;
          if (qty <= 0) continue;
          const d = cellToDate(row[SD_DATE]);
          if (!d || d < cutoff) continue;
          if (!tempMap[sku]) tempMap[sku] = { total: 0 };
          tempMap[sku].total += qty;
        }
        for (const sku in tempMap) salesSkuAvgMap[sku] = tempMap[sku].total / AVG_WINDOW_DAYS;
      }
    } catch (e) { /* sales fetch failed -> avg defaults to 0 */ }

    const ims = await fetchSheet(IMS_SS_ID, 'IMS');
    if (ims.lastRow < 3) return { success: true, products: [] };
    const DATE_COL_START = 9;
    const headerRow = ims.rows[1] || [];
    const dateHeaders = [];
    for (let i = DATE_COL_START - 1; i < headerRow.length; i++) {
      const d = cellToDate(headerRow[i]);
      if (d) dateHeaders.push({ key: fmtYMD(d), colIdx: i });
    }
    const recentDates = dateHeaders.slice(-30);

    const imsData = ims.rows.slice(2);
    const productMap = {};
    for (const row of imsData) {
      const sku = String(row[1] || '').trim();
      const productName = String(row[2] || '').trim();
      if (!sku || !productName) continue;
      const nameUpper = productName.toUpperCase();
      if (!taggedNames.has(nameUpper)) continue;

      const leadTime = parseFloat(row[3]) || 0;
      const safetyStock = parseFloat(row[4]) || 0;
      const maxLevel = parseFloat(row[5]) || 0;
      const todayStock = parseFloat(row[6]) || 0;
      const toBeOrder = parseFloat(row[7]) || 0;
      const avgDailySales = salesSkuAvgMap[sku] || 0;

      const orderPoint = (safetyStock > 0 || (avgDailySales > 0 && leadTime > 0))
        ? Math.round(safetyStock + (avgDailySales * leadTime)) : 0;
      const belowOrderPoint = orderPoint > 0 && todayStock < orderPoint;
      const nearMaxAlert = maxLevel > 20 && todayStock < (maxLevel - 20);

      const stockHistory = {};
      for (const dh of recentDates) {
        const val = row[dh.colIdx];
        stockHistory[dh.key] = (val !== '' && val !== null && val !== undefined && !isNaN(parseFloat(val))) ? parseFloat(val) : 0;
      }

      if (!productMap[productName]) {
        productMap[productName] = {
          productName, skus: [], totalStock: 0, totalToBeOrder: 0, rawTotalToBeOrder: 0,
          orderedPending: 0, orderedDone: 0, totalMaxLevel: 0, totalOrderPoint: 0,
          totalAvgDailySales: 0, anyNearMaxAlert: false, anyBelowOrderPoint: false,
        };
      }
      productMap[productName].skus.push({
        sku, size: skuSizeMap[sku] || '', leadTime, safetyStock, maxLevel, todayStock, toBeOrder,
        stockHistory, avgDailySales: Math.round(avgDailySales * 100) / 100, orderPoint, belowOrderPoint, nearMaxAlert,
      });
      productMap[productName].totalStock += todayStock;
      productMap[productName].totalToBeOrder += toBeOrder;
      productMap[productName].totalMaxLevel += maxLevel;
      productMap[productName].totalOrderPoint += orderPoint;
      productMap[productName].totalAvgDailySales += avgDailySales;
      if (belowOrderPoint) productMap[productName].anyBelowOrderPoint = true;
      if (nearMaxAlert) productMap[productName].anyNearMaxAlert = true;
    }

    const orderedProducts = [];
    const seen = new Set();
    for (const row of tagData) {
      const name = String(row[1] || '').trim();
      if (!name) continue;
      const matchedKey = Object.keys(productMap).find(k => k.toUpperCase() === name.toUpperCase());
      if (matchedKey && !seen.has(matchedKey)) {
        seen.add(matchedKey);
        const prod = productMap[matchedKey];
        prod.totalAvgDailySales = Math.round(prod.totalAvgDailySales * 100) / 100;
        const ordered = orderedByProduct[matchedKey.toUpperCase()] || { pending: 0, done: 0 };
        prod.orderedPending = ordered.pending;
        prod.orderedDone = ordered.done;
        prod.rawTotalToBeOrder = prod.totalToBeOrder;
        prod.totalToBeOrder = Math.max(0, prod.rawTotalToBeOrder - prod.orderedPending);
        orderedProducts.push(prod);
      }
    }

    return {
      success: true, products: orderedProducts,
      recentDates: recentDates.map(d => d.key),
      totalTagged: taggedNames.size, totalMatched: orderedProducts.length,
    };
  } catch (e) { return { success: false, error: e.message }; }
}

// Map of callable functions exposed to the (admin-only) API.
const HANDLERS = {
  getDashboardData,
  getToBeOrderData,
  getSalesRankData,
  getSKUSalesData,
  getTopProductsData,
  // getOrderedQtyMap is internal (used by getTopProductsData), not exposed.
};

module.exports = { HANDLERS, getServiceCreds };
