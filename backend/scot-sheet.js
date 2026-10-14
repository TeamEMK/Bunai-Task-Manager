// ══════════════════════════════════════════════════════
// SCOT SHEET — writing the calling list into the client's spreadsheet.
//
// The same list the SCOT page shows, kept in the sheet the team actually rings
// from. The page reads the database and is always current; this pushes it out
// so nobody has to ask for a refresh.
//
// Two tabs, on two rhythms:
//
//   SCOT Sheet     — 3,850 customers who bought in the last 12 months, with a
//                    day-by-day grid. Rewritten daily, because the grid gains
//                    a column every day and the rhythm behind "call on" moves.
//
//   SCOT Lifetime  — all 252,000 customers, no grid. Rewritten weekly. It is
//                    fifty API calls and the figures behind it barely move in
//                    a day; daily would spend the Sheets quota on nothing.
//
// Customer-level figures come from sfy_customers, already rolled up by the
// Shopify sync. Only the grid goes back to the orders, and only for the 364
// days it covers.
// ══════════════════════════════════════════════════════
const { db } = require('./src/db/pool');
const google = require('./src/services/google');
const config = require('./src/config');

const FIRST_ROW = 5;        // first SCOT data row
const DASH_FIRST = 2;       // its Dashboard counterpart
const GRID_START = 13;      // column N
const GRID_COLS = 364;      // N to NM, which is what the sheet holds
const LIFETIME_CHUNK = 5000;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const colName = (i) => { let s = '', n = i; while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } return s; };
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const dmy = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d}-${MON[m - 1]}-${y}`; };

const sheetId = () => (config.sheets.scot && config.sheets.scot.id) || '';

// "Last updated: 14-Oct-2026, 1:11 PM IST", for the sheet to say about itself.
// A sheet that fills itself overnight gives no sign of whether it did, and
// the only way to find out was to ask someone with access to the logs. The
// time is the moment the write finished, written last, so a half-finished run
// leaves the previous stamp standing rather than a false new one.
function stampText(at = new Date()) {
  const [date, time] = at.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).split(' ');
  const [y, m, d] = date.split('-').map(Number);
  let [hh, mm] = time.split(':').map(Number);
  const ap = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 || 12;
  return `Last updated: ${d}-${MON[m - 1]}-${y}, ${hh}:${String(mm).padStart(2, '0')} ${ap} IST`;
}

// A tab made with exactly the table's width has no column to put a note in.
// Grows it, never shrinks it.
async function ensureCols(sheets, id, tab, want) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
  const t = meta.data.sheets.find(x => x.properties.title === tab);
  if (!t) throw new Error(`the sheet has no tab called "${tab}"`);
  const have = t.properties.gridProperties.columnCount;
  if (have < want) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [
      { appendDimension: { sheetId: t.properties.sheetId, dimension: 'COLUMNS', length: want - have } }] } });
  }
}

async function stamp(sheets, id, tab, cell, at) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: id, range: `'${tab}'!${cell}`,
    valueInputOption: 'RAW', requestBody: { values: [[stampText(at)]] },
  });
}

// The Dashboard's formulas, verbatim from the sheet. {S} is the SCOT row each
// one covers, {D} its own row. Only the numbers are made to agree; none of
// their logic is reinvented here.
const DASH_COLS = [
  `=IFERROR('SCOT Sheet'!A{S},"")`,
  `=IFERROR('SCOT Sheet'!B{S},"")`,
  `=IFERROR('SCOT Sheet'!I{S},"")`,
  `=IFERROR('SCOT Sheet'!J{S},"")`,
  `=IFERROR('SCOT Sheet'!K{S},"")`,
  `=IF(B{D}="","",IFERROR(MAX(FILTER('SCOT Sheet'!$N$4:$NM$4,ISNUMBER('SCOT Sheet'!N{S}:NM{S}))),""))`,
  `=IF(B{D}="","",IFERROR(INDEX(FILTER('SCOT Sheet'!N{S}:NM{S},ISNUMBER('SCOT Sheet'!N{S}:NM{S})),1,COUNT('SCOT Sheet'!N{S}:NM{S})),""))`,
  `=IF(F{D}="","",TODAY()-F{D})`,
  `=IF(B{D}="","",COUNT('SCOT Sheet'!N{S}:NM{S}))`,
  `=IF(B{D}="","",SUM('SCOT Sheet'!N{S}:NM{S}))`,
  `=IFERROR(J{D}/I{D},"")`,
  `=IF(F{D}="","",F{D}+IFERROR(VALUE(REGEXEXTRACT(TO_TEXT(E{D}),"\\d+")),7))`,
  `=IF(B{D}="","",IFERROR(MIN(FILTER('SCOT Sheet'!$N$4:$NM$4,ISNUMBER('SCOT Sheet'!N{S}:NM{S}))),""))`,
  `=IF(OR(M{D}="",I{D}<2),"",ROUND((F{D}-M{D})/(I{D}-1),1))`,
  `=IF(M{D}="","",IFERROR(J{D}/MAX(1,TODAY()-M{D}+1),""))`,
  `=IFERROR(O{D}*7,"")`,
  `=IF(B{D}="","",IFS(F{D}="","No Order Yet",L{D}="","Set Frequency",TODAY()-L{D}>IFERROR(VALUE(REGEXEXTRACT(TO_TEXT(E{D}),"\\d+")),7),"LOST - Escalate",TODAY()>L{D},"OVERDUE - Call Now",TODAY()>=L{D}-2,"Due Soon",TRUE,"On Track"))`,
];

async function ensureLog() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS scot_sheet_log (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      started_at DATETIME NOT NULL,
      ended_at   DATETIME NULL,
      tab        VARCHAR(40) NOT NULL,
      rows_sent  INT NOT NULL DEFAULT 0,
      ok         TINYINT(1) NOT NULL DEFAULT 0,
      error      TEXT NULL,
      KEY idx_scot_sl (tab, started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// Has this tab already been written inside the last `hours`? The sync runs
// eight times a day and the sheet does not need writing eight times.
async function writtenRecently(tab, hours) {
  const r = await db.one(
    `SELECT 1 n FROM scot_sheet_log
      WHERE tab = ? AND ok = 1 AND started_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)
      LIMIT 1`, [tab, hours]);
  return !!r;
}

async function logRun(tab) {
  const [r] = await db.query(
    'INSERT INTO scot_sheet_log (started_at, tab) VALUES (UTC_TIMESTAMP(), ?)', [tab]);
  return r.insertId;
}
const logDone = (id, rows) => db.query(
  'UPDATE scot_sheet_log SET ended_at=UTC_TIMESTAMP(), rows_sent=?, ok=1 WHERE id=?', [rows, id]);
const logFail = (id, err) => db.query(
  'UPDATE scot_sheet_log SET ended_at=UTC_TIMESTAMP(), ok=0, error=? WHERE id=?',
  [String(err).slice(0, 2000), id]);

// ── The 12-month tab ──────────────────────────────────
async function writeScotSheet({ log = () => {} } = {}) {
  const id = sheetId();
  if (!id) return { skipped: 'no sheet configured' };

  const runId = await logRun('SCOT Sheet');
  try {
    const d = await db.one(
      `SELECT DATE_FORMAT(DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE), '%Y-%m-%d') today,
              DATE_FORMAT(DATE_SUB(DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE),
                                   INTERVAL ${GRID_COLS - 1} DAY), '%Y-%m-%d') from_d`);

    // Lifetime figures: already rolled up, one row each.
    const cust = await db.rows(
      `SELECT phone, name, email, orders, units, value, gap_days,
              DATE_FORMAT(first_order, '%Y-%m-%d') first_order,
              DATE_FORMAT(last_order, '%Y-%m-%d') last_order
         FROM sfy_customers
        WHERE last_order >= ?
        ORDER BY value DESC`, [d.from_d]);

    // The grid: only the window it covers, not eight years of orders.
    const KEY = `RIGHT(REGEXP_REPLACE(COALESCE(o.customer_phone,''), '[^0-9]', ''), 10)`;
    const grid = await db.rows(
      `SELECT ${KEY} k, DATE_FORMAT(DATE(o.order_date), '%Y-%m-%d') d,
              ROUND(SUM(o.order_amount)) amt
         FROM sfy_orders o
        WHERE o.order_date >= ? AND o.cancelled_at IS NULL AND LENGTH(${KEY}) = 10
        GROUP BY k, d`, [d.from_d]);
    const cells = new Map();
    grid.forEach((g) => {
      if (!cells.has(g.k)) cells.set(g.k, {});
      cells.get(g.k)[g.d] = Number(g.amt) || 0;
    });

    const sheets = await google.getWriteClient();
    const lastCol = colName(GRID_START + GRID_COLS - 1);
    const dayIndex = (iso) =>
      GRID_START + Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(d.from_d + 'T00:00:00Z')) / 86400000);

    // Row 4: the fixed headings, then every date the grid now covers. Written
    // as real dates — the Dashboard takes the last order date with
    // MAX(FILTER(row 4 ...)), and over text that returns zero.
    const header = new Array(GRID_START + GRID_COLS).fill('');
    ['S. No.', 'Client Name', 'Contact No.', 'Customer Since', 'Lifetime Units',
     'Lifetime Orders', 'Email Id', 'Lifetime Value', 'Average Order Value',
     'Order Frequency', 'Usual Order Days', 'Date for calling', 'Frequency Of Calling']
      .forEach((h, i) => { header[i] = h; });
    for (let i = 0; i < GRID_COLS; i++) header[GRID_START + i] = addDays(d.from_d, i);

    const rows = cust.map((r, i) => {
      const line = new Array(GRID_START + GRID_COLS).fill('');
      const gap = r.gap_days == null ? null : Number(r.gap_days);
      const n = Number(r.orders);
      line[0] = '=ROW()-4';
      line[1] = r.name || '(no name)';
      line[2] = r.phone;
      line[3] = r.first_order;
      line[4] = Number(r.units) || 0;
      line[5] = n;
      line[6] = r.email || '';
      line[7] = Math.round(Number(r.value) || 0);
      line[8] = n ? Math.round(Number(r.value) / n) : '';
      line[9] = n === 1 ? 'One-time' : gap <= 10 ? 'Weekly' : gap <= 20 ? '15 days'
                : gap <= 45 ? 'Monthly' : 'Occasional';
      line[10] = gap == null ? '' : gap;
      line[11] = `=IFERROR(Dashboard!L${DASH_FIRST + i},"")`;
      line[12] = `=IFERROR(Dashboard!H${DASH_FIRST + i},"")`;
      for (const [day, v] of Object.entries(cells.get(r.phone) || {})) {
        const idx = dayIndex(day);
        if (idx >= GRID_START && idx < GRID_START + GRID_COLS) line[idx] = v;
      }
      return line;
    });

    const dash = rows.map((_, i) =>
      DASH_COLS.map(f => f.replace(/\{S\}/g, FIRST_ROW + i).replace(/\{D\}/g, DASH_FIRST + i)));

    // Room for the rows, on both tabs — the Dashboard's formulas are one per
    // SCOT row, and a short Dashboard leaves later customers with no calling
    // date at all.
    await ensureRows(sheets, id, {
      'SCOT Sheet': rows.length + FIRST_ROW + 1,
      Dashboard: rows.length + DASH_FIRST + 1,
    });

    for (const range of [`'SCOT Sheet'!A${FIRST_ROW}:NM100000`, `'Dashboard'!A${DASH_FIRST}:Q100000`]) {
      await sheets.spreadsheets.values.clear({ spreadsheetId: id, range });
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId: id, range: `'SCOT Sheet'!A4:${lastCol}4`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: [header] },
    });
    await put(sheets, id, 'Dashboard', DASH_FIRST, dash, 'Q', 200);
    await put(sheets, id, 'SCOT Sheet', FIRST_ROW, rows, lastCol, 200);
    // A1 anchors an empty merged block (A1:G2) beside the title. A2 would not do:
    // it sits inside that merge, and a value written there is simply dropped.
    await stamp(sheets, id, 'SCOT Sheet', 'A1');

    google.invalidateSheet(id);
    await logDone(runId, rows.length);
    log(`  SCOT Sheet: ${rows.length.toLocaleString('en-IN')} customers, grid ${d.from_d} to ${d.today}`);
    return { rows: rows.length, from: d.from_d, to: d.today };
  } catch (e) {
    await logFail(runId, e.message);
    throw e;
  }
}

// ── The all-customers tab ─────────────────────────────
async function writeLifetimeTab({ log = () => {} } = {}) {
  const id = sheetId();
  if (!id) return { skipped: 'no sheet configured' };

  const runId = await logRun('SCOT Lifetime');
  try {
    const cust = await db.rows(
      `SELECT phone, name, email, city, state, orders, units, value,
              DATE_FORMAT(first_order, '%Y-%m-%d') first_order,
              DATE_FORMAT(last_order, '%Y-%m-%d') last_order,
              DATEDIFF(DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE), DATE(last_order)) days_since,
              gap_days
         FROM sfy_customers ORDER BY value DESC`);

    const cut = await db.one(
      `SELECT DATE_FORMAT(DATE_SUB(DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE),
                                   INTERVAL ${GRID_COLS - 1} DAY), '%Y-%m-%d') d`);

    const HEAD = ['S. No.', 'Customer Name', 'Contact No.', 'Email Id', 'City', 'State',
      'Lifetime Orders', 'Lifetime Value', 'Lifetime Units', 'Average Order Value',
      'First Order', 'Last Order', 'Days Since Last Order', 'Order Frequency',
      'Ordered in Last 12 Months'];

    const rows = cust.map((r, i) => {
      const n = Number(r.orders);
      const gap = r.gap_days == null ? null : Number(r.gap_days);
      return [i + 1, r.name || '(no name)', r.phone, r.email || '', r.city || '', r.state || '',
        n, Math.round(Number(r.value) || 0), Number(r.units) || 0,
        n ? Math.round(Number(r.value) / n) : 0,
        r.first_order, r.last_order, Number(r.days_since),
        n === 1 ? 'One-time' : gap <= 10 ? 'Weekly' : gap <= 20 ? '15 days'
          : gap <= 45 ? 'Monthly' : 'Occasional',
        r.last_order >= cut.d ? 'Yes' : 'No'];
    });

    const sheets = await google.getWriteClient();
    await ensureRows(sheets, id, { 'SCOT Lifetime': rows.length + 1 });
    await sheets.spreadsheets.values.clear({
      spreadsheetId: id, range: `'SCOT Lifetime'!A1:O1000000` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: id, range: `'SCOT Lifetime'!A1:O1`,
      valueInputOption: 'RAW', requestBody: { values: [HEAD] },
    });
    await put(sheets, id, 'SCOT Lifetime', 2, rows, 'O', LIFETIME_CHUNK);
    // Column Q: two columns clear of the table, which is cleared as A:O.
    await ensureCols(sheets, id, 'SCOT Lifetime', 17);
    await stamp(sheets, id, 'SCOT Lifetime', 'Q1');

    google.invalidateSheet(id);
    await logDone(runId, rows.length);
    log(`  SCOT Lifetime: ${rows.length.toLocaleString('en-IN')} customers`);
    return { rows: rows.length };
  } catch (e) {
    await logFail(runId, e.message);
    throw e;
  }
}

async function put(sheets, id, tab, startRow, data, lastColName, chunk) {
  for (let i = 0; i < data.length; i += chunk) {
    const part = data.slice(i, i + chunk);
    const from = startRow + i;
    await sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: `'${tab}'!A${from}:${lastColName}${from + part.length - 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: part },
    });
  }
}

// Grow a tab if it is short. Never shrinks it: rows below are somebody's
// to delete, not this script's.
async function ensureRows(sheets, id, need) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
  const reqs = [];
  for (const [title, want] of Object.entries(need)) {
    const tab = meta.data.sheets.find(s => s.properties.title === title);
    if (!tab) throw new Error(`the sheet has no tab called "${title}"`);
    const have = tab.properties.gridProperties.rowCount;
    if (have < want) {
      reqs.push({ appendDimension: {
        sheetId: tab.properties.sheetId, dimension: 'ROWS', length: want - have } });
    }
  }
  if (reqs.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: reqs } });
}

// What the daily sync calls. The 12-month tab is written once a day and the
// all-customers tab once a week, so eight syncs a day do not become eight
// rewrites of a quarter of a million rows.
async function refresh({ log = () => {}, force = false } = {}) {
  if (!sheetId()) return { skipped: 'SCOT_SHEET_ID not set' };
  await ensureLog();
  const out = {};

  if (force || !(await writtenRecently('SCOT Sheet', 20))) {
    out.scot = await writeScotSheet({ log });
  } else out.scot = { skipped: 'written today' };

  if (force || !(await writtenRecently('SCOT Lifetime', 24 * 7 - 4))) {
    out.lifetime = await writeLifetimeTab({ log });
  } else out.lifetime = { skipped: 'written this week' };

  return out;
}

// Writes each tab's "Last updated" line from the log, using the time its last
// successful write actually finished. For a sheet that was filled before the
// stamp existed: stamping it "now" would claim a freshness it does not have.
// The time is formatted to an ISO string in SQL rather than read as a Date,
// because the driver reads the DATETIME as local time and would shift it.
async function stampFromLog() {
  const id = sheetId();
  if (!id) return { skipped: 'no sheet configured' };
  await ensureLog();
  const rows = await db.rows(
    `SELECT tab, DATE_FORMAT(MAX(ended_at), '%Y-%m-%dT%H:%i:%sZ') at
       FROM scot_sheet_log WHERE ok = 1 GROUP BY tab`);
  const sheets = await google.getWriteClient();
  const done = {};
  for (const r of rows) {
    const where = r.tab === 'SCOT Lifetime' ? ['SCOT Lifetime', 'Q1'] : r.tab === 'SCOT Sheet' ? ['SCOT Sheet', 'A1'] : null;
    if (!where || !r.at) continue;
    if (where[0] === 'SCOT Lifetime') await ensureCols(sheets, id, 'SCOT Lifetime', 17);
    await stamp(sheets, id, where[0], where[1], new Date(r.at));
    done[r.tab] = stampText(new Date(r.at));
  }
  google.invalidateSheet(id);
  return done;
}

module.exports = { refresh, writeScotSheet, writeLifetimeTab, stampFromLog };

if (require.main === module) {
  require('dotenv').config();
  const force = process.argv.includes('--force');
  const run = process.argv.includes('--stamp') ? stampFromLog() : refresh({ log: console.log, force });
  run
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
}
