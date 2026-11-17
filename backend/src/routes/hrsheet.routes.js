// ══════════════════════════════════════════════════════
// HR (/api/hrsheet) - the team's employee tracker, live from their sheet.
//
// The "Bunai" tab of the HR team's Employee Management System sheet, shown as
// it is: its own headings, in its order, every row. The sheet stays the record
// - what the team types there shows here, and "+ Add" writes a new row into the
// sheet (the first row with no employee name), nothing kept in this database.
//
// Five columns are dropdowns in the sheet whose options live on its "DD" tab,
// and five are dates; the form offers the same. Column X of the tab is a note
// to the team ("other fields that can be tracked"), not a column of data, so
// only A to V are read and written.
//
// Admin only, as the Employees page is: mobile and emergency numbers.
// ══════════════════════════════════════════════════════
const express = require('express');
const google = require('../services/google');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();

const SHEET_ID = (process.env.HR_SHEET_ID || '1J0C7dFF61rUlKQW2wA6yiiCrlGOy4rBr0La4sl4YZG0').trim();
const TAB = (process.env.HR_SHEET_TAB || 'Bunai').trim();
const LAST_COL = 'V';                 // 22 columns of data
const q = (t) => `'${t.replace(/'/g, "''")}'`;

// A heading's dropdown: the DD tab's column with the same heading in row 1.
const DD_RANGE = `${q('DD')}!A1:Z60`;
const DATE_HEADINGS = /date of joining|probation end|confirmation date|last date of employment|offer letter given/i;
const LONG_HEADINGS = /^kra$|record log|remarks/i;

const clean = (h) => String(h || '').replace(/\s+/g, ' ').trim();

async function readSheet() {
  const [rows, dd] = await Promise.all([
    google.readValues(SHEET_ID, `${q(TAB)}!A1:${LAST_COL}2000`, { fresh: true }),
    google.readValues(SHEET_ID, DD_RANGE, { fresh: true }).catch(() => []),
  ]);
  const headers = (rows[0] || []).map(clean);
  while (headers.length < 22) headers.push('');
  const options = {};
  const ddHead = (dd[0] || []).map(clean);
  ddHead.forEach((h, c) => {
    if (!h) return;
    options[h.toLowerCase()] = dd.slice(1).map(r => clean(r[c])).filter(Boolean);
  });
  const fields = headers.map((h, i) => ({
    i, label: h || 'Column ' + String.fromCharCode(65 + i),
    type: options[h.toLowerCase()] ? 'select' : DATE_HEADINGS.test(h) ? 'date' : LONG_HEADINGS.test(h) ? 'long' : 'text',
    options: options[h.toLowerCase()] || null,
  }));
  // Every row with something in it, numbered as the sheet numbers it.
  const data = [];
  rows.slice(1).forEach((r, k) => {
    if (!(r || []).some(v => String(v || '').trim())) return;
    const cells = fields.map(f => String((r || [])[f.i] == null ? '' : r[f.i]));
    data.push({ row: k + 2, cells });
  });
  return { fields, data, firstEmpty: firstEmptyRow(rows) };
}

// The first row with no employee name in it, below the heading.
function firstEmptyRow(rows) {
  for (let k = 1; k < rows.length; k++) {
    if (!String(((rows[k] || [])[0]) || '').trim()) return k + 1;
  }
  return rows.length + 1;
}

router.get('/hrsheet', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const s = await readSheet();
    res.json({ tab: TAB, sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, fields: s.fields, rows: s.data });
  } catch (e) {
    throw httpError(502, 'Could not read the HR sheet: ' + (e.message || e));
  }
}));

router.post('/hrsheet', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const s = await readSheet();
  const values = s.fields.map(f => {
    let v = String(((req.body || {}).cells || [])[f.i] == null ? '' : req.body.cells[f.i]).trim().slice(0, 2000);
    // A dropdown only takes one of its own options, as the sheet would.
    if (f.type === 'select' && v && !f.options.includes(v)) throw httpError(400, f.label + ': choose one of the options.');
    if (f.type === 'date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw httpError(400, f.label + ': not a date.');
    return v;
  });
  if (!values[0]) throw httpError(400, 'The employee name is required.');
  const row = s.firstEmpty;
  try {
    const api = await google.getWriteClient();
    await api.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${q(TAB)}!A${row}:${LAST_COL}${row}`,
      // As if typed: a yyyy-mm-dd date lands as a date the sheet's own date
      // checks accept.
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] },
    });
    google.invalidateSheet(SHEET_ID);
  } catch (e) {
    throw httpError(502, 'Could not write to the HR sheet: ' + (e.message || e));
  }
  res.json({ ok: true, row });
}));

module.exports = router;
