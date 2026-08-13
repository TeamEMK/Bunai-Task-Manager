// ══════════════════════════════════════════════════════
// MYSQL POOL
// One pool for the whole app, wrapped so that:
//   • every query waits until a WORKING pool exists (TCP, else UNIX socket),
//   • "too many connections" is retried with back-off instead of surfacing,
//   • infrastructure errors are recognisable (isDbConnError) and never leaked.
// ══════════════════════════════════════════════════════
const mysql = require('mysql2/promise');
const fs = require('fs');
const config = require('../config');

// Fields shared by both the TCP and the UNIX-socket connection styles.
const baseDbConfig = {
  user: config.db.user,
  password: config.db.password,
  database: config.db.name,
  waitForConnections: true,
  connectionLimit: config.db.poolSize,
  queueLimit: 0,
  connectTimeout: 30000,
  // Release idle connections quickly (MySQL defaults to 8 hours; 30s is ideal)
  idleTimeout: 30000,
  enableKeepAlive: false,
  // SSL support for cloud MySQL providers (Aiven, PlanetScale, Railway, etc.)
  ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
};

const tcpDbConfig = { ...baseDbConfig, host: config.db.host, port: config.db.port };

// ⚠️ WHY YOU MIGHT SEE "Access denied for user ...@'127.0.0.1' (using password: YES)":
// Node's mysql2 driver ALWAYS uses TCP. Even when DB_HOST is "localhost", it
// resolves to 127.0.0.1 and connects over TCP, so MySQL sees the connection as
// user@127.0.0.1. On Hostinger/cPanel the DB user is usually granted for
// 'localhost' (the UNIX socket) — a DIFFERENT account than '127.0.0.1' in MySQL.
// That's why flipping DB_HOST between "localhost" and "127.0.0.1" doesn't help.
// Fix: if TCP is rejected we retry through the local MySQL socket, which makes
// MySQL see user@localhost and matches the grant.
// `let` because the socket fallback may swap this pool out for a working one.
let rawPool = mysql.createPool(tcpDbConfig);

// Detect "the database itself is unreachable / rejected us" errors.
// These are infrastructure/config problems (wrong password, host, DB down) —
// NOT something the end user did. We must NEVER leak these raw to the browser:
// the raw message exposes the DB username/host publicly and confuses users.
const DB_CONN_ERROR_CODES = new Set([
  'ER_ACCESS_DENIED_ERROR',   // wrong user/password
  'ER_DBACCESS_DENIED_ERROR', // user can't access this database
  'ER_BAD_DB_ERROR',          // database name doesn't exist
  'ECONNREFUSED',             // nothing listening on host:port
  'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', // host wrong/unreachable
  'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR', 'ER_USER_LIMIT_REACHED',
]);

function isDbConnError(err) {
  return !!err && DB_CONN_ERROR_CODES.has(err.code || '');
}

// Friendly message sent to the browser when the DB is the problem.
// The real error is always logged server-side for the operator.
const DB_DOWN_MESSAGE = 'Server can’t reach the database right now. Please check the server configuration (or try again in a moment).';

// Resolves once a WORKING pool (TCP or socket) is established. Every query waits
// on this so migrations/requests never run against a dead pool.
const ready = (async () => {
  // ── 1) Try TCP (DB_HOST:DB_PORT) ──────────────────────
  try {
    await rawPool.query('SELECT 1');
    console.log(`  ✅ MySQL Connected (TCP ${tcpDbConfig.host}:${tcpDbConfig.port})`);
    return;
  } catch (err) {
    const code = err.code || '';
    console.error(`  ⚠️ MySQL TCP connect failed (${code || err.message})`);
    const worthSocketFallback = [
      'ER_ACCESS_DENIED_ERROR', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
    ].includes(code);
    if (!worthSocketFallback) {
      console.error('  ❌ MySQL Connection Failed:', err.message);
      return; // wrong DB name etc. — socket won't help
    }
  }

  // ── 2) Fallback: local UNIX socket → MySQL sees user@localhost ──
  console.error('  ↻ Retrying via local MySQL socket (so MySQL sees user@localhost)...');
  const socketPaths = [
    config.db.socket,                      // explicit override, if you know the path
    '/var/run/mysqld/mysqld.sock',
    '/run/mysqld/mysqld.sock',
    '/var/lib/mysql/mysql.sock',
    '/tmp/mysql.sock',
  ].filter(Boolean);

  for (const socketPath of socketPaths) {
    try { if (!fs.existsSync(socketPath)) continue; } catch (_) { continue; }
    try {
      const socketPool = mysql.createPool({ ...baseDbConfig, socketPath });
      await socketPool.query('SELECT 1');
      await rawPool.end().catch(() => {});
      rawPool = socketPool; // swap in the working pool — db.query picks it up
      console.log(`  ✅ MySQL Connected (socket ${socketPath})`);
      return;
    } catch (e) {
      console.error(`  ⚠️ socket ${socketPath} failed (${e.code || e.message})`);
    }
  }

  // ── 3) Nothing worked — print the most useful next steps ──
  console.error('  ❌ MySQL Connection Failed via both TCP and socket.');
  console.error('     Most likely causes, in order:');
  console.error('       1. DB_PASSWORD is wrong — reset it in hPanel → Databases, update the env var, then REDEPLOY.');
  console.error('       2. The DB user is not assigned to the database (hPanel → MySQL Databases → add user to DB).');
  console.error('       3. Env-var edits do not apply until you REDEPLOY/restart the app.');
})();

const CONN_LIMIT_RETRIES = 3;
const isConnLimitError = (err) => !!err && (
  err.code === 'ER_USER_LIMIT_REACHED' ||
  err.code === 'ER_CON_COUNT_ERROR' ||
  (err.message || '').includes('max_user_connections') ||
  (err.message || '').includes('Too many connections')
);

// Shared retry loop for both query() and execute(): shared hosting hands out
// "max_user_connections" whenever several serverless instances arrive at once,
// and a short back-off recovers without the user ever seeing an error.
async function runWithRetry(method, sql, params) {
  await ready.catch(() => {});
  for (let attempt = 1; ; attempt++) {
    try {
      return params === undefined ? await rawPool[method](sql) : await rawPool[method](sql, params);
    } catch (err) {
      if (!isConnLimitError(err) || attempt >= CONN_LIMIT_RETRIES) throw err;
      const wait = attempt * 250 + Math.random() * 250;   // 250ms, 500ms, …
      console.warn(`  ⚠️ DB conn limit hit, retry ${attempt}/${CONN_LIMIT_RETRIES} after ${Math.round(wait)}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

const db = {
  query: (sql, params) => runWithRetry('query', sql, params),
  // Prepared-statement path. It used to be missing from this wrapper entirely,
  // which is why every /api/week-plan save failed with "db.execute is not a
  // function" and was swallowed as "Failed to save plan".
  execute: (sql, params) => runWithRetry('execute', sql, params),

  // ── Convenience readers — they exist so callers stop writing `const [[x]] =`
  // and accidentally destructuring undefined when a row is missing.
  async rows(sql, params) { const [r] = await runWithRetry('query', sql, params); return r; },
  async one(sql, params) { const [r] = await runWithRetry('query', sql, params); return r[0] || null; },

  // Transactions need a real connection, not the pool.
  async getConnection(...args) {
    await ready.catch(() => {});
    return rawPool.getConnection(...args);
  },
  end: (...args) => rawPool.end(...args),
};

module.exports = { db, ready, isDbConnError, DB_DOWN_MESSAGE };
