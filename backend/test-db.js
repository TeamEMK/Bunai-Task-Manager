// Connection checker — run after pointing .env at a new database.
//   node test-db.js
// Reports exactly which step failed instead of a bare stack trace, so you can
// tell a wrong password apart from an unreachable host.
require('dotenv').config();
const mysql = require('mysql2/promise');

const cfg = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || '',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  connectTimeout: 15000,
};

const hint = {
  ETIMEDOUT: 'Host unreachable. On Railway this usually means the INTERNAL host was used —\n     you need the public one (*.proxy.rlwy.net) plus its 5-digit port.',
  ENOTFOUND: 'Hostname does not resolve. Check DB_HOST for a typo.',
  ECONNREFUSED: 'Nothing is listening on that host:port. Check DB_PORT, and that a\n     public TCP proxy exists on the Railway service.',
  ER_ACCESS_DENIED_ERROR: 'Wrong DB_USER or DB_PASSWORD.',
  ER_BAD_DB_ERROR: 'That database name does not exist. Check DB_NAME.',
};

(async () => {
  console.log('\n  Target');
  console.log(`    host     ${cfg.host}:${cfg.port}`);
  console.log(`    user     ${cfg.user}`);
  console.log(`    database ${cfg.database || '(not set)'}`);
  console.log(`    ssl      ${cfg.ssl ? 'on' : 'off'}`);
  if (/railway\.internal$/.test(cfg.host)) {
    console.log('\n  ⚠️  That is Railway\'s INTERNAL host — only reachable from inside Railway.');
    console.log('     Use the public host instead, or this will time out.');
  }

  let conn;
  const t0 = Date.now();
  try {
    conn = await mysql.createConnection(cfg);
  } catch (e) {
    console.error(`\n  ❌ Could not connect  [${e.code || 'ERR'}]  ${e.sqlMessage || e.message}`);
    if (hint[e.code]) console.error(`     → ${hint[e.code]}`);
    process.exit(1);
  }
  console.log(`\n  ✅ Connected in ${Date.now() - t0} ms`);

  const [[v]] = await conn.query('SELECT VERSION() AS v, DATABASE() AS db');
  console.log(`     server   ${v.v}`);
  console.log(`     database ${v.db}`);

  const [tables] = await conn.query('SHOW TABLES');
  if (!tables.length) {
    console.log('\n     No tables yet — that is fine. Start the app once and it creates them.');
  } else {
    console.log(`\n     ${tables.length} table(s):`);
    for (const row of tables) {
      const name = Object.values(row)[0];
      const [[c]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
      console.log(`       ${name.padEnd(24)} ${c.n} row(s)`);
    }
  }

  // Write permission matters: the app creates its own schema on boot.
  try {
    await conn.query('CREATE TABLE IF NOT EXISTS _bunai_write_probe (id INT)');
    await conn.query('DROP TABLE _bunai_write_probe');
    console.log('\n  ✅ User can create and drop tables — schema setup will work');
  } catch (e) {
    console.error(`\n  ❌ No DDL permission [${e.code}] — the app cannot create its tables`);
  }

  await conn.end();
  console.log('');
})();
