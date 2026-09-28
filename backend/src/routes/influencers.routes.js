// ══════════════════════════════════════════════════════
// INFLUENCERS (/api/influencers)
//
// The marketing team's tracker: who has been approved, who has been messaged,
// what was shipped and when the post went up.
//
// Every row lands in two places — this database and the team's Google Sheet,
// because that sheet is what they read and share. The database is the one that
// decides: a row is saved here first and written there second, so a sheet that
// is unshared, renamed or simply down costs the day's work nothing.
//
// The three dates arrive days apart, so a record is created early and finished
// later. Each change rewrites that record's own line in the sheet rather than
// appending another copy of the same influencer.
// ══════════════════════════════════════════════════════
const express = require('express');
const config = require('../config');
const google = require('../services/google');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();

// The sheet's own column order, which is the client's, not ours.
const COLUMNS = [
  'name', 'profile_link', 'status', 'message_sent_on', 'collaboration_type',
  'shipping_address', 'email', 'phone', 'shipped_on', 'received_on', 'post_date',
];
const LAST_COL = 'K';                       // COLUMNS.length === 11

const STATUSES = ['Approved', 'Not Approved'];
const TYPES = ['Barter', 'Paid', 'Sourcing'];

const clean = (v, max = 255) => String(v ?? '').trim().slice(0, max);
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);
// "2026-09-28" → "28/09/2026", which is how the sheet's other dates read.
const slash = (v) => {
  if (!v) return '';
  const [y, m, d] = String(v).slice(0, 10).split('-');
  return d ? `${d}/${m}/${y}` : String(v);
};

const SELECT = `
  SELECT i.*, u.name AS created_by_name,
         DATE_FORMAT(i.message_sent_on,'%Y-%m-%d') AS message_sent_on,
         DATE_FORMAT(i.shipped_on,'%Y-%m-%d')      AS shipped_on,
         DATE_FORMAT(i.received_on,'%Y-%m-%d')     AS received_on,
         DATE_FORMAT(i.post_date,'%Y-%m-%d')       AS post_date,
         DATE_FORMAT(i.created_at,'%Y-%m-%d %H:%i') AS created_at
    FROM influencers i
    LEFT JOIN users u ON u.id = i.created_by`;

function fromBody(b) {
  const status = STATUSES.includes(clean(b.status)) ? clean(b.status) : '';
  const type = TYPES.includes(clean(b.collaboration_type)) ? clean(b.collaboration_type) : '';
  return {
    name: clean(b.name),
    profile_link: clean(b.profile_link, 500),
    status,
    message_sent_on: dateOrNull(b.message_sent_on),
    collaboration_type: type,
    shipping_address: clean(b.shipping_address, 1000),
    email: clean(b.email),
    phone: clean(b.phone, 50),
    shipped_on: dateOrNull(b.shipped_on),
    received_on: dateOrNull(b.received_on),
    post_date: dateOrNull(b.post_date),
  };
}

// The row as the sheet wants it: the same eleven columns, dates written the
// way a person reads them.
const asRow = (r) => COLUMNS.map((c) => (
  ['message_sent_on', 'shipped_on', 'received_on', 'post_date'].includes(c) ? slash(r[c]) : (r[c] || '')
));

// ── The Google Sheet half ─────────────────────────────
// None of this throws. A record that saved here and failed to reach the sheet
// is worth keeping and worth saying so about; it is not worth losing.

function sheetConfigured() {
  return !!config.sheets.influencer.id;
}

async function tab() {
  const { id, gid } = config.sheets.influencer;
  return google.resolveTabNameByGid(id, gid);
}

// The first empty line at or after the start row, found by reading column A.
// Appending blind puts a row under whatever stray data is furthest down the
// sheet; this puts it under the last influencer.
async function nextRow(tabName) {
  const { id, startRow } = config.sheets.influencer;
  const colA = await google.readValues(id, `${tabName}!A${startRow}:A100000`, { fresh: true });
  for (let i = 0; i < colA.length; i++) {
    if (!colA[i] || !String(colA[i][0] || '').trim()) return startRow + i;
  }
  return startRow + colA.length;
}

async function writeRow(row, record) {
  if (!sheetConfigured()) return { ok: false, reason: 'no sheet configured' };
  try {
    const { id } = config.sheets.influencer;
    const tabName = await tab();
    const at = row || await nextRow(tabName);
    const api = await google.getWriteClient();
    await api.spreadsheets.values.update({
      spreadsheetId: id,
      range: `${tabName}!A${at}:${LAST_COL}${at}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [asRow(record)] },
    });
    google.invalidateSheet(id);
    return { ok: true, row: at };
  } catch (err) {
    console.error('⚠️ Influencer sheet write failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

// ── The API ───────────────────────────────────────────

router.get('/influencers', requireAuth, asyncRoute(async (req, res) => {
  const q = clean(req.query.q, 120);
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const where = [];
  const args = [];
  if (q) {
    where.push('(i.name LIKE ? OR i.email LIKE ? OR i.phone LIKE ? OR i.profile_link LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status) { where.push('i.status = ?'); args.push(status); }
  const rows = await db.rows(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY i.id DESC LIMIT 1000`, args);
  res.json(rows);
}));

// What the page needs to know without asking three times.
router.get('/influencers/meta', requireAuth, asyncRoute(async (req, res) => {
  const counts = await db.rows(
    `SELECT status, COUNT(*) AS n FROM influencers GROUP BY status`);
  const byStatus = Object.fromEntries(counts.map(c => [c.status || '—', Number(c.n) || 0]));
  const total = counts.reduce((sum, c) => sum + Number(c.n || 0), 0);
  const posted = await db.one('SELECT COUNT(*) AS n FROM influencers WHERE post_date IS NOT NULL');
  const awaiting = await db.one(
    'SELECT COUNT(*) AS n FROM influencers WHERE shipped_on IS NOT NULL AND received_on IS NULL');
  res.json({
    statuses: STATUSES,
    types: TYPES,
    sheet: sheetConfigured(),
    // Worth saying out loud on the page: without this the team fills the app
    // and quietly wonders why their sheet is empty.
    serviceAccount: sheetConfigured() ? null : google.serviceAccountEmail(),
    total, byStatus,
    posted: Number(posted?.n || 0),
    awaitingDelivery: Number(awaiting?.n || 0),
  });
}));

router.post('/influencers', requireAuth, asyncRoute(async (req, res) => {
  const d = fromBody(req.body || {});
  if (!d.name) return res.status(400).json({ error: 'The influencer’s name is required' });

  const cols = Object.keys(d);
  const [ins] = await db.query(
    `INSERT INTO influencers (${cols.join(',')}, created_by)
     VALUES (${cols.map(() => '?').join(',')}, ?)`,
    [...Object.values(d), req.session.userId]);
  const id = ins.insertId;

  const sheet = await writeRow(null, d);
  if (sheet.ok) await db.query('UPDATE influencers SET sheet_row=? WHERE id=?', [sheet.row, id]);

  res.json({ id, sheet: sheet.ok, sheetError: sheet.ok ? null : sheet.reason });
}));

router.put('/influencers/:id', requireAuth, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await db.one('SELECT * FROM influencers WHERE id=?', [id]);
  if (!existing) throw httpError(404, 'Not found');

  const d = fromBody(req.body || {});
  if (!d.name) return res.status(400).json({ error: 'The influencer’s name is required' });

  await db.query(
    `UPDATE influencers SET ${Object.keys(d).map(k => `${k}=?`).join(', ')} WHERE id=?`,
    [...Object.values(d), id]);

  // Its own line if it has one; a new line at the bottom if the sheet was not
  // configured when it was first saved.
  const sheet = await writeRow(existing.sheet_row || null, d);
  if (sheet.ok && sheet.row !== existing.sheet_row) {
    await db.query('UPDATE influencers SET sheet_row=? WHERE id=?', [sheet.row, id]);
  }

  res.json({ success: true, sheet: sheet.ok, sheetError: sheet.ok ? null : sheet.reason });
}));

// Only the row here. The line in the sheet is left where it is: deleting it
// would shift every row under it, and every other record's sheet_row with it.
router.delete('/influencers/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  await db.query('DELETE FROM influencers WHERE id=?', [parseInt(req.params.id, 10)]);
  res.json({ success: true });
}));

module.exports = router;
