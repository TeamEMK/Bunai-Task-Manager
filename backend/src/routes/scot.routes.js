// ══════════════════════════════════════════════════════
// SCOT (/api/scot) — the customer calling list.
//
// The sheet this comes from is a wall of 364 date columns, one per day, which
// is how a spreadsheet draws a history. The question it is actually there to
// answer is much smaller: who should be rung today, and who has gone quiet. So
// the grid is not reproduced here — the answer is.
//
// A customer's rhythm is their own: the average gap between their orders.
// Someone who buys every fortnight is overdue after a fortnight; someone who
// buys twice a year is not. Expected next order is the last one plus that gap.
//
// The status rule is the sheet's, kept the same so the two never disagree:
//   gone      — past due by more than a whole cycle
//   overdue   — past the expected date
//   due       — within two days of it
//   on track  — everything else
//   one-time  — a single order, so there is no rhythm to be late against
//
// The work is done in SQL, not in JavaScript. There are 252,000 customers
// behind this; building them all as objects to sort and slice took 31 seconds.
// The database groups, ranks and cuts to a page, which is what it is for.
//
// Phone is the key. The integration wrote sfy@sfy.com wherever Shopify sent no
// email, so grouping on email merges strangers.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const multer = require('multer');
const config = require('../config');
const google = require('../services/google');
const { requireAuth, requirePage } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();

// Everything in sfy_orders is IST; "today" has to be India's, not the server's.
const TODAY = `DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE)`;
const KEY = `RIGHT(REGEXP_REPLACE(COALESCE(o.customer_phone,''), '[^0-9]', ''), 10)`;

const STATUSES = ['gone', 'overdue', 'due', 'on-track', 'one-time'];

// "Outside India" is a filter on where they live, not a verdict on how they
// buy, so it sits beside the statuses in the tab strip but is not one. A
// customer with no country on file is in neither group.
const ABROAD = `country <> '' AND country <> 'IN'`;

// One row per customer already — sfy_customers is rebuilt by the Shopify sync.
// Only the verdict is worked out here, because it depends on today and would
// be wrong by morning if it were stored.
const BASE = `
  SELECT phone, name, email, city, country, orders, units, value,
         DATE_FORMAT(first_order, '%Y-%m-%d') first_order,
         DATE_FORMAT(last_order, '%Y-%m-%d') last_order,
         DATEDIFF(${TODAY}, DATE(last_order)) days_since,
         gap_days gap,
         CASE
           WHEN orders <= 1 THEN 'one-time'
           WHEN DATEDIFF(${TODAY}, DATE(last_order)) - gap_days > gap_days THEN 'gone'
           WHEN DATEDIFF(${TODAY}, DATE(last_order)) - gap_days > 0 THEN 'overdue'
           WHEN DATEDIFF(${TODAY}, DATE(last_order)) - gap_days >= -2 THEN 'due'
           ELSE 'on-track'
         END AS status
    FROM sfy_customers`;

// Biggest lifetime spender first, on every tab. "Everyone" used to put the
// overdue band above the rest, which hid a 16-lakh customer who had gone quiet
// below a 2-lakh one who was merely late; the status tabs are how to look at
// one band. Sorting on value alone also lets MySQL walk the value index and
// stop at the page, instead of building all 252,000 verdicts to sort them.
const ORDER = `ORDER BY value DESC`;

// The tab badges: one read for every status, Outside India and Never ordered,
// kept for two minutes. They only move when a sync rebuilds the tables, and
// counting a quarter of a million customers on every click and keystroke was
// most of what made the page slow.
const COUNTS_TTL_MS = 2 * 60 * 1000;
let countsCache = null;   // { at, by, abroad, never, sheet, asOf }
async function tabCounts() {
  if (countsCache && Date.now() - countsCache.at < COUNTS_TTL_MS) return countsCache;
  const [byStatus, never, sheetLog, asOf] = await Promise.all([
    db.rows(`SELECT status, COUNT(*) n, SUM(${ABROAD}) abroad FROM (${BASE}) y GROUP BY status`),
    db.one('SELECT COUNT(*) n FROM sfy_prospects').catch(() => null),
    // When each tab of the Google Sheet was last written, in India's time. The
    // table may not exist on a database the sheet has never been written from.
    db.rows(`SELECT tab, DATE_FORMAT(MAX(ended_at) + INTERVAL 330 MINUTE, '%e %b, %l:%i %p') at
               FROM scot_sheet_log WHERE ok = 1 GROUP BY tab`).catch(() => null),
    prospectsAsOf(),
  ]);
  countsCache = {
    at: Date.now(),
    by: Object.fromEntries(byStatus.map(c => [c.status, Number(c.n)])),
    abroad: byStatus.reduce((a, c) => a + (Number(c.abroad) || 0), 0),
    never: Number(never?.n) || 0,
    sheet: sheetLog ? Object.fromEntries(sheetLog.map(r => [r.tab === 'SCOT Lifetime' ? 'lifetime' : 'scot', r.at])) : null,
    asOf,
  };
  return countsCache;
}

const LIMIT = 1500;

// "Never ordered" - people with a Shopify account and no order, from
// sfy_prospects. They have no rhythm, spend or status, so it is its own list
// rather than a status. Newest sign-up first: the people most likely to still
// remember the store. The export behind the first load had no sign-up date for
// some, and a customer id grows with time, so it orders those too.
//
// key is what their contact log is filed under: the phone, as for a customer,
// so the history follows them onto the calling list when they order; and for
// the third with no phone, their Shopify id.
const PROSPECT_KEY = `IF(phone <> '', phone, CONCAT('c', customer_id))`;

async function prospects(q) {
  const where = [];
  const args = [];
  if (q) {
    const hit = countryCodesMatching(q);
    where.push('(name LIKE ? OR phone LIKE ? OR email LIKE ? OR city LIKE ?'
      + (hit.length ? ' OR country IN (' + hit.map(() => '?').join(',') + ')' : '') + ')');
    const like = '%' + q + '%';
    args.push(like, like, like, like, ...hit);
  }
  const filter = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [rows, total] = await Promise.all([
    db.rows(`SELECT ${PROSPECT_KEY} AS ckey, name, email, phone_full, city, country,
                    accepts_email, accepts_sms, DATE_FORMAT(signed_up, '%Y-%m-%d') signed_up
               FROM sfy_prospects ${filter}
              ORDER BY signed_up IS NULL, signed_up DESC, customer_id DESC LIMIT ${LIMIT}`, args),
    q ? db.one(`SELECT COUNT(*) n FROM sfy_prospects ${filter}`, args) : null,
  ]);
  const flag = (v) => (v == null ? null : !!Number(v));
  return {
    total: total ? Number(total.n) : null,
    rows: rows.map(r => ({
      phone: r.ckey,
      phoneShow: (r.phone_full || '').trim(),
      name: (r.name || '').trim() || '(no name)',
      email: (r.email || '').trim(),
      city: (r.city || '').trim(),
      country: (r.country || '').trim(),
      signedUp: r.signed_up,
      acceptsEmail: flag(r.accepts_email),
      acceptsSms: flag(r.accepts_sms),
    })),
  };
}

// When the never-ordered list was last brought up to date, in India's time.
async function prospectsAsOf() {
  try {
    const r = await db.one(
      `SELECT DATE_FORMAT(MAX(ended_at) + INTERVAL 330 MINUTE, '%e %b, %l:%i %p') at
         FROM sfy_prospect_sync_log WHERE ok = 1`);
    return r && r.at;
  } catch (_) { return null; }   // never synced on this database
}

// Every two-letter region code, with its English name, built once.
const REGION_NAMES = (() => {
  const out = [];
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = dn.of(code);
      if (name && name !== code) out.push([code, name.toLowerCase()]);
    }
  } catch (_) { /* no Intl region data: search falls back to the code */ }
  return out;
})();

function countryCodesMatching(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t.length < 2) return [];
  const byName = REGION_NAMES.filter(([, name]) => name.includes(t)).map(([code]) => code);
  return t.length === 2 && !byName.includes(t.toUpperCase()) ? [...byName, t.toUpperCase()] : byName;
}

router.get('/scot', requireAuth, requirePage('scot'), asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const status = STATUSES.includes(String(req.query.status || '')) ? String(req.query.status) : '';
  const never = req.query.status === 'never';

  // Filters on stored columns go in WHERE; the status is worked out per row,
  // so it is filtered in HAVING, which can name it.
  const where = [];
  const args = [];
  if (!status && req.query.status === 'abroad') where.push(ABROAD);
  if (q) {
    // Country is stored as its two-letter code, but people type "India" or
    // "australia". Whatever country names contain the text become the codes to
    // match, so both work.
    const hit = countryCodesMatching(q);
    where.push('(name LIKE ? OR phone LIKE ? OR city LIKE ? OR email LIKE ?'
      + (hit.length ? ' OR country IN (' + hit.map(() => '?').join(',') + ')' : '') + ')');
    const like = '%' + q + '%';
    args.push(like, like, like, like, ...hit);
  }
  const filter = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const having = status ? 'HAVING status = ?' : '';
  const rowArgs = status ? [...args, status] : args;

  // Counted over everyone, not the filtered set: the tiles are what the
  // filter is chosen from, so narrowing them would strand the other numbers.
  // Without a search the total is one of those counts, so it is not asked for.
  const [rows, tc, searched, pros] = await Promise.all([
    never ? [] : db.rows(`${BASE} ${filter} ${having} ${ORDER} LIMIT ${LIMIT}`, rowArgs),
    tabCounts(),
    never || !q ? null
      : db.one(`SELECT COUNT(*) n FROM (${BASE} ${filter}) y ${status ? 'WHERE status = ?' : ''}`, rowArgs),
    never ? prospects(q) : null,
  ]);
  const by = tc.by;
  const allCounts = {
    all: Object.values(by).reduce((a, n) => a + n, 0),
    abroad: tc.abroad,
    never: tc.never,
    ...STATUSES.reduce((a, s) => (a[s] = by[s] || 0, a), {}),
  };
  const total = searched ? { n: searched.n }
    : { n: status ? allCounts[status] : req.query.status === 'abroad' ? allCounts.abroad : allCounts.all };

  // For the customers on this page: the latest entry in EACH channel and how
  // many there are, so a new WhatsApp never hides the email beside it.
  const last = {};
  const phones = (never ? pros.rows : rows).map(r => r.phone);
  if (phones.length) {
    const L = await db.rows(
      `SELECT phone, channel, id, message, next_call_date, cnt, contact_date, updated_at_ist
         FROM (SELECT phone, channel, id, message,
                      DATE_FORMAT(contact_date, '%Y-%m-%d') AS contact_date,
                      DATE_FORMAT(next_call_date, '%Y-%m-%d') AS next_call_date,
                      DATE_FORMAT(updated_at + INTERVAL 330 MINUTE, '%e %b, %l:%i %p') AS updated_at_ist,
                      ROW_NUMBER() OVER (PARTITION BY phone, channel ORDER BY contact_date DESC, id DESC) AS rn,
                      COUNT(*) OVER (PARTITION BY phone, channel) AS cnt
                 FROM scot_contacts WHERE phone IN (?)) t
        WHERE rn = 1`, [phones]);
    L.forEach(r => {
      (last[r.phone] = last[r.phone] || {})[r.channel] = {
        date: r.contact_date, text: (r.message || '').slice(0, 90), nextCall: r.next_call_date,
        count: Number(r.cnt), updated: r.updated_at_ist,
      };
    });
  }
  if (never) {
    return res.json({
      mode: 'never',
      counts: allCounts,
      asOf: tc.asOf,
      total: pros.total == null ? allCounts.never : pros.total,
      rows: pros.rows.map(r => ({ ...r, contacts: last[r.phone] || {} })),
    });
  }

  res.json({
    sheet: tc.sheet,
    counts: allCounts,
    total: Number(total?.n) || 0,
    rows: rows.map(r => ({
      phone: r.phone,
      name: (r.name || '').trim() || '(no name)',
      email: (r.email || '').trim(),
      city: (r.city || '').trim(),
      country: (r.country || '').trim(),
      contacts: last[r.phone] || {},
      orders: Number(r.orders),
      units: Number(r.units) || 0,
      value: Number(r.value) || 0,
      firstOrder: r.first_order,
      lastOrder: r.last_order,
      daysSince: r.days_since == null ? null : Number(r.days_since),
      gap: r.gap == null ? null : Number(r.gap),
      // Expected next order. Worked out here rather than in SQL because it is
      // presentation, and the two numbers it needs are already to hand.
      callOn: r.gap == null ? null
        : new Date(Date.parse(r.last_order + 'T00:00:00Z') + Number(r.gap) * 86400000)
            .toISOString().slice(0, 10),
      status: r.status,
    })),
  });
}));

// ══════════════════════════════════════════════════════
// CONTACT LOG - what was done about a customer, by WhatsApp, email and phone.
//
// The three are kept apart on purpose. A newer WhatsApp must not push an older
// email out of sight, so "the latest" is worked out per channel, and the list
// carries one latest entry for each.
//
// Entries are added, not rewritten: ringing the same person two days later is
// a second row. "Latest" is the newest contact DATE (the date typed, which may
// be earlier than the day it was entered), and the later entry wins a tie.
// ══════════════════════════════════════════════════════
const CHANNELS = ['whatsapp', 'email', 'call'];

// India's date, which is what "today" means to the person typing.
const TODAY_IST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// Shown as typed; stored as a date. An entry can be for a day other than today.
const SHOW = `DATE_FORMAT(contact_date, '%Y-%m-%d') AS contact_date,
              DATE_FORMAT(next_call_date, '%Y-%m-%d') AS next_call_date,
              DATE_FORMAT(created_at + INTERVAL 330 MINUTE, '%e %b %Y, %l:%i %p') AS created_at_ist,
              DATE_FORMAT(updated_at + INTERVAL 330 MINUTE, '%e %b %Y, %l:%i %p') AS updated_at_ist,
              updated_at > created_at AS edited`;

function shape(r) {
  let files = [];
  try { files = JSON.parse(r.attachments || '[]'); } catch (_) { /* a bad cell is no attachments */ }
  return {
    id: r.id, channel: r.channel, date: r.contact_date, email: r.email || '',
    message: r.message || '', reply: r.reply || '', nextCall: r.next_call_date,
    files: (Array.isArray(files) ? files : []).filter(f => f && /^https?:\/\//.test(f.url || '')),
    by: r.created_by_name || '', at: r.created_at_ist, updated: r.updated_at_ist, edited: !!Number(r.edited),
  };
}

// Only what the form is allowed to carry for each channel. Email ID and
// attachments belong to WhatsApp/email, the next call date to a call.
function entryFromBody(b) {
  const channel = String(b.channel || '');
  if (!CHANNELS.includes(channel)) throw httpError(400, 'Choose WhatsApp, Email or Calling.');
  const date = b.date ? String(b.date) : TODAY_IST();
  if (!isYmd(date)) throw httpError(400, 'That date is not valid.');
  const next = b.nextCall ? String(b.nextCall) : null;
  if (next && !isYmd(next)) throw httpError(400, 'The next call date is not valid.');
  const files = channel === 'call' ? [] : (Array.isArray(b.files) ? b.files : [])
    .filter(f => f && /^https?:\/\//.test(String(f.url || '')))
    .slice(0, 10).map(f => ({ name: clip(f.name, 200) || 'file', url: clip(f.url, 600) }));
  return {
    channel, date,
    email: channel === 'email' ? clip(b.email, 255) : '',
    message: clip(b.message, 4000),
    reply: channel === 'call' ? '' : clip(b.reply, 4000),
    nextCall: channel === 'call' ? next : null,
    files: JSON.stringify(files),
  };
}

// A key is a customer's phone, a never-ordered prospect's phone, or "c" and the
// Shopify id of a prospect with no phone.
async function customerOrFail(phone) {
  const key = clip(phone, 20);
  const c = await db.one('SELECT phone FROM sfy_customers WHERE phone = ?', [key]);
  if (c) return c.phone;
  const id = /^c\d{1,19}$/.test(key) ? key.slice(1) : null;
  const p = key && await db.one(
    id ? `SELECT 1 ok FROM sfy_prospects WHERE customer_id = ? AND phone = ''`
       : 'SELECT 1 ok FROM sfy_prospects WHERE phone = ? LIMIT 1', [id || key]).catch(() => null);
  if (!p) throw httpError(404, 'That customer is not on the list.');
  return key;
}

// One customer's whole history, newest first within each channel, with a count
// per channel - the popup's "how many have we sent so far".
router.get('/scot/contacts', requireAuth, requirePage('scot'), asyncRoute(async (req, res) => {
  const phone = await customerOrFail(req.query.phone);
  const rows = await db.rows(
    `SELECT id, channel, email, message, reply, attachments, created_by_name, ${SHOW}
       FROM scot_contacts WHERE phone = ?
      ORDER BY contact_date DESC, id DESC`, [phone]);
  const out = { whatsapp: [], email: [], call: [] };
  rows.forEach(r => { if (out[r.channel]) out[r.channel].push(shape(r)); });
  res.json({ phone, entries: out, counts: { whatsapp: out.whatsapp.length, email: out.email.length, call: out.call.length } });
}));

router.post('/scot/contacts', requireAuth, requirePage('scot'), asyncRoute(async (req, res) => {
  const phone = await customerOrFail(req.body && req.body.phone);
  const e = entryFromBody(req.body || {});
  if (!e.message && !e.reply && e.files === '[]') throw httpError(400, 'Write what was said, or attach something.');
  const me = await db.one('SELECT name FROM users WHERE id = ?', [req.session.userId]);
  const [ins] = await db.query(
    `INSERT INTO scot_contacts
       (phone, channel, contact_date, email, message, reply, next_call_date, attachments,
        created_by, created_by_name, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [phone, e.channel, e.date, e.email, e.message, e.reply, e.nextCall, e.files,
     req.session.userId, (me && me.name) || req.session.name || '']);
  res.json({ id: ins.insertId });
}));

router.put('/scot/contacts/:id', requireAuth, requirePage('scot'), asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const had = await db.one('SELECT id, channel FROM scot_contacts WHERE id = ?', [id]);
  if (!had) throw httpError(404, 'That entry no longer exists.');
  // An entry stays in the channel it was made in.
  const e = entryFromBody({ ...(req.body || {}), channel: had.channel });
  if (!e.message && !e.reply && e.files === '[]') throw httpError(400, 'Write what was said, or attach something.');
  await db.query(
    `UPDATE scot_contacts
        SET contact_date=?, email=?, message=?, reply=?, next_call_date=?, attachments=?,
            updated_at = UTC_TIMESTAMP()
      WHERE id=?`,
    [e.date, e.email, e.message, e.reply, e.nextCall, e.files, id]);
  res.json({ success: true });
}));

router.delete('/scot/contacts/:id', requireAuth, requirePage('scot'), asyncRoute(async (req, res) => {
  await db.query('DELETE FROM scot_contacts WHERE id = ?', [parseInt(req.params.id, 10)]);
  res.json({ success: true });
}));

// ── attachments ───────────────────────────────────────
// A file goes to the client's Drive folder and the entry keeps the link, as the
// sample photos do. Kept under the 4.5 MB request cap a Vercel function has.
const FILE_OK = /\.(pdf|png|jpe?g|gif|webp|heic|docx?|xlsx?|csv|txt|pptx?)$/i;
const attach = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

router.post('/scot/attachment', requireAuth, requirePage('scot'), (req, res, next) => {
  attach.single('file')(req, res, (err) => {
    if (!err) return next();
    const big = err.code === 'LIMIT_FILE_SIZE';
    res.status(big ? 413 : 400).json({ error: big ? 'That file is too large - keep it under 4 MB.' : err.message });
  });
}, asyncRoute(async (req, res) => {
  if (!req.file) throw httpError(400, 'Choose a file to attach.');
  if (!FILE_OK.test(req.file.originalname || '')) {
    throw httpError(400, 'That kind of file is not accepted. Use a PDF, image, Word, Excel, PowerPoint, CSV or text file.');
  }
  const folder = config.google.scotDriveFolderId;
  const send = () => google.uploadToDrive(req.file.buffer, req.file.originalname, req.file.mimetype, 'SCOT', folder);
  try {
    let url;
    try { url = await send(); }
    catch (first) {
      // Google answers "Internal Error" now and then for a call that works a
      // second later (one of five test uploads did). Once more, and only for
      // that kind of failure: a refused folder would fail the same way again.
      const transient = Number(first && first.code) >= 500 || /internal error|backend error|try again/i.test(String(first && first.message));
      if (!transient) throw first;
      await new Promise(r => setTimeout(r, 800));
      url = await send();
    }
    res.json({ name: req.file.originalname, url });
  } catch (e) {
    // The shared handler words every Google 403 as "share this sheet"; for a
    // Drive upload the useful thing is which folder and which account.
    const who = google.serviceAccountEmail() || 'the service account';
    throw httpError(502, 'Could not save the file to Drive (' + String((e && e.message) || e).slice(0, 160)
      + '). The folder must be in a Shared Drive that ' + who + ' belongs to.');
  }
}));

module.exports = router;
