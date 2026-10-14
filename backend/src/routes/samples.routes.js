// ══════════════════════════════════════════════════════
// SAMPLE STYLE MIS (/api/samples)
//
// Where a style lives before it is a product: sampled, costed against a
// vendor's quote, priced for the website and for Myntra, and then either put
// into production or left outstanding.
//
// The columns are the client's, from the workbook they sent — Kurta, Pant and
// Dupatta fabrics kept apart, lining asked as a yes/no with its own fabric,
// three costings and two prices. Nothing is derived: final_costing is a
// decision, often neither of the two quotes, so it is typed rather than
// calculated.
//
// Money fields are null when blank, never zero. A style half way through
// costing has most of them empty for weeks, and a zero would read as "free"
// where the truth is "not decided yet".
// ══════════════════════════════════════════════════════
const express = require('express');
const multer = require('multer');
const config = require('../config');
const google = require('../services/google');
const { db } = require('../db/pool');
const { requireAuth, requirePage } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();

// The photo is held in memory just long enough to hand to Drive. The browser
// shrinks it first, so this limit is a backstop, not the normal case - and it
// sits under the 4.5 MB request cap a Vercel function enforces regardless.
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

const STATUSES = ['Production', 'Outstanding'];

const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
// Blank stays blank. Number('') is 0, which is how an empty costing column
// turns into a style that costs nothing.
const money = (v) => {
  const s = String(v == null ? '' : v).replace(/[^0-9.-]/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function body(req) {
  const b = req.body || {};
  const status = STATUSES.includes(txt(b.status, 20)) ? txt(b.status, 20) : 'Outstanding';
  const lining = ['Yes', 'No'].includes(txt(b.has_lining, 3)) ? txt(b.has_lining, 3) : '';
  return {
    style_id: txt(b.style_id, 120),
    image_url: txt(b.image_url, 1000),
    notes: txt(b.notes, 4000),
    kurta_fabric: txt(b.kurta_fabric, 255),
    pant_fabric: txt(b.pant_fabric, 255),
    dupatta_fabric: txt(b.dupatta_fabric, 255),
    fabric_remarks: txt(b.fabric_remarks, 1000),
    has_lining: lining,
    // A lining fabric with "No" against it is a leftover from changing the
    // answer, and it reads as a contradiction on the page.
    lining_fabric: lining === 'Yes' ? txt(b.lining_fabric, 255) : '',
    status,
    costing_us: money(b.costing_us),
    costing_vendor: money(b.costing_vendor),
    final_costing: money(b.final_costing),
    price_website: money(b.price_website),
    price_myntra: money(b.price_myntra),
  };
}

const COLS = ['style_id', 'image_url', 'notes', 'kurta_fabric', 'pant_fabric',
  'dupatta_fabric', 'fabric_remarks', 'has_lining', 'lining_fabric', 'status',
  'costing_us', 'costing_vendor', 'final_costing', 'price_website', 'price_myntra'];

// ── The Google Sheet half ─────────────────────────────
// Every style lands in two places, here and the client's sheet, on the same
// terms as the B2B book: saved here first, written there second. None of this
// throws — a style that saved and failed to reach the sheet is worth keeping
// and worth saying so about, not worth losing.
//
// The sheet's column order is the workbook's, which is the client's: the
// sixteen headings they sent, in their order, with Last Updated at the end.
const SHEET_COLS = ['style_id', 'image_url', 'notes', 'kurta_fabric', 'pant_fabric',
  'dupatta_fabric', 'fabric_remarks', 'has_lining', 'lining_fabric', 'status',
  'costing_us', 'costing_vendor', 'final_costing', 'price_website', 'price_myntra'];
const FIRST_COL = 'A';
const LAST_COL = 'P';      // fifteen fields plus Last Updated
const PROBE_COL = 'A';     // the style id — a row with none is a free row

const MONEY = ['costing_us', 'costing_vendor', 'final_costing', 'price_website', 'price_myntra'];

// Money crosses as a bare number so the client can sum a column; a rupee sign
// would turn every one of them into text. Blank stays blank, never 0.
const asRow = (r) => [
  ...SHEET_COLS.map((c) => {
    if (MONEY.includes(c)) return (r[c] === null || r[c] === undefined || r[c] === '' ? '' : r[c]);
    return r[c] || '';
  }),
  new Date().toLocaleDateString('en-GB'),   // Last Updated, as dd/mm/yyyy
];

const sheetConfigured = () => !!config.sheets.samples.id;
const tab = () => google.resolveTabNameByGid(config.sheets.samples.id, config.sheets.samples.gid);

// The first line with no style id on it, at or after the start row.
async function nextRow(tabName) {
  const { id, startRow } = config.sheets.samples;
  const col = await google.readValues(
    id, `${tabName}!${PROBE_COL}${startRow}:${PROBE_COL}100000`, { fresh: true });
  for (let i = 0; i < col.length; i++) {
    if (!col[i] || !String(col[i][0] || '').trim()) return startRow + i;
  }
  return startRow + col.length;
}

async function writeRow(row, record) {
  if (!sheetConfigured()) return { ok: false, reason: 'no sheet configured' };
  try {
    const { id } = config.sheets.samples;
    const tabName = await tab();
    const at = row || await nextRow(tabName);
    const api = await google.getWriteClient();
    await api.spreadsheets.values.update({
      spreadsheetId: id,
      range: `${tabName}!${FIRST_COL}${at}:${LAST_COL}${at}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [asRow(record)] },
    });
    google.invalidateSheet(id);
    return { ok: true, row: at };
  } catch (err) {
    console.error('⚠️ Sampling sheet write failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

// Says what actually went wrong with a Drive upload. The shared error handler
// turns every Google 403 into "share this sheet with the service account" and
// every 404 into "Sheet not found", which is true of Sheets and misleading for
// Drive: the same 403 is also what Google answers when no upload folder is set,
// because a service account has no storage of its own. Someone reading that
// message goes off to share a folder that was shared all along.
function driveFailure(e) {
  const folder = config.google.poDriveFolderId;
  const who = google.serviceAccountEmail() || 'the service account';
  const msg = String((e && e.message) || e);
  if (!folder) {
    return 'No Drive folder is set for uploads on this server (PO_DRIVE_FOLDER_ID is empty). '
      + 'A service account has no storage of its own, so it needs a folder in a Shared Drive.';
  }
  if (/storage quota/i.test(msg)) {
    return 'Drive refused the upload: the service account has no storage quota. The folder must be inside a '
      + 'Shared Drive, not in someone\'s My Drive, and ' + who + ' must be a member of it.';
  }
  if (e && e.code === 404) {
    return 'The Drive folder was not found by ' + who + '. Check PO_DRIVE_FOLDER_ID, and that the Shared Drive '
      + 'is shared with that address.';
  }
  if (e && e.code === 403) {
    return 'Drive says ' + who + ' may not add files to that folder (' + msg + '). Make it a Content manager '
      + 'of the Shared Drive.';
  }
  return 'Could not upload to Drive: ' + msg;
}

// Uploads the sample photo and returns the link to store in image_url. The
// style row keeps holding a link, as it always did, so the sheet, the table and
// every style entered before this existed carry on unchanged.
router.post('/samples/image', requireAuth, requirePage('samples'), (req, res, next) => {
  photoUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    const big = err.code === 'LIMIT_FILE_SIZE';
    res.status(big ? 413 : 400).json({ error: big ? 'That photo is too large - keep it under 4 MB.' : err.message });
  });
}, asyncRoute(async (req, res) => {
  if (!req.file) throw httpError(400, 'Choose a photo to upload.');
  if (!/^image\//i.test(req.file.mimetype || '')) throw httpError(400, 'That file is not an image.');
  let url;
  try {
    url = await google.uploadToDrive(req.file.buffer, req.file.originalname, req.file.mimetype, 'SAMPLE');
  } catch (e) {
    throw httpError(502, driveFailure(e));
  }
  res.json({ url });
}));

router.get('/samples', requireAuth, requirePage('samples'), asyncRoute(async (req, res) => {
  const q = txt(req.query.q, 120);
  const status = STATUSES.includes(txt(req.query.status, 20)) ? txt(req.query.status, 20) : '';

  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (q) {
    where.push(`(style_id LIKE ? OR kurta_fabric LIKE ? OR pant_fabric LIKE ?
                 OR dupatta_fabric LIKE ? OR lining_fabric LIKE ? OR notes LIKE ?)`);
    for (let i = 0; i < 6; i++) args.push('%' + q + '%');
  }
  const sql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const [rows, counts] = await Promise.all([
    db.rows(`SELECT id, ${COLS.join(', ')}, updated_at
               FROM sample_styles ${sql}
              ORDER BY updated_at DESC, id DESC LIMIT 1000`, args),
    // Counted over everything, not the filtered set: the tiles are what the
    // filter is chosen FROM, so narrowing them to the current filter would
    // leave the other number permanently unreachable.
    db.rows(`SELECT status, COUNT(*) n FROM sample_styles GROUP BY status`),
  ]);

  const by = Object.fromEntries(counts.map(c => [c.status, Number(c.n)]));
  res.json({
    rows,
    counts: {
      all: counts.reduce((a, c) => a + Number(c.n), 0),
      production: by.Production || 0,
      outstanding: by.Outstanding || 0,
    },
  });
}));

router.post('/samples', requireAuth, requirePage('samples'), asyncRoute(async (req, res) => {
  const v = body(req);
  if (!v.style_id) throw httpError(400, 'Sample Style ID is required');

  const dup = await db.one('SELECT id FROM sample_styles WHERE style_id = ?', [v.style_id]);
  if (dup) throw httpError(409, `Sample Style ID "${v.style_id}" already exists`);

  const [r] = await db.query(
    `INSERT INTO sample_styles (${COLS.join(', ')}, created_by)
     VALUES (${COLS.map(() => '?').join(', ')}, ?)`,
    [...COLS.map(c => v[c]), req.user?.userId || null]);

  const sheet = await writeRow(null, v);
  if (sheet.ok) await db.query('UPDATE sample_styles SET sheet_row=? WHERE id=?', [sheet.row, r.insertId]);
  res.json({ ok: true, id: r.insertId, sheet });
}));

router.put('/samples/:id', requireAuth, requirePage('samples'), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const v = body(req);
  if (!v.style_id) throw httpError(400, 'Sample Style ID is required');

  const dup = await db.one(
    'SELECT id FROM sample_styles WHERE style_id = ? AND id <> ?', [v.style_id, id]);
  if (dup) throw httpError(409, `Sample Style ID "${v.style_id}" already exists`);

  const existing = await db.one('SELECT sheet_row FROM sample_styles WHERE id = ?', [id]);
  if (!existing) throw httpError(404, 'Sample style not found');

  await db.query(
    `UPDATE sample_styles SET ${COLS.map(c => c + ' = ?').join(', ')} WHERE id = ?`,
    [...COLS.map(c => v[c]), id]);

  const sheet = await writeRow(existing.sheet_row || null, v);
  if (sheet.ok && sheet.row !== existing.sheet_row) {
    await db.query('UPDATE sample_styles SET sheet_row=? WHERE id=?', [sheet.row, id]);
  }
  res.json({ ok: true, sheet });
}));

router.delete('/samples/:id', requireAuth, requirePage('samples'), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.one('SELECT sheet_row FROM sample_styles WHERE id = ?', [id]);
  if (!existing) throw httpError(404, 'Sample style not found');

  await db.query('DELETE FROM sample_styles WHERE id = ?', [id]);

  // The sheet line is cleared, not removed. Deleting the row would shift every
  // row under it up by one, and every other style's sheet_row would then point
  // at its neighbour's line.
  if (existing.sheet_row && sheetConfigured()) {
    try {
      const api = await google.getWriteClient();
      await api.spreadsheets.values.clear({
        spreadsheetId: config.sheets.samples.id,
        range: `${await tab()}!${FIRST_COL}${existing.sheet_row}:${LAST_COL}${existing.sheet_row}`,
      });
      google.invalidateSheet(config.sheets.samples.id);
    } catch (err) {
      console.error('⚠️ Sampling sheet clear failed:', err.message);
    }
  }
  res.json({ ok: true });
}));

module.exports = router;
