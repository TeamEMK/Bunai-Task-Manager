// ══════════════════════════════════════════════════════
// SALES — order analytics from Vin eRetail order exports (admin only).
// Reads vin_orders, which sales-import.js fills from the dashboard's
// "Order Enquiry → Export". Vinculum's order API is blocked (OrgId), so this
// is export-driven, not live — the response says when it was last imported so
// nobody mistakes a month-old snapshot for today.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Cancelled orders are not revenue; most tiles exclude them.
const NOT_CANCELLED = "status <> 'Cancelled'";

router.get('/sales', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [totals, byStatus, byType, daily, topStates, recent, span, channels] = await Promise.all([
      db.one(
        `SELECT COUNT(*) orders,
                SUM(CASE WHEN ${NOT_CANCELLED} THEN 1 ELSE 0 END) live_orders,
                SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) cancelled,
                ROUND(SUM(CASE WHEN ${NOT_CANCELLED} THEN order_amount ELSE 0 END)) revenue,
                ROUND(AVG(CASE WHEN ${NOT_CANCELLED} THEN order_amount END)) aov
           FROM vin_orders`),
      db.rows(
        `SELECT COALESCE(NULLIF(status,''),'(blank)') status, COUNT(*) n,
                ROUND(SUM(order_amount)) amount
           FROM vin_orders GROUP BY status ORDER BY n DESC`),
      db.rows(
        `SELECT COALESCE(NULLIF(order_type,''),'(blank)') order_type, COUNT(*) n,
                ROUND(SUM(CASE WHEN ${NOT_CANCELLED} THEN order_amount ELSE 0 END)) revenue
           FROM vin_orders GROUP BY order_type ORDER BY n DESC`),
      db.rows(
        `SELECT DATE(order_date) d, COUNT(*) n,
                ROUND(SUM(CASE WHEN ${NOT_CANCELLED} THEN order_amount ELSE 0 END)) revenue
           FROM vin_orders WHERE order_date IS NOT NULL
          GROUP BY DATE(order_date) ORDER BY d`),
      db.rows(
        `SELECT COALESCE(NULLIF(ship_state,''),'(unknown)') state, COUNT(*) n,
                ROUND(SUM(CASE WHEN ${NOT_CANCELLED} THEN order_amount ELSE 0 END)) revenue
           FROM vin_orders GROUP BY ship_state ORDER BY n DESC LIMIT 12`),
      db.rows(
        `SELECT order_no, ext_order_no, order_date, order_type, status,
                order_amount, ship_city, ship_state
           FROM vin_orders ORDER BY order_date DESC, order_no DESC LIMIT 100`),
      db.one(
        `SELECT MIN(order_date) first_order, MAX(order_date) last_order, MAX(imported_at) imported_at
           FROM vin_orders`),
      db.rows(
        // Ext order-no shape is the only channel hint the export carries: Myntra
        // rides on a UUID, Shopify on a short numeric id. Best-effort labelling.
        `SELECT CASE
                  WHEN ext_order_no REGEXP '^[0-9a-f]{8}-' THEN 'Myntra'
                  WHEN ext_order_no REGEXP '^[0-9]+$'      THEN 'Shopify'
                  ELSE 'Other' END channel,
                COUNT(*) n,
                ROUND(SUM(CASE WHEN ${NOT_CANCELLED} THEN order_amount ELSE 0 END)) revenue
           FROM vin_orders GROUP BY channel ORDER BY n DESC`),
    ]);

    res.json({ totals, byStatus, byType, daily, topStates, recent, span, channels });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ notConfigured: true });
    }
    console.error('  ❌ /api/sales:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
