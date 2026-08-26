// ══════════════════════════════════════════════════════
// SALES — live order analytics from Vin eRetail (admin only).
// Reads vin_orders / vin_order_items, filled by orders-sync.js (v2/order/
// orderPullV2, read-only). The API is live now — the response still reports
// when it last synced so the page can show how fresh the numbers are.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Statuses vary in case ('delivered', 'Shipped complete', 'Cancelled').
const LIVE = "LOWER(status) <> 'cancelled'";

router.get('/sales', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [totals, byChannel, byStatus, byPayment, daily, topSkus, topStates, recent, span] =
      await Promise.all([
        db.one(
          `SELECT COUNT(*) orders,
                  SUM(CASE WHEN ${LIVE} THEN 1 ELSE 0 END) live_orders,
                  SUM(CASE WHEN LOWER(status)='cancelled' THEN 1 ELSE 0 END) cancelled,
                  ROUND(SUM(CASE WHEN ${LIVE} THEN order_amount ELSE 0 END)) revenue,
                  ROUND(AVG(CASE WHEN ${LIVE} THEN order_amount END)) aov
             FROM vin_orders`),
        db.rows(
          `SELECT COALESCE(NULLIF(channel_name,''),'Other') channel, COUNT(*) n,
                  ROUND(SUM(CASE WHEN ${LIVE} THEN order_amount ELSE 0 END)) revenue
             FROM vin_orders GROUP BY channel ORDER BY n DESC`),
        db.rows(
          `SELECT COALESCE(NULLIF(status,''),'(blank)') status, COUNT(*) n
             FROM vin_orders GROUP BY status ORDER BY n DESC`),
        db.rows(
          `SELECT COALESCE(NULLIF(payment_method,''),'(blank)') payment, COUNT(*) n,
                  ROUND(SUM(CASE WHEN ${LIVE} THEN order_amount ELSE 0 END)) revenue
             FROM vin_orders GROUP BY payment ORDER BY n DESC`),
        db.rows(
          `SELECT DATE(order_date) d, COUNT(*) n,
                  ROUND(SUM(CASE WHEN ${LIVE} THEN order_amount ELSE 0 END)) revenue
             FROM vin_orders WHERE order_date IS NOT NULL
            GROUP BY DATE(order_date) ORDER BY d`),
        // Units sold + value per SKU, cancelled lines excluded.
        db.rows(
          `SELECT i.sku, COALESCE(NULLIF(MAX(i.sku_name),''), i.sku) sku_name,
                  ROUND(SUM(i.order_qty)) qty,
                  ROUND(SUM(i.order_qty * i.unit_price)) value
             FROM vin_order_items i
            WHERE LOWER(i.status) <> 'cancelled'
            GROUP BY i.sku ORDER BY qty DESC LIMIT 15`),
        db.rows(
          `SELECT COALESCE(NULLIF(ship_state,''),'(unknown)') state, COUNT(*) n,
                  ROUND(SUM(CASE WHEN ${LIVE} THEN order_amount ELSE 0 END)) revenue
             FROM vin_orders GROUP BY state ORDER BY n DESC LIMIT 12`),
        db.rows(
          `SELECT order_id, ext_order_no, order_date, payment_method, status,
                  order_amount, channel_name, ship_city, ship_state
             FROM vin_orders ORDER BY order_date DESC, order_id DESC LIMIT 100`),
        db.one(
          `SELECT MIN(order_date) first_order, MAX(order_date) last_order,
                  MAX(synced_at) synced_at FROM vin_orders`),
      ]);

    const lastSync = await db.one(
      `SELECT started_at, ended_at, orders_seen, ok FROM vin_order_sync_log
        WHERE ok=1 ORDER BY id DESC LIMIT 1`).catch(() => null);

    const units = await db.one(
      `SELECT ROUND(SUM(order_qty)) units FROM vin_order_items WHERE LOWER(status) <> 'cancelled'`);

    res.json({
      totals: { ...totals, units: units?.units || 0 },
      byChannel, byStatus, byPayment, daily, topSkus, topStates, recent, span, lastSync,
    });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ notConfigured: true });
    console.error('  ❌ /api/sales:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
