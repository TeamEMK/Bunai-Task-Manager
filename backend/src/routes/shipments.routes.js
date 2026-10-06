// ══════════════════════════════════════════════════════
// SHIPMENTS — dispatch and courier tracking from Unicommerce (admin only).
// Reads uni_shipments, which uni-orders-sync.js fills from the order payload:
// every sale order carries its shipping packages, so this costs no API call of
// its own. The tracking module the client asked Vin eRetail for and never got
// has been arriving here since the first sync.
//
// Window is on created (when the package was made), not dispatched — a package
// sitting unshipped for a week is exactly what this page is for, and a
// dispatch-date filter would hide it.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Uniware's own status names. Grouped the way a dispatch desk reads them
// rather than alphabetically: what has not gone out, what is on the road,
// what has landed.
const PENDING  = ['CREATED', 'READY_TO_SHIP', 'PICKING', 'PACKED'];
const TRANSIT  = ['SHIPPED', 'DISPATCHED', 'MANIFESTED'];
const DONE     = ['DELIVERED'];
const list = a => a.map(() => '?').join(',');

router.get('/shipments', requireAuth, requireAdmin, async (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const ranged = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
    const dc = ranged ? '(created_at_uni >= ? AND created_at_uni < DATE_ADD(?, INTERVAL 1 DAY))' : '1=1';
    const A = ranged ? [from, to] : [];

    // "Stuck" means dispatched and still not delivered after this many days.
    // Not a Uniware status — it is the question a dispatch desk actually asks,
    // and nothing else on the page answers it.
    const stuckDays = Math.min(60, Math.max(1, Number(req.query.stuck) || 7));

    const [totals, byStatus, byCourier, daily, recent, stuck, span] = await Promise.all([
      db.one(
        `SELECT COUNT(*) shipments,
                SUM(status IN (${list(PENDING)})) pending,
                SUM(status IN (${list(TRANSIT)})) transit,
                SUM(status IN (${list(DONE)})) delivered,
                SUM(status = 'CANCELLED') cancelled,
                SUM(tracking_number IS NOT NULL AND tracking_number <> '') tracked,
                ROUND(SUM(collectable_amount)) cod_value
           FROM uni_shipments WHERE ${dc}`, [...PENDING, ...TRANSIT, ...DONE, ...A]),

      db.rows(
        `SELECT COALESCE(NULLIF(status,''),'(blank)') status, COUNT(*) n
           FROM uni_shipments WHERE ${dc} GROUP BY status ORDER BY n DESC`, A),

      // Courier first, provider as the fallback — Uniware leaves courierName
      // null on a good many packages while still naming the provider.
      db.rows(
        `SELECT COALESCE(NULLIF(courier,''), NULLIF(shipping_provider,''), '(unassigned)') courier,
                COUNT(*) n,
                SUM(status IN (${list(DONE)})) delivered,
                ROUND(AVG(CASE WHEN delivered_at IS NOT NULL AND dispatched_at IS NOT NULL
                          THEN TIMESTAMPDIFF(HOUR, dispatched_at, delivered_at)/24 END), 1) avg_days
           FROM uni_shipments WHERE ${dc}
          GROUP BY COALESCE(NULLIF(courier,''), NULLIF(shipping_provider,''), '(unassigned)')
          ORDER BY n DESC LIMIT 12`, [...DONE, ...A]),

      db.rows(
        `SELECT DATE(created_at_uni) d, COUNT(*) n,
                SUM(dispatched_at IS NOT NULL) dispatched
           FROM uni_shipments WHERE created_at_uni IS NOT NULL AND ${dc}
          GROUP BY DATE(created_at_uni) ORDER BY d`, A),

      db.rows(
        `SELECT s.code, s.order_code, s.status, s.tracking_number, s.tracking_status,
                COALESCE(NULLIF(s.courier,''), s.shipping_provider) courier,
                s.invoice_code, s.invoice_date, s.dispatched_at, s.delivered_at,
                s.city, s.no_of_items, s.collectable_amount, s.created_at_uni,
                o.channel, o.display_code
           FROM uni_shipments s
           LEFT JOIN uni_orders o ON o.code = s.order_code
          WHERE ${dc.replace(/created_at_uni/g, 's.created_at_uni')}
          ORDER BY s.created_at_uni DESC LIMIT 200`, A),

      // The actionable list: gone out, nothing back, and old enough to chase.
      db.rows(
        `SELECT s.code, s.order_code, s.tracking_number,
                COALESCE(NULLIF(s.courier,''), s.shipping_provider) courier,
                s.dispatched_at, s.city,
                DATEDIFF(NOW(), s.dispatched_at) days
           FROM uni_shipments s
          WHERE s.dispatched_at IS NOT NULL AND s.delivered_at IS NULL
            AND s.status NOT IN ('CANCELLED','DELIVERED')
            AND DATEDIFF(NOW(), s.dispatched_at) >= ?
          ORDER BY days DESC LIMIT 100`, [stuckDays]),

      db.one(
        `SELECT MIN(created_at_uni) first_shipment, MAX(created_at_uni) last_shipment,
                MAX(updated_at_uni) last_update
           FROM uni_shipments WHERE ${dc}`, A),
    ]);

    res.json({ totals, byStatus, byCourier, daily, recent, stuck, stuckDays, span });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ notConfigured: true });
    res.status(500).json({ error: e.message });
  }
});

// One shipment in full, with the order lines it is carrying.
router.get('/shipments/detail', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'No shipment id' });

    const shipment = await db.one('SELECT * FROM uni_shipments WHERE code = ?', [id]);
    if (!shipment) return res.json({ notFound: true });

    const order = await db.one('SELECT * FROM uni_orders WHERE code = ?', [shipment.order_code]);
    const items = await db.rows(
      `SELECT sku, item_name, status, selling_price, total_price, facility
         FROM uni_order_items WHERE shipping_package = ?`, [id]);

    res.json({ shipment, order, items });
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ notConfigured: true });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
