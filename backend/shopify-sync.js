// ══════════════════════════════════════════════════════
// SHOPIFY ORDERS SYNC — the live half of the Shopify history.
//
//   node backend/shopify-sync.js [--days 7]
//
// backend/scripts/import-shopify-history.js loaded the eight years before
// today from the store's CSV export, once. This keeps the same two tables
// current, so sfy_orders is the whole Shopify story rather than a frozen one.
//
// Why 7 days and not 1: an order's status moves after it is placed — paid,
// fulfilled, cancelled — and a window only one day wide would freeze every
// order the moment it fell out. Seven days of re-reading costs a few hundred
// orders per run and keeps the recent statuses honest. The rows are upserts,
// so re-reading changes nothing that has not moved.
//
// What it will NOT fetch is anything older than 60 days. Shopify hides older
// orders without the read_all_orders scope, and that scope cannot be granted
// to an app created in the Dev Dashboard — it is rejected as invalid. It does
// not matter here: the history is already loaded, and this only has to keep up
// with new orders.
// ══════════════════════════════════════════════════════
const { db } = require('./src/db/pool');
const shopify = require('./shopify');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const DAYS = Math.max(1, Math.min(60, Number(arg('--days', process.env.SHOPIFY_DAYS || 7))));
const PAGE = 50;

const log = (s) => console.log(s);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const txt = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max) : null; };

const ORDERS = `
query Orders($q: String!, $cursor: String) {
  orders(first: ${PAGE}, after: $cursor, sortKey: CREATED_AT, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      name createdAt cancelledAt
      displayFinancialStatus displayFulfillmentStatus
      paymentGatewayNames
      totalPriceSet { shopMoney { amount } }
      subtotalPriceSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
      discountCodes
      customer { displayName phone email }
      email phone
      shippingAddress { city province zip }
      billingAddress { city province zip }
      lineItems(first: 100) {
        nodes {
          sku title quantity
          originalUnitPriceSet { shopMoney { amount } }
          totalDiscountSet { shopMoney { amount } }
        }
      }
    }
  }
}`;

function orderRow(o) {
  const addr = o.shippingAddress || o.billingAddress || {};
  const money = (f) => (o[f] && o[f].shopMoney ? num(o[f].shopMoney.amount) : null);
  return [
    txt(o.name, 60),
    (String(o.name || '').match(/(\d+)\s*$/) || [])[1] || null,
    shopify.toIst(o.createdAt),
    txt(o.displayFinancialStatus, 40),
    txt(o.displayFulfillmentStatus, 40),
    money('totalPriceSet'), money('subtotalPriceSet'), money('totalShippingPriceSet'),
    money('totalTaxSet'), money('totalDiscountsSet'),
    txt((o.discountCodes || []).join(', '), 160),
    txt((o.paymentGatewayNames || []).join(', '), 120),
    txt(o.customer && o.customer.displayName, 200),
    txt((o.customer && o.customer.email) || o.email, 255),
    txt((o.customer && o.customer.phone) || o.phone, 40),
    txt(addr.city, 120), txt(addr.province, 120), txt(addr.zip, 20),
    shopify.toIst(o.cancelledAt),
    (o.lineItems && o.lineItems.nodes ? o.lineItems.nodes.length : 0),
  ];
}

async function ensureLog() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sfy_order_sync_log (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      started_at  DATETIME NOT NULL,
      ended_at    DATETIME NULL,
      days        INT NULL,
      orders_seen INT NOT NULL DEFAULT 0,
      orders_new  INT NULL,
      ok          TINYINT(1) NOT NULL DEFAULT 0,
      error       TEXT NULL,
      KEY idx_sfy_sl (started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function syncOrders({ days = DAYS } = {}) {
  await ensureLog();
  const [ins] = await db.query(
    'INSERT INTO sfy_order_sync_log (started_at, days) VALUES (UTC_TIMESTAMP(), ?)', [days]);
  const runId = ins.insertId;

  try {
    const from = shopify.istDayToUtcIso(days);
    const q = `created_at:>=${from}`;
    log(`Shopify orders — last ${days} days (from ${shopify.toIst(from)} IST)`);

    let cursor = null;
    let seen = 0, fresh = 0, lines = 0;
    const codes = [];

    do {
      const d = await shopify.gql(ORDERS, { q, cursor });
      const page = d.orders;

      // What is already here, so the run can report what actually moved rather
      // than how many rows it re-read.
      const names = page.nodes.map((o) => o.name).filter(Boolean);
      const before = new Map();
      if (names.length) {
        const [rows] = await db.query(
          `SELECT order_no, order_amount, status, fulfillment, cancelled_at
             FROM sfy_orders WHERE order_no IN (?)`, [names]);
        rows.forEach((r) => before.set(r.order_no, [
          r.order_amount == null ? '' : String(Number(r.order_amount)),
          r.status || '', r.fulfillment || '', r.cancelled_at ? '1' : '0',
        ].join('|')));
      }

      const orderRows = [];
      const itemRows = [];
      for (const o of page.nodes) {
        if (!o.name) continue;
        const row = orderRow(o);
        orderRows.push(row);
        codes.push(o.name);
        seen++;

        const now = [
          row[5] == null ? '' : String(row[5]),
          row[3] || '', row[4] || '', row[18] ? '1' : '0',
        ].join('|');
        if (!before.has(o.name) || before.get(o.name) !== now) fresh++;

        for (const it of (o.lineItems && o.lineItems.nodes) || []) {
          itemRows.push([
            txt(o.name, 60), txt(it.sku, 160), txt(it.title, 500),
            o.cancelledAt ? 'cancelled' : 'fulfilled',
            Number(it.quantity) || 0,
            it.originalUnitPriceSet ? num(it.originalUnitPriceSet.shopMoney.amount) : null,
            it.totalDiscountSet ? num(it.totalDiscountSet.shopMoney.amount) : null,
          ]);
          lines++;
        }
      }

      if (orderRows.length) {
        await db.query(
          `INSERT INTO sfy_orders
             (order_no, order_ref, order_date, status, fulfillment, order_amount,
              subtotal, shipping, taxes, discount_amount, discount_code,
              payment_method, customer_name, customer_email, customer_phone,
              ship_city, ship_state, ship_pincode, cancelled_at, total_lines)
           VALUES ?
           ON DUPLICATE KEY UPDATE
             order_ref=VALUES(order_ref), order_date=VALUES(order_date),
             status=VALUES(status), fulfillment=VALUES(fulfillment),
             order_amount=VALUES(order_amount), subtotal=VALUES(subtotal),
             shipping=VALUES(shipping), taxes=VALUES(taxes),
             discount_amount=VALUES(discount_amount), discount_code=VALUES(discount_code),
             payment_method=VALUES(payment_method), customer_name=VALUES(customer_name),
             customer_email=VALUES(customer_email), customer_phone=VALUES(customer_phone),
             ship_city=VALUES(ship_city), ship_state=VALUES(ship_state),
             ship_pincode=VALUES(ship_pincode), cancelled_at=VALUES(cancelled_at),
             total_lines=VALUES(total_lines)`,
          [orderRows]);
      }

      // Lines have no stable id in the API either, so an order's lines are
      // replaced rather than merged — the same rule the CSV import follows.
      if (itemRows.length) {
        await db.query('DELETE FROM sfy_order_items WHERE order_no IN (?)',
          [[...new Set(itemRows.map((r) => r[0]))]]);
        await db.query(
          `INSERT INTO sfy_order_items
             (order_no, sku, sku_name, status, order_qty, unit_price, discount_amt)
           VALUES ?`, [itemRows]);
      }

      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      log(`  ${seen} orders, ${lines} lines${cursor ? ' …' : ''}`);
    } while (cursor);

    await db.query(
      'UPDATE sfy_order_sync_log SET ended_at=UTC_TIMESTAMP(), orders_seen=?, orders_new=?, ok=1 WHERE id=?',
      [seen, fresh, runId]);
    log(`  ${fresh} new or changed, of ${seen} in the window`);

    // The calling list reads customers, not orders. Rebuilt here so it is
    // never more stale than the orders behind it.
    const customers = await rebuildCustomers();
    log(`  ${customers.toLocaleString('en-IN')} customers rolled up`);

    return { orders: seen, fresh, lines, customers };
  } catch (e) {
    await db.query(
      'UPDATE sfy_order_sync_log SET ended_at=UTC_TIMESTAMP(), ok=0, error=? WHERE id=?',
      [String(e.message).slice(0, 2000), runId]);
    throw e;
  }
}

// ── The customer roll-up ──────────────────────────────
// sfy_customers is one row per customer, and every page that asks "who should
// we ring" reads it instead of grouping 450,000 orders on a phone number dug
// out with REGEXP_REPLACE. That grouping took 43 seconds; this runs once a
// sync.
//
// Rebuilt whole rather than merged. A customer whose orders were all cancelled
// should disappear, and a phone number corrected on an old order moves that
// order's history to a different customer — neither survives an upsert that
// only touches the rows it happens to see.
const CUST_KEY = `RIGHT(REGEXP_REPLACE(COALESCE(o.customer_phone,''), '[^0-9]', ''), 10)`;

async function rebuildCustomers() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sfy_customers (
      phone       VARCHAR(20) NOT NULL PRIMARY KEY,
      name        VARCHAR(200) DEFAULT '',
      email       VARCHAR(255) DEFAULT '',
      city        VARCHAR(120) DEFAULT '',
      state       VARCHAR(120) DEFAULT '',
      orders      INT NOT NULL DEFAULT 0,
      units       INT NOT NULL DEFAULT 0,
      value       DECIMAL(14,2) NOT NULL DEFAULT 0,
      first_order DATETIME NULL,
      last_order  DATETIME NULL,
      gap_days    INT NULL,
      rebuilt_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_sfy_c_value (value),
      KEY idx_sfy_c_last (last_order),
      KEY idx_sfy_c_name (name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Into a fresh table, then swapped in. Emptying the live one first would
  // leave the page with no customers for the minute the rebuild takes.
  await db.query('DROP TABLE IF EXISTS sfy_customers_new');
  await db.query('CREATE TABLE sfy_customers_new LIKE sfy_customers');

  await db.query(`
    INSERT INTO sfy_customers_new
      (phone, name, email, city, state, orders, units, value,
       first_order, last_order, gap_days)
    SELECT ${CUST_KEY},
           SUBSTRING(MAX(CONCAT(DATE_FORMAT(o.order_date, '%Y%m%d%H%i%s'),
                                COALESCE(o.customer_name, ''))), 15),
           SUBSTRING(MAX(CONCAT(DATE_FORMAT(o.order_date, '%Y%m%d%H%i%s'),
                                COALESCE(NULLIF(o.customer_email, ''), ''))), 15),
           SUBSTRING(MAX(CONCAT(DATE_FORMAT(o.order_date, '%Y%m%d%H%i%s'),
                                COALESCE(NULLIF(o.ship_city, ''), ''))), 15),
           SUBSTRING(MAX(CONCAT(DATE_FORMAT(o.order_date, '%Y%m%d%H%i%s'),
                                COALESCE(NULLIF(o.ship_state, ''), ''))), 15),
           COUNT(*),
           COALESCE(SUM(it.n), 0),
           ROUND(SUM(o.order_amount)),
           MIN(o.order_date), MAX(o.order_date),
           CASE WHEN COUNT(*) > 1
                THEN GREATEST(1, ROUND(DATEDIFF(DATE(MAX(o.order_date)), DATE(MIN(o.order_date)))
                                       / (COUNT(*) - 1)))
                ELSE NULL END
      FROM sfy_orders o
      LEFT JOIN (SELECT order_no, SUM(order_qty) n FROM sfy_order_items GROUP BY order_no) it
             ON it.order_no = o.order_no
     WHERE o.cancelled_at IS NULL AND LENGTH(${CUST_KEY}) = 10
     GROUP BY 1`);

  await db.query('DROP TABLE IF EXISTS sfy_customers_old');
  await db.query('RENAME TABLE sfy_customers TO sfy_customers_old, sfy_customers_new TO sfy_customers');
  await db.query('DROP TABLE sfy_customers_old');

  const r = await db.one('SELECT COUNT(*) n FROM sfy_customers');
  return Number(r?.n) || 0;
}

async function status() {
  const r = await db.one(
    `SELECT started_at, ended_at, orders_seen, orders_new, ok, LEFT(COALESCE(error,''), 120) err
       FROM sfy_order_sync_log ORDER BY id DESC LIMIT 1`).catch(() => null);
  return r;
}

module.exports = { syncOrders, status, rebuildCustomers };

if (require.main === module) {
  (async () => {
    const s = await shopify.shopInfo();
    log(`${s.name} — ${s.myshopifyDomain} (${s.currencyCode}, ${s.ianaTimezone})\n`);
    const r = await syncOrders();
    log(`\ndone: ${r.orders} orders, ${r.lines} lines, ${r.fresh} new or changed`);
    process.exit(0);
  })().catch((e) => { console.error('\nFAILED: ' + e.message); process.exit(1); });
}
