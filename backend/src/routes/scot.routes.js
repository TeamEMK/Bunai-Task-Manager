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
const { requireAuth, requirePage } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errors');

const router = express.Router();

// Everything in sfy_orders is IST; "today" has to be India's, not the server's.
const TODAY = `DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE)`;
const KEY = `RIGHT(REGEXP_REPLACE(COALESCE(o.customer_phone,''), '[^0-9]', ''), 10)`;

const STATUSES = ['gone', 'overdue', 'due', 'on-track', 'one-time'];

// One row per customer already — sfy_customers is rebuilt by the Shopify sync.
// Only the verdict is worked out here, because it depends on today and would
// be wrong by morning if it were stored.
const BASE = `
  SELECT phone, name, email, city, orders, units, value,
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

// Late first, and the biggest spender at the top of each band. "Gone" sits
// below "overdue" because overdue is still winnable.
const ORDER = `
  ORDER BY FIELD(status, 'overdue', 'due', 'gone', 'on-track', 'one-time'), value DESC`;

const LIMIT = 1500;

router.get('/scot', requireAuth, requirePage('scot'), asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const status = STATUSES.includes(String(req.query.status || '')) ? String(req.query.status) : '';

  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (q) {
    where.push('(name LIKE ? OR phone LIKE ? OR city LIKE ? OR email LIKE ?)');
    const like = '%' + q + '%';
    args.push(like, like, like, like);
  }
  const filter = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const [rows, counts, total] = await Promise.all([
    db.rows(`SELECT * FROM (${BASE}) y ${filter} ${ORDER} LIMIT ${LIMIT}`, args),
    // Counted over everyone, not the filtered set: the tiles are what the
    // filter is chosen from, so narrowing them would strand the other numbers.
    db.rows(`SELECT status, COUNT(*) n FROM (${BASE}) y GROUP BY status`),
    db.one(`SELECT COUNT(*) n FROM (${BASE}) y ${filter}`, args),
  ]);

  const by = Object.fromEntries(counts.map(c => [c.status, Number(c.n)]));

  // When each tab of the Google Sheet was last written, in India's time. The
  // log is in UTC; the table may not exist yet on a database the sheet has
  // never been written from, and that is not an error worth failing the page.
  let sheet = null;
  try {
    const w = await db.rows(
      `SELECT tab, DATE_FORMAT(MAX(ended_at) + INTERVAL 330 MINUTE, '%e %b, %l:%i %p') at
         FROM scot_sheet_log WHERE ok = 1 GROUP BY tab`);
    sheet = Object.fromEntries(w.map(r => [r.tab === 'SCOT Lifetime' ? 'lifetime' : 'scot', r.at]));
  } catch (_) { /* no log yet */ }

  res.json({
    sheet,
    counts: {
      all: counts.reduce((a, c) => a + Number(c.n), 0),
      ...STATUSES.reduce((a, s) => (a[s] = by[s] || 0, a), {}),
    },
    total: Number(total?.n) || 0,
    rows: rows.map(r => ({
      phone: r.phone,
      name: (r.name || '').trim() || '(no name)',
      email: (r.email || '').trim(),
      city: (r.city || '').trim(),
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

module.exports = router;
