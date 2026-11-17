// ══════════════════════════════════════════════════════
// RETURNS — Return / RTO analytics from Vin eRetail (admin only).
// Reads ims_returns / ims_return_items, filled by returns-sync.js
// (v1/order/orderreturn, read-only). Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD
// window (on return_date); without it, every return is counted.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requirePage } = require('../middleware/auth');

const router = express.Router();

router.get('/returns', requireAuth, requirePage('returns'), async (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const ranged = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
    const dc  = ranged ? '(return_date >= ? AND return_date < DATE_ADD(?, INTERVAL 1 DAY))' : '1=1';
    const dcR = ranged ? '(r.return_date >= ? AND r.return_date < DATE_ADD(?, INTERVAL 1 DAY))' : '1=1';
    const A = ranged ? [from, to] : [];

    const [totals, byType, byStatus, byChannel, byReason, daily, topSkus, recent, span, units] =
      await Promise.all([
        db.one(
          `SELECT COUNT(*) returns,
                  ROUND(SUM(return_amount)) amount,
                  SUM(CASE WHEN return_type='RTO' THEN 1 ELSE 0 END) rto,
                  SUM(CASE WHEN return_type<>'RTO' THEN 1 ELSE 0 END) delivered
             FROM ims_returns WHERE ${dc}`, A),
        db.rows(
          `SELECT COALESCE(NULLIF(return_type,''),'(blank)') type, COUNT(*) n,
                  ROUND(SUM(return_amount)) amount
             FROM ims_returns WHERE ${dc} GROUP BY type ORDER BY n DESC`, A),
        db.rows(
          `SELECT COALESCE(NULLIF(status,''),'(blank)') status, COUNT(*) n
             FROM ims_returns WHERE ${dc} GROUP BY status ORDER BY n DESC`, A),
        db.rows(
          `SELECT COALESCE(NULLIF(channel_name,''),'(blank)') channel, COUNT(*) n,
                  ROUND(SUM(return_amount)) amount
             FROM ims_returns WHERE ${dc} GROUP BY channel ORDER BY n DESC`, A),
        db.rows(
          `SELECT COALESCE(NULLIF(i.return_reason,''),'(blank)') reason, COUNT(*) n
             FROM ims_return_items i JOIN ims_returns r ON r.return_no = i.return_no
            WHERE ${dcR} GROUP BY reason ORDER BY n DESC LIMIT 12`, A),
        db.rows(
          `SELECT DATE(return_date) d, COUNT(*) n, ROUND(SUM(return_amount)) amount
             FROM ims_returns WHERE return_date IS NOT NULL AND ${dc}
            GROUP BY DATE(return_date) ORDER BY d`, A),
        db.rows(
          `SELECT i.sku, COALESCE(NULLIF(MAX(i.sku_name),''), i.sku) sku_name,
                  ROUND(SUM(i.return_qty)) qty
             FROM ims_return_items i JOIN ims_returns r ON r.return_no = i.return_no
            WHERE ${dcR} GROUP BY i.sku ORDER BY qty DESC LIMIT 15`, A),
        db.rows(
          `SELECT return_no, return_type, status, return_date, return_amount,
                  channel_name, eretail_order_no, customer_name, customer_phone,
                  customer_city, customer_state, refund_status
             FROM ims_returns WHERE ${dc} ORDER BY return_date DESC, return_no DESC LIMIT 100`, A),
        db.one(
          `SELECT MIN(return_date) first_return, MAX(return_date) last_return, MAX(synced_at) synced_at
             FROM ims_returns WHERE ${dc}`, A),
        db.one(
          `SELECT ROUND(SUM(i.return_qty)) units
             FROM ims_return_items i JOIN ims_returns r ON r.return_no = i.return_no
            WHERE ${dcR}`, A),
      ]);

    const lastSync = await db.one(
      `SELECT started_at, ended_at, returns_seen, ok FROM ims_return_sync_log
        WHERE ok=1 ORDER BY id DESC LIMIT 1`).catch(() => null);

    res.json({
      range: ranged ? { from, to } : null,
      totals: { ...totals, units: units?.units || 0 },
      byType, byStatus, byChannel, byReason, daily, topSkus, recent, span, lastSync,
    });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ notConfigured: true });
    console.error('  ❌ /api/returns:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Column filters on the list, as on SCOT: a ▾ on every heading, applied here
// so they cover every return, not just the page on screen. Only these columns
// can be filtered or sorted, so nothing from the request reaches the SQL but
// its values.
const LIST_COLS = {
  return_no: { col: 'return_no', type: 'text' },
  return_type: { col: 'return_type', type: 'list' },
  order: { col: 'eretail_order_no', type: 'text' },
  return_date: { col: 'return_date', type: 'date' },
  channel: { col: 'channel_name', type: 'list' },
  customer: { col: 'customer_name', type: 'text' },
  city: { col: 'customer_city', type: 'list' },
  status: { col: 'status', type: 'list' },
  amount: { col: 'return_amount', type: 'range' },
};
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
function columnFilters(raw, where, args) {
  let f = {};
  try { f = JSON.parse(raw || '{}') || {}; } catch (_) { f = {}; }
  for (const [key, v] of Object.entries(f)) {
    const c = LIST_COLS[key];
    if (!c || v == null) continue;
    if (c.type === 'text' && typeof v.text === 'string' && v.text.trim()) {
      where.push(`${c.col} LIKE ?`); args.push('%' + v.text.trim().slice(0, 100) + '%');
    } else if (c.type === 'list' && Array.isArray(v.values) && v.values.length) {
      const vals = v.values.slice(0, 200).map(x => String(x));
      const blank = vals.includes('');
      const rest = vals.filter(x => x !== '');
      const parts = [];
      if (rest.length) { parts.push(`${c.col} IN (${rest.map(() => '?').join(',')})`); args.push(...rest); }
      if (blank) parts.push(`(${c.col} IS NULL OR ${c.col} = '')`);
      where.push('(' + parts.join(' OR ') + ')');
    } else if (c.type === 'range') {
      if (Number.isFinite(Number(v.min)) && v.min !== null && v.min !== '') { where.push(`${c.col} >= ?`); args.push(Number(v.min)); }
      if (Number.isFinite(Number(v.max)) && v.max !== null && v.max !== '') { where.push(`${c.col} <= ?`); args.push(Number(v.max)); }
    } else if (c.type === 'date') {
      if (isYmd(v.from)) { where.push(`${c.col} >= ?`); args.push(v.from); }
      if (isYmd(v.to)) { where.push(`${c.col} < DATE_ADD(?, INTERVAL 1 DAY)`); args.push(v.to); }
    }
  }
}

// The values a list column holds (within the date range), with how many of
// each, for the ▾ popup's tick list.
router.get('/returns/values', requireAuth, requirePage('returns'), async (req, res) => {
  try {
    const c = LIST_COLS[String(req.query.col || '')];
    if (!c || c.type !== 'list') return res.json([]);
    const from = String(req.query.from || '').trim(), to = String(req.query.to || '').trim();
    const where = [], args = [];
    if (isYmd(from) && isYmd(to)) { where.push('return_date >= ? AND return_date < DATE_ADD(?, INTERVAL 1 DAY)'); args.push(from, to); }
    const q = String(req.query.q || '').trim();
    if (q) { where.push(`${c.col} LIKE ?`); args.push('%' + q.slice(0, 100) + '%'); }
    const rows = await db.rows(
      `SELECT COALESCE(${c.col}, '') v, COUNT(*) n FROM ims_returns
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        GROUP BY v ORDER BY n DESC, v LIMIT 200`, args);
    res.json(rows.map(r => ({ v: r.v, n: Number(r.n) })));
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// Paginated + searchable + filterable list — the full set, powers the table and
// the KPI/breakdown drill-downs.
router.get('/returns/list', requireAuth, requirePage('returns'), async (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const ranged = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const PER = 100;

    const where = [];
    const args = [];
    if (ranged) { where.push('return_date >= ? AND return_date < DATE_ADD(?, INTERVAL 1 DAY)'); args.push(from, to); }

    const BLANKS = ['(blank)'];
    const dim = (col, val) => {
      if (typeof val !== 'string' || val === '') return;
      if (BLANKS.includes(val)) where.push(`(${col} IS NULL OR ${col} = '')`);
      else { where.push(`${col} = ?`); args.push(val); }
    };
    dim('return_type', req.query.type);
    dim('status', req.query.status);
    dim('channel_name', req.query.channel);
    columnFilters(req.query.f, where, args);

    if (q) {
      where.push('(return_no LIKE ? OR eretail_order_no LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ? OR customer_city LIKE ? OR customer_state LIKE ? OR tracking_no LIKE ?)');
      const like = `%${q}%`;
      args.push(like, like, like, like, like, like, like);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const cnt = await db.one(
      `SELECT COUNT(*) n, ROUND(SUM(return_amount)) amount FROM ims_returns ${whereSql}`, args);
    const total = cnt ? cnt.n : 0;
    // A column's sort, "key" or "-key"; newest first otherwise. Blanks last.
    const sk = String(req.query.sort || '');
    const sc = LIST_COLS[sk.replace(/^-/, '')];
    const order = sc
      ? `(${sc.col} IS NULL OR ${sc.col} = '') ASC, ${sc.col} ${sk[0] === '-' ? 'DESC' : 'ASC'}, return_no DESC`
      : 'return_date DESC, return_no DESC';
    const returns = await db.rows(
      `SELECT return_no, return_type, status, return_date, return_amount,
              channel_name, eretail_order_no, customer_name, customer_phone,
              customer_city, customer_state, refund_status
         FROM ims_returns ${whereSql}
        ORDER BY ${order}
        LIMIT ${PER} OFFSET ${(page - 1) * PER}`, args);

    res.json({ returns, total, amount: (cnt && cnt.amount) || 0, page, per: PER, pages: Math.max(1, Math.ceil(total / PER)) });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ notConfigured: true });
    res.status(500).json({ error: e.message });
  }
});

// A single return's full detail — every stored field, the raw payload, items.
router.get('/returns/detail', requireAuth, requirePage('returns'), async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'No return id' });
    const ret = await db.one('SELECT * FROM ims_returns WHERE return_no = ?', [id]);
    if (!ret) return res.json({ notFound: true });
    let raw = null;
    // As with orders: the payload has its own table, and the old column is
    // still consulted so nothing breaks before the move has run.
    const side = await db.one('SELECT raw_json FROM vin_returns_raw WHERE return_no = ?', [id])
      .catch(() => null);
    try { raw = JSON.parse((side && side.raw_json) || ret.raw_json || 'null'); } catch (_) {}
    delete ret.raw_json;
    const items = await db.rows(
      `SELECT line_no, sku, sku_name, brand, status, order_qty, return_qty, received_qty,
              unit_price, line_amount, discount_amt, tax_amount, taxable_amount, hsn_code, return_reason
         FROM ims_return_items WHERE return_no = ?`, [id]);
    res.json({ ret, raw, items });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ notConfigured: true });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
