// ══════════════════════════════════════════════════════
// BUNAI B2B (/api/b2b)
//
// The wholesale order book: who bought, what, for how much, how much of it has
// actually been paid, and where the goods are. Unlike the online orders in
// vin_orders — which Vinculum fills and nobody types — every one of these is
// entered by a person and edited over the following weeks as money arrives and
// the goods move.
//
// Every order lands in two places, this database and the client's Google Sheet,
// on the same terms as the influencer tracker: saved here first, written there
// second, so an unshared or renamed sheet costs the day's work nothing.
//
// Two figures are worked out rather than trusted:
//   • the balance is always the order value minus what has come in, so it can
//     never drift from the two numbers it is made of;
//   • the order value defaults to pieces × rate but can be overridden, because
//     a negotiated price is a real fact that the multiplication cannot express.
// ══════════════════════════════════════════════════════
const express = require('express');
const config = require('../config');
const google = require('../services/google');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();

// The sheet's own column order, which is the client's, not ours. Column A of
// that sheet is the serial number, which is the row's position rather than a
// field anybody types, so it is not in this list.
const COLUMNS = [
  'party_name', 'contact_person', 'email', 'phone', 'city', 'what_was_sold',
  'pieces', 'rate_per_piece', 'total_order_value', 'payment_status',
  'amount_received', 'balance_amount', 'order_date', 'dispatch_date',
  'delivery_date', 'order_status', 'remarks',
];
const FIRST_COL = 'A';                      // Sr. No.
const LAST_COL = 'R';                       // Remarks — 1 + COLUMNS.length === 18
// Emptiness is judged by the party name, NOT by column A: the client's template
// arrives with the serial numbers 1…999 already typed in, so asking column A
// where the data ends would answer row 1001 every time.
const PROBE_COL = 'B';

const PAYMENT_STATUSES = ['Pending', 'Partial', 'Paid'];
const ORDER_STATUSES = ['New', 'Processing', 'Dispatched', 'Delivered', 'Cancelled'];
// A cancelled order is not revenue. The Sales page has always taken this line
// with the online orders; the B2B roll-up beside it takes the same one.
const LIVE = "COALESCE(order_status,'') <> 'Cancelled'";

const clean = (v, max = 255) => String(v ?? '').trim().slice(0, max);
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);

// Blank stays blank: an order with no rate yet is different from one at zero,
// and only one of those should be summed as nothing.
const numOrNull = (v) => {
  const s = String(v ?? '').trim().replace(/[, ]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const intOrNull = (v) => {
  const n = numOrNull(v);
  return n === null ? null : Math.round(n);
};
const round2 = (n) => Math.round(n * 100) / 100;

// "2026-09-28" → "28/09/2026", which is how the sheet's other dates read.
const slash = (v) => {
  if (!v) return '';
  const [y, m, d] = String(v).slice(0, 10).split('-');
  return d ? `${d}/${m}/${y}` : String(v);
};

const SELECT = `
  SELECT b.*, u.name AS created_by_name,
         DATE_FORMAT(b.order_date,'%Y-%m-%d')    AS order_date,
         DATE_FORMAT(b.dispatch_date,'%Y-%m-%d') AS dispatch_date,
         DATE_FORMAT(b.delivery_date,'%Y-%m-%d') AS delivery_date,
         DATE_FORMAT(b.created_at,'%Y-%m-%d %H:%i') AS created_at
    FROM b2b_orders b
    LEFT JOIN users u ON u.id = b.created_by`;

function fromBody(b) {
  const pieces = intOrNull(b.pieces);
  const rate = numOrNull(b.rate_per_piece);
  // Pieces × rate is the default, not the rule — a typed total wins, so a
  // discount or a rounded-off invoice survives being saved.
  let total = numOrNull(b.total_order_value);
  if (total === null && pieces !== null && rate !== null) total = round2(pieces * rate);
  const received = numOrNull(b.amount_received);
  // Never taken from the form. Two numbers and a subtraction cannot disagree
  // with each other; a third stored number can, and eventually does.
  const balance = total === null ? null : round2(total - (received || 0));

  return {
    party_name: clean(b.party_name),
    contact_person: clean(b.contact_person),
    email: clean(b.email),
    phone: clean(b.phone, 50),
    city: clean(b.city, 160),
    what_was_sold: clean(b.what_was_sold, 1000),
    pieces,
    rate_per_piece: rate,
    total_order_value: total,
    payment_status: PAYMENT_STATUSES.includes(clean(b.payment_status)) ? clean(b.payment_status) : '',
    amount_received: received,
    balance_amount: balance,
    order_date: dateOrNull(b.order_date),
    dispatch_date: dateOrNull(b.dispatch_date),
    delivery_date: dateOrNull(b.delivery_date),
    order_status: ORDER_STATUSES.includes(clean(b.order_status)) ? clean(b.order_status) : '',
    remarks: clean(b.remarks, 1000),
  };
}

// The row as the sheet wants it: the serial number, then the seventeen fields.
// Money goes across as a bare number so the client can sum a column; a rupee
// sign would turn every one of them into text.
const DATE_FIELDS = ['order_date', 'dispatch_date', 'delivery_date'];
const MONEY_FIELDS = ['rate_per_piece', 'total_order_value', 'amount_received', 'balance_amount'];
const asRow = (r, serial) => [serial, ...COLUMNS.map((c) => {
  if (DATE_FIELDS.includes(c)) return slash(r[c]);
  if (MONEY_FIELDS.includes(c) || c === 'pieces') return (r[c] === null || r[c] === undefined ? '' : r[c]);
  return r[c] || '';
})];

// ── The Google Sheet half ─────────────────────────────
// None of this throws. An order that saved here and failed to reach the sheet
// is worth keeping and worth saying so about; it is not worth losing.

const sheetConfigured = () => !!config.sheets.b2b.id;

const tab = () => google.resolveTabNameByGid(config.sheets.b2b.id, config.sheets.b2b.gid);

// The first line with no party name on it, at or after the start row.
async function nextRow(tabName) {
  const { id, startRow } = config.sheets.b2b;
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
    const { id, startRow } = config.sheets.b2b;
    const tabName = await tab();
    const at = row || await nextRow(tabName);
    const api = await google.getWriteClient();
    await api.spreadsheets.values.update({
      spreadsheetId: id,
      range: `${tabName}!${FIRST_COL}${at}:${LAST_COL}${at}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [asRow(record, at - startRow + 1)] },
    });
    google.invalidateSheet(id);
    return { ok: true, row: at };
  } catch (err) {
    console.error('⚠️ B2B sheet write failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

// ── The API ───────────────────────────────────────────

router.get('/b2b', requireAuth, asyncRoute(async (req, res) => {
  const q = clean(req.query.q, 120);
  const orderStatus = ORDER_STATUSES.includes(req.query.order_status) ? req.query.order_status : '';
  const paymentStatus = PAYMENT_STATUSES.includes(req.query.payment_status) ? req.query.payment_status : '';
  const where = [];
  const args = [];
  if (q) {
    where.push(`(b.party_name LIKE ? OR b.contact_person LIKE ? OR b.email LIKE ?
                 OR b.phone LIKE ? OR b.city LIKE ? OR b.what_was_sold LIKE ?)`);
    for (let i = 0; i < 6; i++) args.push(`%${q}%`);
  }
  if (orderStatus) { where.push('b.order_status = ?'); args.push(orderStatus); }
  if (paymentStatus) { where.push('b.payment_status = ?'); args.push(paymentStatus); }
  const rows = await db.rows(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY b.order_date IS NULL, b.order_date DESC, b.id DESC LIMIT 2000`, args);
  res.json(rows);
}));

// What the page needs to know without asking five times.
router.get('/b2b/meta', requireAuth, asyncRoute(async (req, res) => {
  const [totals, byOrder, byPayment] = await Promise.all([
    db.one(
      `SELECT COUNT(*) orders,
              SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END) live_orders,
              ROUND(SUM(CASE WHEN ${LIVE} THEN COALESCE(total_order_value,0) ELSE 0 END)) revenue,
              ROUND(SUM(CASE WHEN ${LIVE} THEN COALESCE(amount_received,0) ELSE 0 END)) received,
              ROUND(SUM(CASE WHEN ${LIVE} THEN COALESCE(balance_amount,0) ELSE 0 END)) outstanding,
              SUM(CASE WHEN ${LIVE} THEN COALESCE(pieces,0) ELSE 0 END) pieces
         FROM b2b_orders`),
    db.rows(`SELECT COALESCE(NULLIF(order_status,''),'—') s, COUNT(*) n
               FROM b2b_orders GROUP BY s`),
    db.rows(`SELECT COALESCE(NULLIF(payment_status,''),'—') s, COUNT(*) n
               FROM b2b_orders GROUP BY s`),
  ]);
  res.json({
    paymentStatuses: PAYMENT_STATUSES,
    orderStatuses: ORDER_STATUSES,
    sheet: sheetConfigured(),
    // Worth saying out loud on the page: without this the team fills the app
    // and quietly wonders why the client's sheet is empty.
    serviceAccount: sheetConfigured() ? null : google.serviceAccountEmail(),
    orders: Number(totals?.orders || 0),
    liveOrders: Number(totals?.live_orders || 0),
    revenue: Number(totals?.revenue || 0),
    received: Number(totals?.received || 0),
    outstanding: Number(totals?.outstanding || 0),
    pieces: Number(totals?.pieces || 0),
    byOrderStatus: Object.fromEntries(byOrder.map(r => [r.s, Number(r.n) || 0])),
    byPaymentStatus: Object.fromEntries(byPayment.map(r => [r.s, Number(r.n) || 0])),
  });
}));

router.post('/b2b', requireAuth, asyncRoute(async (req, res) => {
  const d = fromBody(req.body || {});
  if (!d.party_name) return res.status(400).json({ error: 'The party name is required' });

  const cols = Object.keys(d);
  const [ins] = await db.query(
    `INSERT INTO b2b_orders (${cols.join(',')}, created_by)
     VALUES (${cols.map(() => '?').join(',')}, ?)`,
    [...Object.values(d), req.session.userId]);
  const id = ins.insertId;

  const sheet = await writeRow(null, d);
  if (sheet.ok) await db.query('UPDATE b2b_orders SET sheet_row=? WHERE id=?', [sheet.row, id]);

  res.json({ id, sheet: sheet.ok, sheetError: sheet.ok ? null : sheet.reason });
}));

router.put('/b2b/:id', requireAuth, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await db.one('SELECT * FROM b2b_orders WHERE id=?', [id]);
  if (!existing) throw httpError(404, 'Not found');

  const d = fromBody(req.body || {});
  if (!d.party_name) return res.status(400).json({ error: 'The party name is required' });

  await db.query(
    `UPDATE b2b_orders SET ${Object.keys(d).map(k => `${k}=?`).join(', ')} WHERE id=?`,
    [...Object.values(d), id]);

  // Its own line if it has one; a new line at the bottom if the sheet was not
  // configured when the order was first saved.
  const sheet = await writeRow(existing.sheet_row || null, d);
  if (sheet.ok && sheet.row !== existing.sheet_row) {
    await db.query('UPDATE b2b_orders SET sheet_row=? WHERE id=?', [sheet.row, id]);
  }

  res.json({ success: true, sheet: sheet.ok, sheetError: sheet.ok ? null : sheet.reason });
}));

// Only the row here. The line in the sheet is left where it is: deleting it
// would shift every row under it, and every other order's sheet_row with it.
router.delete('/b2b/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  await db.query('DELETE FROM b2b_orders WHERE id=?', [parseInt(req.params.id, 10)]);
  res.json({ success: true });
}));

module.exports = router;
