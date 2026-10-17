// ══════════════════════════════════════════════════════
// SHOPIFY PROSPECTS — people who signed up on the store and never ordered.
//
//   node backend/shopify-prospects.js           changes since the last run
//   node backend/shopify-prospects.js --full    reload everyone
//
// The calling list is built from orders, so an account with none is invisible
// to it — 4.3 lakh of the store's 7 lakh. sfy_prospects holds them.
//
// --full asks Shopify for a bulk export of every customer with no orders: one
// job that runs on Shopify's side for a few minutes and hands back a file,
// where paging 430,000 customers through the API would take hours. The table
// is filled beside the live one and swapped in, as the customer roll-up is.
//
// The ordinary run, part of the daily sync, reads only the customers Shopify
// changed since the last run: new sign-ups arrive, anyone now showing an order
// leaves. That alone is not enough to catch a first order — Shopify does not
// touch a customer's updatedAt when they place one (71 customers had changed in
// four days of trading). So buyers are found from the orders instead: a
// prospect whose phone is now in sfy_customers, or whose email is on an order,
// is deleted. Which is also right for someone who checked out as a guest with
// the same phone — they have ordered, whatever their account says.
// ══════════════════════════════════════════════════════
const { Readable } = require('stream');
const readline = require('readline');
const { db } = require('./src/db/pool');
const shopify = require('./shopify');

const log = (s) => console.log(s);
const PAGE = 250;
const CHUNK = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIELDS = `id firstName lastName createdAt numberOfOrders
  defaultEmailAddress { emailAddress marketingState }
  defaultPhoneNumber { phoneNumber marketingState }
  defaultAddress { city province countryCodeV2 phone }`;

const COLS = `customer_id, name, email, phone, phone_full, city, state, country,
              accepts_email, accepts_sms, signed_up`;

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
// No address to consent with is not a "no"; it is nothing to say.
const consent = (x) => (x ? (x.marketingState === 'SUBSCRIBED' ? 1 : 0) : null);

// Placeholders the store and the integration wrote where there was no email.
// Matching prospects on one of these would delete strangers.
const REAL_EMAIL = `LOCATE('@', e) > 1 AND e NOT LIKE 'sfy@%' AND e NOT LIKE '%noemail%'`;

function prospectRow(c) {
  const a = c.defaultAddress || {};
  const raw = (c.defaultPhoneNumber && c.defaultPhoneNumber.phoneNumber) || a.phone || '';
  const digits = String(raw).replace(/\D/g, '');
  return [
    Number(String(c.id).split('/').pop()),
    clip([c.firstName, c.lastName].filter(Boolean).join(' '), 200),
    clip(c.defaultEmailAddress && c.defaultEmailAddress.emailAddress, 255).toLowerCase(),
    // The calling list's key: the last ten digits, so +91 98... and 098...
    // are the same person and a logged call follows them once they order.
    digits.length >= 10 ? digits.slice(-10) : '',
    clip(raw, 40),
    clip(a.city, 120), clip(a.province, 120), clip(a.countryCodeV2, 8),
    consent(c.defaultEmailAddress), consent(c.defaultPhoneNumber),
    shopify.toIst(c.createdAt),
  ];
}

async function insert(table, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.query(
      `INSERT INTO ${table} (${COLS}) VALUES ?
       ON DUPLICATE KEY UPDATE name=VALUES(name), email=VALUES(email), phone=VALUES(phone),
         phone_full=VALUES(phone_full), city=VALUES(city), state=VALUES(state),
         country=VALUES(country), accepts_email=VALUES(accepts_email),
         accepts_sms=VALUES(accepts_sms), signed_up=VALUES(signed_up),
         updated_at=CURRENT_TIMESTAMP`, [rows.slice(i, i + CHUNK)]);
  }
}

async function ensureLog() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sfy_prospect_sync_log (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      kind       VARCHAR(12) NOT NULL,
      started_at DATETIME NOT NULL,
      ended_at   DATETIME NULL,
      seen       INT NOT NULL DEFAULT 0,
      removed    INT NULL,
      total      INT NULL,
      ok         TINYINT(1) NOT NULL DEFAULT 0,
      error      TEXT NULL,
      KEY idx_sfy_psl (started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// Anyone who has ordered since `fromUtc` (all time when null). Phones are
// checked against the whole roll-up every run — it is one indexed join.
async function dropBuyers(fromUtc) {
  const [byPhone] = await db.query(
    `DELETE p FROM sfy_prospects p JOIN sfy_customers c ON c.phone = p.phone WHERE p.phone <> ''`);
  // order_date is India's time; a day of slack either side of the boundary
  // costs nothing.
  const [byEmail] = await db.query(
    `DELETE p FROM sfy_prospects p
       JOIN (SELECT DISTINCT e FROM (SELECT LOWER(TRIM(customer_email)) e FROM sfy_orders
                                      WHERE customer_email IS NOT NULL
                                        ${fromUtc ? 'AND order_date >= ? + INTERVAL 330 MINUTE - INTERVAL 1 DAY' : ''}) x
              WHERE ${REAL_EMAIL}) o ON o.e = p.email
      WHERE p.email <> ''`, fromUtc ? [fromUtc] : []);
  return byPhone.affectedRows + byEmail.affectedRows;
}

const dbNow = async () =>
  (await db.one(`SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s') t`)).t;
const toMysql = (iso) => new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
const toIso = (mysql) => mysql.replace(' ', 'T') + 'Z';

// ── the ordinary run ──────────────────────────────────
async function syncProspects() {
  await ensureLog();
  const last = await db.one(
    `SELECT DATE_FORMAT(started_at - INTERVAL 1 HOUR, '%Y-%m-%d %H:%i:%s') since
       FROM sfy_prospect_sync_log WHERE ok = 1 ORDER BY started_at DESC LIMIT 1`);
  if (!last) return { skipped: 'never loaded - run node backend/shopify-prospects.js --full' };

  const started = await dbNow();
  const [ins] = await db.query(
    `INSERT INTO sfy_prospect_sync_log (kind, started_at) VALUES ('changes', ?)`, [started]);
  try {
    const q = `updated_at:>='${toIso(last.since)}'`;
    let cursor = null, seen = 0, gone = 0;
    do {
      const d = await shopify.gql(`query($q: String!, $cursor: String) {
        customers(first: ${PAGE}, after: $cursor, sortKey: UPDATED_AT, query: $q) {
          pageInfo { hasNextPage endCursor } nodes { ${FIELDS} } } }`, { q, cursor });
      const page = d.customers;
      const keep = [], ordered = [];
      for (const c of page.nodes) {
        seen++;
        if (Number(c.numberOfOrders) > 0) ordered.push(Number(String(c.id).split('/').pop()));
        else keep.push(prospectRow(c));
      }
      if (keep.length) await insert('sfy_prospects', keep);
      if (ordered.length) {
        const [del] = await db.query('DELETE FROM sfy_prospects WHERE customer_id IN (?)', [ordered]);
        gone += del.affectedRows;
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);

    gone += await dropBuyers(last.since);
    const total = Number((await db.one('SELECT COUNT(*) n FROM sfy_prospects')).n);
    await db.query(
      'UPDATE sfy_prospect_sync_log SET ended_at=UTC_TIMESTAMP(), seen=?, removed=?, total=?, ok=1 WHERE id=?',
      [seen, gone, total, ins.insertId]);
    return { seen, removed: gone, total };
  } catch (e) {
    await db.query('UPDATE sfy_prospect_sync_log SET ended_at=UTC_TIMESTAMP(), error=? WHERE id=?',
      [String(e.message).slice(0, 2000), ins.insertId]);
    throw e;
  }
}

// ── the full reload ───────────────────────────────────
// Waits for a bulk export of every zero-order customer, starting one unless
// one is already running (Shopify allows one at a time, and a run interrupted
// halfway can pick its own job back up).
async function bulkFile() {
  const current = async () => (await shopify.gql(
    `{ currentBulkOperation { id status errorCode objectCount url createdAt query } }`)).currentBulkOperation;
  let op = await current();
  const ours = op && /orders_count:0/.test(op.query || '');
  if (!op || !ours || !['CREATED', 'RUNNING', 'COMPLETED'].includes(op.status)
      || (op.status === 'COMPLETED' && Date.now() - Date.parse(op.createdAt) > 6 * 3600000)) {
    const d = await shopify.gql(`mutation($q: String!) { bulkOperationRunQuery(query: $q) {
      bulkOperation { id status createdAt } userErrors { message } } }`,
    { q: `{ customers(query: "orders_count:0") { edges { node { ${FIELDS} } } } }` });
    const errs = d.bulkOperationRunQuery.userErrors;
    if (errs.length) throw new Error('Shopify bulk export: ' + errs.map((e) => e.message).join('; '));
    log('  bulk export started');
  }
  for (;;) {
    op = await current();
    if (op.status === 'COMPLETED') return op;
    if (!['CREATED', 'RUNNING'].includes(op.status)) {
      throw new Error(`Shopify bulk export ${op.status}${op.errorCode ? ' (' + op.errorCode + ')' : ''}`);
    }
    log(`  ${op.status.toLowerCase()} — ${Number(op.objectCount).toLocaleString('en-IN')} customers so far`);
    await sleep(15000);
  }
}

async function fullReload() {
  await ensureLog();
  const op = await bulkFile();
  // The export is as of when the job began, so the next ordinary run reads
  // the changes from then.
  const [ins] = await db.query(
    `INSERT INTO sfy_prospect_sync_log (kind, started_at) VALUES ('full', ?)`, [toMysql(op.createdAt)]);
  try {
    await db.query('DROP TABLE IF EXISTS sfy_prospects_new');
    await db.query('CREATE TABLE sfy_prospects_new LIKE sfy_prospects');

    let seen = 0, batch = [];
    if (op.url) {
      const res = await fetch(op.url);
      if (!res.ok) throw new Error('Could not download the bulk export (' + res.status + ')');
      const lines = readline.createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        const c = JSON.parse(line);
        if (Number(c.numberOfOrders) > 0) continue;
        batch.push(prospectRow(c));
        seen++;
        if (batch.length >= CHUNK) {
          await insert('sfy_prospects_new', batch);
          batch = [];
          if (seen % 50000 === 0) log(`  ${seen.toLocaleString('en-IN')} loaded`);
        }
      }
      if (batch.length) await insert('sfy_prospects_new', batch);
    }

    await db.query('DROP TABLE IF EXISTS sfy_prospects_old');
    await db.query('RENAME TABLE sfy_prospects TO sfy_prospects_old, sfy_prospects_new TO sfy_prospects');
    await db.query('DROP TABLE sfy_prospects_old');

    const removed = await dropBuyers(null);
    const total = Number((await db.one('SELECT COUNT(*) n FROM sfy_prospects')).n);
    await db.query(
      'UPDATE sfy_prospect_sync_log SET ended_at=UTC_TIMESTAMP(), seen=?, removed=?, total=?, ok=1 WHERE id=?',
      [seen, removed, total, ins.insertId]);
    return { seen, removed, total };
  } catch (e) {
    await db.query('UPDATE sfy_prospect_sync_log SET ended_at=UTC_TIMESTAMP(), error=? WHERE id=?',
      [String(e.message).slice(0, 2000), ins.insertId]);
    throw e;
  }
}

module.exports = { syncProspects, fullReload, prospectRow };

if (require.main === module) {
  (async () => {
    const { runMigrations } = require('./src/db/migrations');
    await runMigrations();
    const full = process.argv.includes('--full');
    log(full ? 'Shopify prospects — full reload' : 'Shopify prospects — changes since the last run');
    const r = full ? await fullReload() : await syncProspects();
    log(r.skipped ? 'skipped: ' + r.skipped
      : `done: ${r.seen.toLocaleString('en-IN')} read, ${r.removed.toLocaleString('en-IN')} removed as buyers, `
        + `${r.total.toLocaleString('en-IN')} prospects`);
    process.exit(0);
  })().catch((e) => { console.error('\nFAILED: ' + e.message); process.exit(1); });
}
