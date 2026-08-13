// ══════════════════════════════════════════════════════
// SHEET-BACKED FORMS
//   • Merch FMS Unit 1 / Unit 2 — material requirement entries
//   • Process FMS — production stage entries
//   • PO — Production fills, Finance uploads the document, both can view
// None of these touch MySQL: the Google Sheet IS the store.
// ══════════════════════════════════════════════════════
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const { requireAuth, requirePOFill, requirePOUpload, requirePOView } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errors');
const { istTimestamp } = require('../utils/dates');
const google = require('../services/google');

const router = express.Router();

// PO document upload — 20MB cap, kept in RAM (Vercel-safe, no disk write)
const poUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const STATUS_OPTIONS = ['Raise PO', 'Material Issue', 'Inhouse'];
const UNIT_OPTIONS = ['PCS', 'MTR', 'GRS', 'KGS', 'ROLLS', 'BOX'];

function validateMerchRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'At least 1 row required';
  for (const r of rows) {
    if (!r.soNo || !r.status) return 'SO NO and Status are required in every row';
    if (!STATUS_OPTIONS.includes(r.status)) return 'Invalid status value';
    if (r.unit && !UNIT_OPTIONS.includes(r.unit)) return 'Invalid unit value';
  }
  return null;
}

const merchRowValues = (r) => [
  r.soNo || '', r.partyName || '', r.sku || '', r.noOfPcs || '', r.materialName || '',
  r.materialType || '', r.quantity || '', r.unit || '', r.vendorName || '', r.status || '',
];

// ── Merch FMS Unit 1 ──────────────────────────────────
// COL A = timestamp (auto), COL B = unique id (auto), COL C onward = form data.
router.post('/merch-fms/submit', requireAuth, asyncRoute(async (req, res) => {
  const problem = validateMerchRows(req.body.rows);
  if (problem) return res.status(400).json({ error: problem });

  const { id, gid, startRow } = config.sheets.merchFms;
  const tabName = await google.resolveTabNameByGid(id, gid);
  const nowStr = istTimestamp();
  const values = req.body.rows.map(r => [nowStr, crypto.randomUUID(), ...merchRowValues(r)]);

  const api = await google.getWriteClient();
  await api.spreadsheets.values.append({
    spreadsheetId: id,
    range: `${tabName}!A${startRow}:L`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  google.invalidateSheet(id);
  res.json({ success: true, count: values.length });
}));

router.get('/merch-fms/status-options', requireAuth, (req, res) => res.json({ statusOptions: STATUS_OPTIONS }));
router.get('/merch-fms/unit-options', requireAuth, (req, res) => res.json({ unitOptions: UNIT_OPTIONS }));

// ── Merch FMS Unit 2 (22 Godam) ───────────────────────
// Same form, different spreadsheet, and it starts at COL C (no timestamp/id).
router.post('/merch-fms-22godam/submit', requireAuth, asyncRoute(async (req, res) => {
  const problem = validateMerchRows(req.body.rows);
  if (problem) return res.status(400).json({ error: problem });

  const { id, gid, startRow } = config.sheets.merch22Godam;
  const tabName = await google.resolveTabNameByGid(id, gid);
  const values = req.body.rows.map(merchRowValues);

  const api = await google.getWriteClient();
  await api.spreadsheets.values.append({
    spreadsheetId: id,
    range: `${tabName}!C${startRow}:L`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  google.invalidateSheet(id);
  res.json({ success: true, count: values.length });
}));

router.get('/merch-fms-22godam/status-options', requireAuth, (req, res) => res.json({ statusOptions: STATUS_OPTIONS }));
router.get('/merch-fms-22godam/unit-options', requireAuth, (req, res) => res.json({ unitOptions: UNIT_OPTIONS }));

// ══════════════════════════════════════════════════════
// PO — same spreadsheet as Merch FMS, its own "PO" tab.
//   C Order By | D Party Name | E Vendor Name | F SO Number | G Material Type |
//   H Style No | I Quantity Required | J Price | K PO Document Link |
//   L Uploaded By | M Uploaded At
// Production fills the PO; Finance (or Admin) uploads the document from Tally
// or their own software; Production can then open it from the same row.
// ══════════════════════════════════════════════════════
const PO_HEADERS = ['Order By', 'Party Name', 'Vendor Name', 'SO Number', 'Material Type', 'Style No',
                    'Quantity Required', 'Price', 'PO Document Link', 'Uploaded By', 'Uploaded At'];

// Finds the "PO" tab, creating it (with headers) when it does not exist.
async function ensurePOTab() {
  const { id, tab } = config.sheets.po;
  const existing = await google.findTabByTitle(id, tab);
  if (existing) return existing.title;

  const api = await google.getWriteClient();
  await api.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
  });
  await api.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${tab}!C1:M1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [PO_HEADERS] },
  });
  google.forgetTabs(id);   // the tab list just changed
  return tab;
}

router.post('/po/submit', requireAuth, requirePOFill, asyncRoute(async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'At least 1 row required' });
  for (const r of rows) if (!r.partyName) return res.status(400).json({ error: 'Party Name is required in every row' });

  const { id, startRow } = config.sheets.po;
  const tabName = await ensurePOTab();
  const values = rows.map(r => [
    r.orderBy || '', r.partyName || '', r.vendorName || '', r.soNumber || '',
    r.materialType || '', r.styleNo || '', r.qtyRequired || '', r.price || '',
  ]);

  const api = await google.getWriteClient();
  await api.spreadsheets.values.append({
    spreadsheetId: id,
    range: `${tabName}!C${startRow}:J`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  google.invalidateSheet(id);
  res.json({ success: true, count: values.length });
}));

router.get('/po/entries', requireAuth, requirePOView, asyncRoute(async (req, res) => {
  const { id, startRow } = config.sheets.po;
  const tabName = await ensurePOTab();
  // fresh: an upload that just happened must be visible immediately.
  const values = await google.readValues(id, `${tabName}!C${startRow}:M`, { fresh: true });
  const entries = values
    .map((row, i) => ({
      row: startRow + i,
      orderBy: row[0] || '', partyName: row[1] || '', vendorName: row[2] || '', soNumber: row[3] || '',
      materialType: row[4] || '', styleNo: row[5] || '', qtyRequired: row[6] || '', price: row[7] || '',
      docUrl: row[8] || '', uploadedBy: row[9] || '', uploadedAt: row[10] || '',
    }))
    .filter(e => e.partyName || e.orderBy || e.materialType || e.styleNo || e.qtyRequired || e.price || e.vendorName || e.soNumber);
  res.json({ entries });
}));

router.post('/po/:row/upload-doc', requireAuth, requirePOUpload, poUpload.single('file'), asyncRoute(async (req, res) => {
  const { id, startRow } = config.sheets.po;
  const rowNum = parseInt(req.params.row, 10);
  if (!rowNum || rowNum < startRow) return res.status(400).json({ error: 'Invalid row' });
  if (!req.file) return res.status(400).json({ error: 'A file is required' });

  let docUrl;
  try {
    docUrl = await google.uploadPODocToDrive(req.file.buffer, req.file.originalname, req.file.mimetype);
  } catch (err) {
    if (/storage quota/i.test(err.message || '')) {
      return res.status(400).json({ error: 'Drive upload failed: a service account has no storage quota of its own. Set PO_DRIVE_FOLDER_ID to a shared/personal Drive folder and share it with the service account.' });
    }
    if (err.code === 404) return res.status(400).json({ error: 'PO_DRIVE_FOLDER_ID is invalid, or the folder is not shared with the service account.' });
    throw err;
  }

  const nowStr = istTimestamp();
  const tabName = await ensurePOTab();
  const api = await google.getWriteClient();
  await api.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${tabName}!K${rowNum}:M${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[docUrl, req.session.name || '', nowStr]] },
  });
  google.invalidateSheet(id);

  res.json({ success: true, docUrl, uploadedBy: req.session.name || '', uploadedAt: nowStr });
}));

// ══════════════════════════════════════════════════════
// PROCESS FMS — Doc Link, Actual Process Quantity, Design Number, SO Number,
// Party Name. The timestamp is added automatically. COL A to F.
// ══════════════════════════════════════════════════════
router.post('/process-fms/submit', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'At least 1 row required' });
  for (const r of rows) if (!r.soNumber) return res.status(400).json({ error: 'SO Number is required in every row' });

  const { id, gid, startRow } = config.sheets.processFms;
  const tabName = await google.resolveTabNameByGid(id, gid);

  // Find the first empty row in COL A from the start row onward, so stray data
  // further down does not move this form's append point.
  const colAValues = await google.readValues(id, `${tabName}!A${startRow}:A100000`, { fresh: true });
  let nextRow = startRow;
  for (let i = 0; i < colAValues.length; i++) {
    if (!colAValues[i] || !(colAValues[i][0] || '').trim()) { nextRow = startRow + i; break; }
    nextRow = startRow + i + 1;   // all rows filled — append after them
  }

  const nowStr = istTimestamp();
  const values = rows.map(r => [
    nowStr, r.docLink || '', r.actualQty || '', r.designNumber || '', r.soNumber || '', r.partyName || '',
  ]);

  const api = await google.getWriteClient();
  await api.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${tabName}!A${nextRow}:F${nextRow + values.length - 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
  google.invalidateSheet(id);

  res.json({ success: true, count: values.length });
}));

module.exports = router;
