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

// The SKU lines of an order, cleaned, with each line's amount worked out here
// rather than taken from the form: qty x price, less the discount - a
// percentage of the line, or a rupee amount off it - and never below zero.
const DISC_TYPES = ['pct', 'amt'];
function linesFromBody(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 500).map((l) => {
    const sku = clean(l && l.sku, 160);
    if (!sku) return null;
    const qty = Math.max(1, intOrNull(l.qty) || 1);
    const price = numOrNull(l.price);
    const discType = DISC_TYPES.includes(l.disc_type) ? l.disc_type : 'pct';
    let disc = numOrNull(l.disc_value);
    if (disc !== null) disc = Math.max(0, discType === 'pct' ? Math.min(100, disc) : disc);
    let amount = null;
    if (price !== null) {
      const gross = qty * price;
      const off = disc === null ? 0 : (discType === 'pct' ? gross * disc / 100 : disc);
      amount = round2(Math.max(0, gross - off));
    }
    return { sku, qty, price, disc_type: discType, disc_value: disc, amount };
  }).filter(Boolean);
}

async function saveLines(orderId, lines) {
  await db.query('DELETE FROM b2b_order_lines WHERE order_id = ?', [orderId]);
  if (!lines.length) return;
  await db.query(
    `INSERT INTO b2b_order_lines (order_id, position, sku, qty, price, disc_type, disc_value, amount) VALUES ?`,
    [lines.map((l, i) => [orderId, i, l.sku, l.qty, l.price, l.disc_type, l.disc_value, l.amount])]);
}

function fromBody(b, lines = []) {
  let pieces = intOrNull(b.pieces);
  let rate = numOrNull(b.rate_per_piece);
  // Pieces × rate is the default, not the rule — a typed total wins, so a
  // discount or a rounded-off invoice survives being saved.
  let total = numOrNull(b.total_order_value);
  if (total === null && pieces !== null && rate !== null) total = round2(pieces * rate);
  // An order with SKU lines is the sum of them, and its "what was sold" for
  // the sheet is the list - the sheet has no lines of its own to put them in.
  let sold = clean(b.what_was_sold, 1000);
  if (lines.length) {
    pieces = lines.reduce((a, l) => a + l.qty, 0);
    rate = null;
    total = lines.some((l) => l.amount !== null)
      ? round2(lines.reduce((a, l) => a + (l.amount || 0), 0)) : null;
    sold = lines.map((l) => l.sku + (l.qty > 1 ? ' x' + l.qty : '')).join(', ').slice(0, 1000);
  }
  // GST goes on top of the order value: 5%, 18% or whatever was typed. Without a
  // rate (an order from before GST) the total is the value as it was.
  let gstRate = numOrNull(b.gst_rate);
  if (gstRate !== null) gstRate = Math.max(0, Math.min(100, gstRate));
  const subtotal = total;
  if (subtotal !== null && gstRate !== null) total = round2(subtotal * (1 + gstRate / 100));
  const received = numOrNull(b.amount_received);
  // Never taken from the form. Two numbers and a subtraction cannot disagree
  // with each other; a third stored number can, and eventually does.
  const balance = total === null ? null : round2(total - (received || 0));

  return {
    party_name: clean(b.party_name),
    contact_person: clean(b.contact_person),
    owner_name: clean(b.owner_name),
    email: clean(b.email),
    email2: clean(b.email2),
    phone: clean(b.phone, 50),
    whatsapp: clean(b.whatsapp, 50),
    address: clean(b.address, 500),
    city: clean(b.city, 160),
    state: clean(b.state, 120),
    pincode: clean(b.pincode, 12),
    what_was_sold: sold,
    pieces,
    rate_per_piece: rate,
    subtotal,
    gst_rate: gstRate,
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
    where.push(`(b.party_name LIKE ? OR b.contact_person LIKE ? OR b.owner_name LIKE ?
                 OR b.email LIKE ? OR b.email2 LIKE ? OR b.phone LIKE ? OR b.whatsapp LIKE ?
                 OR b.city LIKE ? OR b.state LIKE ? OR b.what_was_sold LIKE ?
                 OR b.id IN (SELECT order_id FROM b2b_order_lines WHERE sku LIKE ?))`);
    for (let i = 0; i < 11; i++) args.push(`%${q}%`);
  }
  if (orderStatus) { where.push('b.order_status = ?'); args.push(orderStatus); }
  if (paymentStatus) { where.push('b.payment_status = ?'); args.push(paymentStatus); }
  const rows = await db.rows(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY b.order_date IS NULL, b.order_date DESC, b.id DESC LIMIT 2000`, args);
  // Each order's SKU lines, with the product name from the catalogue.
  const byOrder = {};
  if (rows.length) {
    const lines = await db.rows(
      `SELECT l.order_id, l.sku, l.qty, l.price, l.disc_type, l.disc_value, l.amount,
              COALESCE(i.name, '') name
         FROM b2b_order_lines l LEFT JOIN uni_items i ON i.sku = l.sku
        WHERE l.order_id IN (?) ORDER BY l.order_id, l.position`, [rows.map((r) => r.id)]);
    lines.forEach((l) => (byOrder[l.order_id] = byOrder[l.order_id] || []).push({
      sku: l.sku, name: l.name, qty: Number(l.qty),
      price: l.price === null ? null : Number(l.price),
      disc_type: l.disc_type, disc_value: l.disc_value === null ? null : Number(l.disc_value),
      amount: l.amount === null ? null : Number(l.amount),
    }));
  }
  res.json(rows.map((r) => ({ ...r, lines: byOrder[r.id] || [] })));
}));

// SKU suggestions for the order lines, from the Unicommerce catalogue.
router.get('/b2b/skus', requireAuth, asyncRoute(async (req, res) => {
  const q = clean(req.query.q, 80);
  if (q.length < 2) return res.json([]);
  const rows = await db.rows(
    `SELECT sku, name FROM uni_items
      WHERE enabled = 1 AND (sku LIKE ? OR name LIKE ?)
      ORDER BY sku LIKE ? DESC, sku LIMIT 25`, [`%${q}%`, `%${q}%`, `${q}%`]);
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
  const lines = linesFromBody((req.body || {}).lines);
  const d = fromBody(req.body || {}, lines);
  if (!d.party_name) return res.status(400).json({ error: 'The party name is required' });

  const cols = Object.keys(d);
  const [ins] = await db.query(
    `INSERT INTO b2b_orders (${cols.join(',')}, created_by)
     VALUES (${cols.map(() => '?').join(',')}, ?)`,
    [...Object.values(d), req.session.userId]);
  const id = ins.insertId;
  await saveLines(id, lines);

  const sheet = await writeRow(null, d);
  if (sheet.ok) await db.query('UPDATE b2b_orders SET sheet_row=? WHERE id=?', [sheet.row, id]);

  res.json({ id, sheet: sheet.ok, sheetError: sheet.ok ? null : sheet.reason });
}));

router.put('/b2b/:id', requireAuth, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await db.one('SELECT * FROM b2b_orders WHERE id=?', [id]);
  if (!existing) throw httpError(404, 'Not found');

  const lines = linesFromBody((req.body || {}).lines);
  const d = fromBody(req.body || {}, lines);
  if (!d.party_name) return res.status(400).json({ error: 'The party name is required' });

  await db.query(
    `UPDATE b2b_orders SET ${Object.keys(d).map(k => `${k}=?`).join(', ')} WHERE id=?`,
    [...Object.values(d), id]);
  await saveLines(id, lines);

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
  const id = parseInt(req.params.id, 10);
  await db.query('DELETE FROM b2b_order_lines WHERE order_id=?', [id]);
  await db.query('DELETE FROM b2b_orders WHERE id=?', [id]);
  res.json({ success: true });
}));


// ── Parties: customers and prospects ──────────────────
//
// Two sub-tabs over one idea. A party with an order is a customer; one without
// is a prospect. Nothing stores which — the first order moves them across on
// its own, and nobody has to remember to change a field.
//
// b2b_orders is the record of what was sold and b2b_parties is the record of
// who is being talked to. A party can appear in either or both: added as a
// prospect and then bought, or never written down and simply ordered.

const partyTxt = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function partyBody(req) {
  const b = req.body || {};
  return {
    party_name: partyTxt(b.party_name, 255),
    contact_person: partyTxt(b.contact_person, 255),
    owner_name: partyTxt(b.owner_name, 255),
    email: partyTxt(b.email, 255),
    phone: partyTxt(b.phone, 50),
    whatsapp: partyTxt(b.whatsapp, 50),
    address: partyTxt(b.address, 500),
    city: partyTxt(b.city, 120),
    state: partyTxt(b.state, 120),
    pincode: partyTxt(b.pincode, 12),
    notes: partyTxt(b.notes, 1000),
  };
}

const PARTY_COLS = ['party_name', 'contact_person', 'owner_name', 'email', 'phone', 'whatsapp',
  'address', 'city', 'state', 'pincode', 'notes'];

router.get('/b2b/parties', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const q = partyTxt(req.query.q, 120);
  const like = '%' + q + '%';

  // Customers come out of the order book, because that is what makes one.
  // b2b_parties is joined for the contact details, which an order may not
  // carry if it was typed in a hurry.
  const customers = await db.rows(
    `SELECT o.party_name,
            COALESCE(NULLIF(MAX(p.contact_person),''), MAX(o.contact_person)) contact_person,
            COALESCE(NULLIF(MAX(p.email),''), MAX(o.email)) email,
            COALESCE(NULLIF(MAX(p.phone),''), MAX(o.phone)) phone,
            COALESCE(NULLIF(MAX(p.city),''), MAX(o.city)) city,
            MAX(p.notes) notes, MAX(p.id) party_id,
            COUNT(*) orders,
            ROUND(SUM(COALESCE(o.total_order_value,0))) value,
            ROUND(SUM(COALESCE(o.amount_received,0))) received,
            ROUND(SUM(COALESCE(o.balance_amount,0))) balance,
            SUM(COALESCE(o.pieces,0)) pieces,
            MAX(o.order_date) last_order
       FROM b2b_orders o
       LEFT JOIN b2b_parties p ON p.party_name = o.party_name
      WHERE o.party_name <> ''
        ${q ? 'AND (o.party_name LIKE ? OR o.contact_person LIKE ? OR o.city LIKE ?)' : ''}
      GROUP BY o.party_name
      ORDER BY value DESC`, q ? [like, like, like] : []);

  // Prospects are the ones the order book has never heard of.
  const prospects = await db.rows(
    `SELECT p.id party_id, p.party_name, p.contact_person, p.owner_name, p.email, p.phone,
            p.whatsapp, p.address, p.city, p.state, p.pincode, p.notes, p.created_at
       FROM b2b_parties p
      WHERE NOT EXISTS (SELECT 1 FROM b2b_orders o WHERE o.party_name = p.party_name)
        ${q ? 'AND (p.party_name LIKE ? OR p.contact_person LIKE ? OR p.city LIKE ?)' : ''}
      ORDER BY p.created_at DESC`, q ? [like, like, like] : []);

  res.json({
    customers, prospects,
    counts: { customers: customers.length, prospects: prospects.length },
  });
}));

router.post('/b2b/parties', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const v = partyBody(req);
  if (!v.party_name) throw httpError(400, 'Party name is required');

  const dup = await db.one('SELECT id FROM b2b_parties WHERE party_name = ?', [v.party_name]);
  if (dup) throw httpError(409, `"${v.party_name}" is already on the list`);

  const [r] = await db.query(
    `INSERT INTO b2b_parties (${PARTY_COLS.join(', ')}, created_by)
     VALUES (${PARTY_COLS.map(() => '?').join(', ')}, ?)`,
    [...PARTY_COLS.map(c => v[c]), req.user?.userId || null]);
  res.json({ ok: true, id: r.insertId });
}));

router.put('/b2b/parties/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const v = partyBody(req);
  if (!v.party_name) throw httpError(400, 'Party name is required');

  const dup = await db.one(
    'SELECT id FROM b2b_parties WHERE party_name = ? AND id <> ?', [v.party_name, id]);
  if (dup) throw httpError(409, `"${v.party_name}" is already on the list`);

  const [r] = await db.query(
    `UPDATE b2b_parties SET ${PARTY_COLS.map(c => c + ' = ?').join(', ')} WHERE id = ?`,
    [...PARTY_COLS.map(c => v[c]), id]);
  if (!r.affectedRows) throw httpError(404, 'Party not found');
  res.json({ ok: true });
}));

router.delete('/b2b/parties/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  // Only the contact record goes. Any orders in that party's name stay — they
  // are what was actually sold, and deleting a contact card is not a reason to
  // lose them.
  const [r] = await db.query('DELETE FROM b2b_parties WHERE id = ?', [Number(req.params.id)]);
  if (!r.affectedRows) throw httpError(404, 'Party not found');
  res.json({ ok: true });
}));

module.exports = router;
