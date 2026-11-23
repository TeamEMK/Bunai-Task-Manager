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

// The stages a style moves through, in order. "Production" and "Outstanding"
// were renamed on 5 Nov 2026; a form still sending the old name gets the new one.
const STATUSES = ['Production Pending', 'In Production', 'Handover Pending', 'On Hold', 'Live'];
const RENAMED = { Production: 'In Production', Outstanding: 'Production Pending' };
const statusOf = (v) => {
  const t = txt(v, 20);
  return STATUSES.includes(t) ? t : RENAMED[t] || '';
};

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
  const status = statusOf(b.status) || 'Production Pending';
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
    price_wholesale: money(b.price_wholesale),
    vendor_id: Number.isInteger(Number(b.vendor_id)) && Number(b.vendor_id) > 0 ? Number(b.vendor_id) : null,
  };
}

const COLS = ['style_id', 'image_url', 'notes', 'kurta_fabric', 'pant_fabric',
  'dupatta_fabric', 'fabric_remarks', 'has_lining', 'lining_fabric', 'status',
  'costing_us', 'costing_vendor', 'final_costing', 'price_website', 'price_myntra', 'price_wholesale', 'vendor_id'];

// ── Edit history ──────────────────────────────────────
// Each save writes down who made it and the fields it changed, as the page
// names and shows them, so "Status: Production Pending → In Production" reads
// the same months later even if the vendor's name has changed since.
const LABELS = {
  style_id: 'Style ID', image_url: 'Photo', notes: 'Notes', kurta_fabric: 'Kurta fabric',
  pant_fabric: 'Pant fabric', dupatta_fabric: 'Dupatta fabric', fabric_remarks: 'Fabric remarks',
  has_lining: 'Lining', lining_fabric: 'Lining fabric', status: 'Status',
  costing_us: 'Internal costing', costing_vendor: 'Vendor costing', final_costing: 'Final costing',
  price_website: 'Website price', price_myntra: 'Myntra price', price_wholesale: 'Wholesale price',
  vendor_id: 'Vendor',
};
const LOG_MONEY = ['costing_us', 'costing_vendor', 'final_costing', 'price_website', 'price_myntra', 'price_wholesale'];

async function whoAmI(req) {
  const me = await db.one('SELECT name FROM users WHERE id = ?', [req.session.userId]).catch(() => null);
  return String((me && me.name) || req.session.name || '').slice(0, 120);
}

const same = (c, a, b) => LOG_MONEY.includes(c) || c === 'vendor_id'
  ? (a == null || a === '' ? null : Number(a)) === (b == null || b === '' ? null : Number(b))
  : String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();

async function changesOf(before, after) {
  const cols = COLS.filter(c => !same(c, before[c], after[c]));
  if (!cols.length) return [];
  let vendors = new Map();
  if (cols.includes('vendor_id')) {
    const ids = [before.vendor_id, after.vendor_id].filter(Boolean);
    if (ids.length) vendors = new Map((await db.rows('SELECT id, vendor_name FROM vendor_book WHERE id IN (?)', [ids])).map(v => [v.id, v.vendor_name]));
  }
  const show = (c, v) => {
    if (v == null || String(v).trim() === '') return '';
    if (c === 'vendor_id') return vendors.get(Number(v)) || '#' + v;
    if (LOG_MONEY.includes(c)) return '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    if (c === 'image_url') return 'photo';
    const t = String(v).trim();
    return t.length > 300 ? t.slice(0, 300) + '…' : t;
  };
  return cols.map(c => ({ field: c, label: LABELS[c] || c, from: show(c, before[c]), to: show(c, after[c]) }));
}

async function logChange(id, styleId, action, changes, req, who) {
  await db.query(
    `INSERT INTO sample_style_log (sample_id, style_id, action, changes, user_id, user_name, at)
     VALUES (?,?,?,?,?,?, UTC_TIMESTAMP())`,
    [id, styleId, action, changes ? JSON.stringify(changes) : null, req.session.userId || null, who]);
}

// "BUNA-IH 88", "BUNA-IH-88" and "buna ih88" are the same style.
const styleKey = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Each style's vendor: the one picked on the style, else whichever vendor in
// the Vendor Name book lists the style among the styles they make.
async function withVendors(rows) {
  const book = await db.rows('SELECT id, vendor_name, company, styles FROM vendor_book ORDER BY vendor_name').catch(() => []);
  const byId = new Map(book.map(v => [v.id, v.vendor_name]));
  const companyOf = new Map(book.map(v => [v.id, String(v.company || '').trim()]));
  const byStyle = new Map();
  for (const v of book) {
    let styles = [];
    try { styles = JSON.parse(v.styles || '[]'); } catch (_) { /* a bad cell is no styles */ }
    (Array.isArray(styles) ? styles : []).forEach(s => {
      const k = styleKey(s);
      if (k && !byStyle.has(k)) byStyle.set(k, { id: v.id, name: v.vendor_name });
    });
  }
  rows.forEach(r => {
    const picked = r.vendor_id && byId.has(r.vendor_id) ? { id: r.vendor_id, name: byId.get(r.vendor_id) } : null;
    const listed = byStyle.get(styleKey(r.style_id)) || null;
    const v = picked || listed;
    r.vendor_ref = v ? v.id : null;
    r.vendor_name = v ? v.name : '';
    r.vendor_company = v ? companyOf.get(v.id) || '' : '';
    r.vendor_from = picked ? 'picked' : listed ? 'book' : '';
  });
  return book.map(v => ({ id: v.id, name: v.vendor_name }));
}

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
  const status = statusOf(req.query.status);

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
    db.rows(`SELECT id, ${COLS.join(', ')}, updated_at, updated_by_name,
                    DATE_FORMAT(updated_at + INTERVAL 330 MINUTE, '%e %b %Y, %l:%i %p') AS updated
               FROM sample_styles ${sql}
              ORDER BY updated_at DESC, id DESC LIMIT 1000`, args),
    // Counted over everything, not the filtered set: the tiles are what the
    // filter is chosen FROM, so narrowing them to the current filter would
    // leave the other number permanently unreachable.
    db.rows(`SELECT status, COUNT(*) n FROM sample_styles GROUP BY status`),
  ]);

  const by = Object.fromEntries(counts.map(c => [c.status, Number(c.n)]));
  const vendors = await withVendors(rows);
  res.json({
    rows,
    vendors,
    statuses: STATUSES,
    counts: {
      all: counts.reduce((a, c) => a + Number(c.n), 0),
      byStatus: Object.fromEntries(STATUSES.map(s => [s, by[s] || 0])),
    },
  });
}));

// The style's history, newest first. Styles from before the history began
// have none; their Last edited still shows when, without who.
router.get('/samples/:id/history', requireAuth, requirePage('samples'), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db.rows(
    `SELECT action, changes, user_name, DATE_FORMAT(at + INTERVAL 330 MINUTE, '%e %b %Y, %l:%i %p') AS at
       FROM sample_style_log WHERE sample_id = ? ORDER BY at DESC, id DESC LIMIT 200`, [id]);
  res.json({
    rows: rows.map(r => {
      let changes = [];
      try { changes = JSON.parse(r.changes || '[]'); } catch (_) { /* a bad row shows no fields */ }
      return { action: r.action, by: r.user_name, at: r.at, changes: Array.isArray(changes) ? changes : [] };
    }),
  });
}));

router.post('/samples', requireAuth, requirePage('samples'), asyncRoute(async (req, res) => {
  const v = body(req);
  if (!v.style_id) throw httpError(400, 'Sample Style ID is required');

  const dup = await db.one('SELECT id FROM sample_styles WHERE style_id = ?', [v.style_id]);
  if (dup) throw httpError(409, `Sample Style ID "${v.style_id}" already exists`);

  const who = await whoAmI(req);
  const [r] = await db.query(
    `INSERT INTO sample_styles (${COLS.join(', ')}, created_by, updated_by_name, updated_at)
     VALUES (${COLS.map(() => '?').join(', ')}, ?, ?, UTC_TIMESTAMP())`,
    [...COLS.map(c => v[c]), req.session.userId || null, who]);
  await logChange(r.insertId, v.style_id, 'added', null, req, who);

  const sheet = await writeRow(null, v);
  if (sheet.ok) await db.query('UPDATE sample_styles SET sheet_row=?, updated_at=updated_at WHERE id=?', [sheet.row, r.insertId]);
  res.json({ ok: true, id: r.insertId, sheet });
}));

router.put('/samples/:id', requireAuth, requirePage('samples'), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const v = body(req);
  if (!v.style_id) throw httpError(400, 'Sample Style ID is required');

  const dup = await db.one(
    'SELECT id FROM sample_styles WHERE style_id = ? AND id <> ?', [v.style_id, id]);
  if (dup) throw httpError(409, `Sample Style ID "${v.style_id}" already exists`);

  const existing = await db.one(`SELECT sheet_row, ${COLS.join(', ')} FROM sample_styles WHERE id = ?`, [id]);
  if (!existing) throw httpError(404, 'Sample style not found');

  // A save that changed nothing leaves the last editor and the history alone.
  const changes = await changesOf(existing, v);
  if (changes.length) {
    const who = await whoAmI(req);
    await db.query(
      `UPDATE sample_styles SET ${COLS.map(c => c + ' = ?').join(', ')}, updated_by_name = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
      [...COLS.map(c => v[c]), who, id]);
    await logChange(id, v.style_id, 'edited', changes, req, who);
  }

  const sheet = await writeRow(existing.sheet_row || null, v);
  if (sheet.ok && sheet.row !== existing.sheet_row) {
    await db.query('UPDATE sample_styles SET sheet_row=?, updated_at=updated_at WHERE id=?', [sheet.row, id]);
  }
  res.json({ ok: true, sheet });
}));

router.delete('/samples/:id', requireAuth, requirePage('samples'), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.one('SELECT sheet_row, style_id FROM sample_styles WHERE id = ?', [id]);
  if (!existing) throw httpError(404, 'Sample style not found');

  await db.query('DELETE FROM sample_styles WHERE id = ?', [id]);
  await logChange(id, existing.style_id, 'deleted', null, req, await whoAmI(req));

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

// ── Internal costing from Bunai Product Cost ─────────
// A Bunai product's selling price is the style's internal costing: saving the
// product writes it onto the style with the same id ("BUNA-IH 268" matches
// "BUNA-IH-268"), into the history and the client's sheet as a save here would.
// No style with that id, no price yet, or the same price already: nothing.
// Never throws - the product saved, and that is what the person asked for.
async function setInternalFromCost(sku, selling, who, userId) {
  try {
    const k = styleKey(sku);
    if (!k || selling == null || !Number.isFinite(Number(selling))) return null;
    const all = await db.rows('SELECT id, style_id FROM sample_styles');
    const hit = all.find(s => styleKey(s.style_id) === k);
    if (!hit) return null;
    const before = await db.one(`SELECT sheet_row, ${COLS.join(', ')} FROM sample_styles WHERE id = ?`, [hit.id]);
    const after = { ...before, costing_us: Math.round(Number(selling) * 100) / 100 };
    const changes = await changesOf(before, after);
    if (!changes.length) return null;
    changes.forEach(c => { c.label += ' (from Bunai Product Cost)'; });
    await db.query('UPDATE sample_styles SET costing_us = ?, updated_by_name = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [after.costing_us, who, hit.id]);
    await logChange(hit.id, before.style_id, 'edited', changes, { session: { userId } }, who);
    const sheet = await writeRow(before.sheet_row || null, after);
    if (sheet.ok && sheet.row !== before.sheet_row) {
      await db.query('UPDATE sample_styles SET sheet_row=?, updated_at=updated_at WHERE id=?', [sheet.row, hit.id]);
    }
    return { style_id: before.style_id, from: before.costing_us == null ? null : Number(before.costing_us), to: after.costing_us };
  } catch (err) {
    console.error('⚠️ Internal costing from Bunai Product Cost failed:', err.message);
    return null;
  }
}

module.exports = router;
module.exports.setInternalFromCost = setInternalFromCost;
