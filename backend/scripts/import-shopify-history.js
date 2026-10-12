// ══════════════════════════════════════════════════════
// Shopify history import — the eight years before the cutover.
//
//   node backend/scripts/import-shopify-history.js <folder-with-csvs>
//
// The store ran on Shopify alone from June 2018 until Vin eRetail started
// feeding us on 15 May 2026. That history exists nowhere in this database, so
// the Sales page could only ever show the last few months. The client exported
// it from Shopify Admin (Orders → Export → All orders) as 40 CSVs; this reads
// them into sfy_orders / sfy_order_items.
//
// Run it again whenever a fresh export arrives: every row is an upsert keyed on
// the order name, and a re-run of the same files changes nothing. Items are
// deleted and rewritten per order rather than upserted, because a line has no
// stable id of its own in the export.
//
// What this script will NOT do is touch the cutover. It loads whatever the
// files contain; the ims_orders view is what decides that only pre-cutover rows
// are read, so the live syncs stay the single source for everything after.
//
// Shopify writes ONE ROW PER LINE ITEM. The order-level fields — date, total,
// address — appear on an order's first row and are blank on the rest, so an
// order is assembled from the first row that carries them and its items are
// collected across however many rows follow.
// ══════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { db } = require('../src/db/pool');

const DIR = process.argv[2];
const ORDER_BATCH = 500;
const ITEM_BATCH = 2000;

const num = (v) => {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const int = (v) => Math.round(num(v) || 0);
const txt = (v, max) => {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : null;
};

// "2026-10-10 18:29:21 +0530" -> "2026-10-10 18:29:21".
// Shopify exports in the store's own timezone, which is IST, and every other
// date in this database is IST too — so the offset is dropped, not applied.
// Converting here would move the whole history 5:30 and silently disagree with
// vin_orders, which also stores IST.
const stamp = (v) => {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : null;
};

// A CSV line splitter that honours quotes and doubled quotes inside them.
// Addresses in this export carry commas, quotes and newlines; a split(',')
// loses about one row in fifty, and silently.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return { fields: out, open: quoted };
}

// Reads a CSV whose values may contain newlines, joining physical lines until
// the quotes balance.
async function* csvRows(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let header = null;
  let pending = null;
  for await (const line of rl) {
    const text = pending === null ? line : pending + '\n' + line;
    const { fields, open } = splitCsvLine(text);
    if (open) { pending = text; continue; }
    pending = null;
    if (!header) { header = fields.map(h => h.trim()); continue; }
    const row = {};
    header.forEach((h, i) => { row[h] = fields[i]; });
    yield row;
  }
}

async function flushOrders(rows) {
  if (!rows.length) return;
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
    [rows]);
}

async function flushItems(rows) {
  if (!rows.length) return;
  await db.query(
    `INSERT INTO sfy_order_items
       (order_no, sku, sku_name, order_qty, unit_price, discount_amt)
     VALUES ?`, [rows]);
}

(async () => {
  if (!DIR || !fs.existsSync(DIR)) {
    console.error('Usage: node backend/scripts/import-shopify-history.js <folder-with-csvs>');
    process.exit(1);
  }
  const files = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.csv')).sort();
  if (!files.length) { console.error('No .csv files in ' + DIR); process.exit(1); }
  console.log(`Shopify history import — ${files.length} files from ${DIR}\n`);

  // A re-import must not leave the previous run's item rows behind. Orders
  // upsert by key; items have no key, so the table is cleared and rebuilt.
  const had = Number((await db.one('SELECT COUNT(*) n FROM sfy_order_items')).n);
  if (had) {
    console.log(`clearing ${had.toLocaleString('en-IN')} existing item rows`);
    await db.query('DELETE FROM sfy_order_items');
  }

  const seen = new Set();
  let orderBuf = [];
  let itemBuf = [];
  let orders = 0, items = 0, skipped = 0;

  for (const f of files) {
    for await (const row of csvRows(path.join(DIR, f))) {
      const name = txt(row['Name'], 60);
      if (!name) { skipped++; continue; }

      // Order-level fields only exist on an order's first row.
      const created = stamp(row['Created at']);
      if (created && !seen.has(name)) {
        seen.add(name);
        orderBuf.push([
          name,
          (name.match(/(\d+)\s*$/) || [])[1] || null,
          created,
          txt(row['Financial Status'], 40),
          txt(row['Fulfillment Status'], 40),
          num(row['Total']), num(row['Subtotal']), num(row['Shipping']),
          num(row['Taxes']), num(row['Discount Amount']),
          txt(row['Discount Code'], 160), txt(row['Payment Method'], 120),
          txt(row['Billing Name'] || row['Shipping Name'], 200),
          txt(row['Email'], 255),
          txt(row['Shipping Phone'] || row['Billing Phone'] || row['Phone'], 40),
          txt(row['Shipping City'] || row['Billing City'], 120),
          txt(row['Shipping Province'] || row['Billing Province'], 120),
          txt(row['Shipping Zip'] || row['Billing Zip'], 20),
          stamp(row['Cancelled at']),
          0,
        ]);
        orders++;
      }

      const sku = txt(row['Lineitem sku'], 160);
      const iname = txt(row['Lineitem name'], 500);
      if (sku || iname) {
        itemBuf.push([name, sku, iname, int(row['Lineitem quantity']),
                      num(row['Lineitem price']), num(row['Lineitem discount'])]);
        items++;
      }

      if (orderBuf.length >= ORDER_BATCH) { await flushOrders(orderBuf); orderBuf = []; }
      if (itemBuf.length >= ITEM_BATCH) { await flushItems(itemBuf); itemBuf = []; }
    }
    process.stdout.write(`  ${f.padEnd(26)} orders ${orders.toLocaleString('en-IN').padStart(9)}` +
                         `   items ${items.toLocaleString('en-IN').padStart(9)}\n`);
  }
  await flushOrders(orderBuf);
  await flushItems(itemBuf);

  // total_lines is only knowable once every file has been read, because one
  // order's lines can straddle two files.
  await db.query(
    `UPDATE sfy_orders o
        SET total_lines = (SELECT COUNT(*) FROM sfy_order_items i
                            WHERE i.order_no = o.order_no)`);

  // The export gives no per-line status, so a line inherits its order's. This
  // has to be set: the pages filter items with LOWER(status) <> 'cancelled',
  // and a null would quietly exclude every row loaded here.
  await db.query(
    `UPDATE sfy_order_items i JOIN sfy_orders o ON o.order_no = i.order_no
        SET i.status = CASE WHEN o.cancelled_at IS NOT NULL THEN 'cancelled'
                            ELSE 'fulfilled' END`);

  const sum = await db.one(
    `SELECT COUNT(*) orders, DATE_FORMAT(MIN(order_date), '%Y-%m-%d') first_d,
            DATE_FORMAT(MAX(order_date), '%Y-%m-%d') last_d,
            ROUND(SUM(CASE WHEN cancelled_at IS NULL THEN order_amount ELSE 0 END)) revenue
       FROM sfy_orders`);
  const it = await db.one(
    'SELECT COUNT(*) n, SUM(order_qty) units FROM sfy_order_items');

  console.log(`\nloaded ${Number(sum.orders).toLocaleString('en-IN')} orders, ` +
              `${Number(it.n).toLocaleString('en-IN')} items, ` +
              `${Number(it.units).toLocaleString('en-IN')} units`);
  console.log(`range  ${sum.first_d} to ${sum.last_d}`);
  console.log(`value  Rs ${Number(sum.revenue).toLocaleString('en-IN')} (cancelled excluded)`);
  if (skipped) console.log(`skipped ${skipped} rows with no order name`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
