// ══════════════════════════════════════════════════════
// SALES — live order analytics from Vin eRetail (admin only).
// Reads vin_orders / vin_order_items, filled by orders-sync.js (v2/order/
// orderPullV2, read-only). Accepts an optional ?from=YYYY-MM-DD&to=YYYY-MM-DD
// window; without it, every order is counted.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Statuses vary in case ('delivered', 'Shipped complete', 'Cancelled').
const LIVE = "LOWER(status) <> 'cancelled'";

router.get('/sales', requireAuth, requireAdmin, async (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const ranged = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
    // Half-open [from, to+1day) so the whole "to" day is included.
    const dc  = ranged ? '(order_date >= ? AND order_date < DATE_ADD(?, INTERVAL 1 DAY))' : '1=1';
    const dcO = ranged ? '(o.order_date >= ? AND o.order_date < DATE_ADD(?, INTERVAL 1 DAY))' : '1=1';
    const A = ranged ? [from, to] : [];   // date args, prepended to each query

    const [totals, byChannel, byStatus, byPayment, daily, topSkus, topStates, recent, span, units] =
      await Promise.all([
        db.one(
          `SELECT COUNT(*) orders,
                  SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END) live_orders,
                  SUM(CASE WHEN LOWER(status)='cancelled' THEN 1 ELSE 0 END) cancelled,
                  ROUND(SUM(CASE WHEN ${LIVE} THEN order_amount ELSE 0 END)) revenue,
                  ROUND(AVG(CASE WHEN ${LIVE} THEN order_amount END)) aov
             FROM vin_orders WHERE ${dc}`, A),
        db.rows(
          `SELECT COALESCE(NULLIF(channel_name,''),'Other') channel, COUNT(*) n,
                  ROUND(SUM(CASE WHEN ${LIVE} THEN order_amount ELSE 0 END)) revenue
             FROM vin_orders WHERE ${dc} GROUP BY channel ORDER BY n DESC`, A),
        db.rows(
          `SELECT COALESCE(NULLIF(status,''),'(blank)') status, COUNT(*) n
             FROM vin_orders WHERE ${dc} GROUP BY status ORDER BY n DESC`, A),
        db.rows(
          `SELECT COALESCE(NULLIF(payment_method,''),'(blank)') payment, COUNT(*) n,
                  ROUND(SUM(CASE WHEN ${LIVE} THEN order_amount ELSE 0 END)) revenue
             FROM vin_orders WHERE ${dc} GROUP BY payment ORDER BY n DESC`, A),
        db.rows(
          `SELECT DATE(order_date) d, COUNT(*) n,
                  ROUND(SUM(CASE WHEN ${LIVE} THEN order_amount ELSE 0 END)) revenue
             FROM vin_orders WHERE order_date IS NOT NULL AND ${dc}
            GROUP BY DATE(order_date) ORDER BY d`, A),
        db.rows(
          `SELECT i.sku, COALESCE(NULLIF(MAX(i.sku_name),''), i.sku) sku_name,
                  ROUND(SUM(i.order_qty)) qty, ROUND(SUM(i.order_qty * i.unit_price)) value
             FROM vin_order_items i JOIN vin_orders o ON o.order_id = i.order_id
            WHERE ${dcO} AND LOWER(i.status) <> 'cancelled'
            GROUP BY i.sku ORDER BY qty DESC LIMIT 15`, A),
        db.rows(
          `SELECT COALESCE(NULLIF(ship_state,''),'(unknown)') state, COUNT(*) n,
                  ROUND(SUM(CASE WHEN ${LIVE} THEN order_amount ELSE 0 END)) revenue
             FROM vin_orders WHERE ${dc} GROUP BY state ORDER BY n DESC LIMIT 12`, A),
        db.rows(
          `SELECT order_id, ext_order_no, order_date, payment_method, status, order_amount,
                  channel_name, ship_city, ship_state, customer_name, customer_phone
             FROM vin_orders WHERE ${dc} ORDER BY order_date DESC, order_id DESC LIMIT 100`, A),
        db.one(
          `SELECT MIN(order_date) first_order, MAX(order_date) last_order, MAX(synced_at) synced_at
             FROM vin_orders WHERE ${dc}`, A),
        db.one(
          `SELECT ROUND(SUM(i.order_qty)) units
             FROM vin_order_items i JOIN vin_orders o ON o.order_id = i.order_id
            WHERE ${dcO} AND LOWER(i.status) <> 'cancelled'`, A),
      ]);

    // Freshness is about the sync, not the chosen window — always global.
    const lastSync = await db.one(
      `SELECT started_at, ended_at, orders_seen, ok FROM vin_order_sync_log
        WHERE ok=1 ORDER BY id DESC LIMIT 1`).catch(() => null);

    res.json({
      range: ranged ? { from, to } : null,
      totals: { ...totals, units: units?.units || 0 },
      byChannel, byStatus, byPayment, daily, topSkus, topStates, recent, span, lastSync,
    });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ notConfigured: true });
    console.error('  ❌ /api/sales:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// One product's detail — the orders that contain it, plus units, value and the
// current stock. Same optional ?from&to window as /sales.
router.get('/sales/sku', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sku = String(req.query.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'No SKU given' });
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const ranged = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
    const dc = ranged ? 'AND o.order_date >= ? AND o.order_date < DATE_ADD(?, INTERVAL 1 DAY)' : '';
    const A = ranged ? [from, to] : [];

    const [summary, orders] = await Promise.all([
      db.one(
        `SELECT MAX(i.sku_name) name, ROUND(SUM(i.order_qty)) qty,
                ROUND(SUM(i.order_qty * i.unit_price)) value, COUNT(DISTINCT o.order_id) orders
           FROM vin_order_items i JOIN vin_orders o ON o.order_id = i.order_id
          WHERE i.sku = ? AND LOWER(i.status) <> 'cancelled' ${dc}`, [sku, ...A]),
      db.rows(
        `SELECT DISTINCT o.order_id, o.ext_order_no, o.order_date, o.payment_method, o.status,
                o.order_amount, o.channel_name, o.ship_city, o.ship_state, o.customer_name, o.customer_phone
           FROM vin_order_items i JOIN vin_orders o ON o.order_id = i.order_id
          WHERE i.sku = ? ${dc}
          ORDER BY o.order_date DESC LIMIT 200`, [sku, ...A]),
    ]);
    let stock = null;
    try { const s = await db.one('SELECT ROUND(SUM(qty)) qty FROM vin_inventory WHERE sku = ?', [sku]); stock = s ? s.qty : null; } catch (_) {}
    res.json({ sku, summary, stock, orders });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ notConfigured: true });
    res.status(500).json({ error: e.message });
  }
});

// All orders in the range, paginated + searchable — the full list, not just
// the recent 100 the dashboard shows. Also powers the KPI-card and breakdown
// drill-downs, so it accepts the same filters those cards represent:
//   flag=live|cancelled           — the Revenue/Live vs Cancelled split
//   channel / status / payment / state — one exact breakdown value
// and returns the exact total count + revenue for the filtered set, so the
// popup always agrees with the card (no more "latest 95 shown" wobble).
router.get('/sales/orders', requireAuth, requireAdmin, async (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const ranged = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const PER = 100;

    const where = [];
    const args = [];
    if (ranged) { where.push('order_date >= ? AND order_date < DATE_ADD(?, INTERVAL 1 DAY)'); args.push(from, to); }

    // Live/cancelled split (matches the Revenue & Cancelled cards).
    const flag = String(req.query.flag || '').trim();
    if (flag === 'live') where.push("LOWER(status) <> 'cancelled'");
    else if (flag === 'cancelled') where.push("LOWER(status) = 'cancelled'");

    // One exact breakdown value per dimension; the panels label empties with a
    // placeholder ('Other'/'(blank)'/'(unknown)'), so match NULL/'' for those.
    const BLANKS = ['Other', '(blank)', '(unknown)'];
    const dim = (col, val) => {
      if (typeof val !== 'string' || val === '') return;
      if (BLANKS.includes(val)) where.push(`(${col} IS NULL OR ${col} = '')`);
      else { where.push(`${col} = ?`); args.push(val); }
    };
    dim('channel_name', req.query.channel);
    dim('status', req.query.status);
    dim('payment_method', req.query.payment);
    dim('ship_state', req.query.state);

    if (q) {
      where.push('(order_id LIKE ? OR ext_order_no LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ? OR ship_city LIKE ? OR ship_state LIKE ? OR status LIKE ?)');
      const like = `%${q}%`;
      args.push(like, like, like, like, like, like, like);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const cnt = await db.one(
      `SELECT COUNT(*) n, ROUND(SUM(order_amount)) revenue FROM vin_orders ${whereSql}`, args);
    const total = cnt ? cnt.n : 0;
    const orders = await db.rows(
      `SELECT order_id, ext_order_no, order_date, payment_method, status, order_amount,
              channel_name, ship_city, ship_state, customer_name, customer_phone
         FROM vin_orders ${whereSql}
        ORDER BY order_date DESC, order_id DESC
        LIMIT ${PER} OFFSET ${(page - 1) * PER}`, args);

    res.json({ orders, total, revenue: (cnt && cnt.revenue) || 0, page, per: PER, pages: Math.max(1, Math.ceil(total / PER)) });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ notConfigured: true });
    res.status(500).json({ error: e.message });
  }
});

// A single order's full detail — every stored field, the raw payload, and its
// line items.
router.get('/sales/order', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'No order id' });
    const order = await db.one('SELECT * FROM vin_orders WHERE order_id = ?', [id]);
    if (!order) return res.json({ notFound: true });
    let raw = null;
    try { raw = JSON.parse(order.raw_json || 'null'); } catch (_) {}
    delete order.raw_json;
    const items = await db.rows(
      `SELECT sku, sku_name, brand, status, order_qty, shipped_qty, cancelled_qty,
              return_qty, unit_price, discount_amt, tax_amount
         FROM vin_order_items WHERE order_id = ?`, [id]);
    res.json({ order, raw, items });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ notConfigured: true });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
