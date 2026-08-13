// ══════════════════════════════════════════════════════
// MIGRATIONS — brings any database (empty, old, or current) up to schema.js.
//
// It first asks information_schema what already exists, then issues ONLY the
// missing DDL. The previous version fired every CREATE/ALTER on every boot and
// threw away the "already exists" errors, which cost ~60 round trips per cold
// start and hid real failures among the noise.
// ══════════════════════════════════════════════════════
const bcrypt = require('bcryptjs');
const { db, ready } = require('./pool');
const config = require('../config');
const { TABLES, COLUMNS, INDEXES, BACKFILLS } = require('./schema');

// "Already exists" is the normal case on a re-run and stays quiet. Anything
// else is a real schema bug — a fully silent catch is what let a bad TEXT
// DEFAULT hide a missing column and a missing table for good.
const BENIGN_DDL = new Set([
  'ER_DUP_FIELDNAME', 'ER_TABLE_EXISTS_ERROR', 'ER_DUP_KEYNAME',
  'ER_DUP_ENTRY', 'ER_CANT_DROP_FIELD_OR_KEY', 'ER_MULTIPLE_PRI_KEY',
]);

// Reads the current shape of the database in three queries. Returns null when
// information_schema is not readable (some locked-down shared hosts), in which
// case the caller falls back to firing the DDL blind.
async function loadCatalog() {
  try {
    const [tRows] = await db.query(
      `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`);
    const [cRows] = await db.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`);
    const [iRows] = await db.query(
      `SELECT DISTINCT TABLE_NAME AS t, INDEX_NAME AS i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()`);
    const lower = v => String(v).toLowerCase();
    return {
      tables: new Set(tRows.map(r => lower(r.t))),
      columns: new Set(cRows.map(r => `${lower(r.t)}.${lower(r.c)}`)),
      indexes: new Set(iRows.map(r => `${lower(r.t)}.${lower(r.i)}`)),
    };
  } catch (e) {
    console.warn(`  ⚠️ information_schema not readable (${e.code || e.message}) — applying schema blind`);
    return null;
  }
}

// Strips the "(191)" prefix lengths so the column list can be reused in a
// GROUP BY when checking whether a UNIQUE key is safe to add.
const bareColumns = cols => cols.split(',').map(c => c.trim().replace(/\(\d+\)$/, ''));

async function runMigrations({ verbose = true } = {}) {
  await ready.catch(() => {});
  const log = [];
  const note = (line) => { log.push(line); if (verbose && line.startsWith('⚠')) console.error(`  ${line}`); };

  const exec = async (sql, label) => {
    try { await db.query(sql); note(`✅ ${label}`); return true; }
    catch (e) {
      if (BENIGN_DDL.has(e.code)) { note(`• ${label} (already present)`); return true; }
      note(`⚠️ ${label} — [${e.code || 'ERR'}] ${e.sqlMessage || e.message}`);
      return false;
    }
  };

  let catalog = await loadCatalog();
  const hasTable = t => !catalog || catalog.tables.has(t.toLowerCase());
  const hasColumn = (t, c) => !!catalog && catalog.columns.has(`${t.toLowerCase()}.${c.toLowerCase()}`);
  const hasIndex = (t, i) => !!catalog && catalog.indexes.has(`${t.toLowerCase()}.${i.toLowerCase()}`);

  // ── 1) Tables ────────────────────────────────────────
  let created = 0;
  for (const [name, ddl] of TABLES) {
    if (catalog && catalog.tables.has(name.toLowerCase())) continue;
    await exec(ddl.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS '), `table ${name}`);
    created++;
  }
  // A table just created already carries every column and key its CREATE names,
  // so re-read the catalog rather than firing ALTERs that can only fail with
  // "duplicate column". Costs three queries, and only on a fresh database.
  if (created && catalog) catalog = await loadCatalog();

  // ── 2) Columns added since the table first shipped ───
  let altered = 0;
  for (const [table, column, fragment] of COLUMNS) {
    if (!hasTable(table)) continue;                 // table itself is missing — nothing to alter
    if (hasColumn(table, column)) continue;         // already there
    const ok = await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${fragment}`, `${table}.${column}`);
    if (ok && catalog) catalog.columns.add(`${table.toLowerCase()}.${column.toLowerCase()}`);
    altered++;
  }

  // ── 3) Indexes ───────────────────────────────────────
  let indexed = 0;
  for (const [table, name, cols, opts] of INDEXES) {
    if (!hasTable(table)) continue;
    if (hasIndex(table, name)) continue;
    // A UNIQUE key cannot be added on top of data that already violates it.
    // Check first so the failure is a clear log line, not a stack trace.
    if (opts && opts.unique) {
      try {
        const group = bareColumns(cols).join(', ');
        const [[dup]] = await db.query(
          `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} GROUP BY ${group} HAVING COUNT(*) > 1 LIMIT 1) d`);
        if (dup && Number(dup.n) > 0) {
          note(`⚠️ ${table}.${name} skipped — duplicate rows exist for (${group}); clean them up, then restart`);
          continue;
        }
      } catch (e) { /* table empty / unreadable — let the ALTER decide */ }
    }
    const kind = (opts && opts.unique) ? 'UNIQUE INDEX' : 'INDEX';
    const ok = await exec(`ALTER TABLE ${table} ADD ${kind} ${name} (${cols})`, `index ${table}.${name}`);
    if (ok && catalog) catalog.indexes.add(`${table.toLowerCase()}.${name.toLowerCase()}`);
    indexed++;
  }

  // ── 4) Backfills ─────────────────────────────────────
  for (const [sql, label] of BACKFILLS) {
    if (!hasTable(sql.match(/UPDATE\s+(\w+)/i)[1])) continue;
    await exec(sql, label);
  }

  if (verbose) {
    console.log(`  ✅ DB migrations checked (${created} tables, ${altered} columns, ${indexed} indexes applied)`);
  }
  note(`✅ schema up to date — ${created} tables, ${altered} columns, ${indexed} indexes applied`);
  return log;
}

// Seeds a first admin so a brand-new deployment is usable. Never touches a
// database that already has users.
async function seedDefaultAdmin({ verbose = true } = {}) {
  try {
    const [[{ cnt }]] = await db.query('SELECT COUNT(*) AS cnt FROM users');
    if (cnt > 0) return null;
    const hash = bcrypt.hashSync('password', config.auth.bcryptRounds);
    await db.query(
      'INSERT INTO users (name, email, password, role, department) VALUES (?,?,?,?,?)',
      ['Aman Admin', 'aman@test.com', hash, 'admin', 'Management']);
    if (verbose) console.log('  🌱 Default admin seeded → aman@test.com / password');
    return 'aman@test.com';
  } catch (e) {
    if (verbose) console.error('  ⚠️ Admin seed skipped:', e.message);
    return null;
  }
}

// Started at import time, awaited by the /api gate in app.js. On a warm
// serverless instance it is already resolved, so the gate costs nothing.
const migrationsReady = (async () => {
  await runMigrations();
  await seedDefaultAdmin();
})();

module.exports = { runMigrations, seedDefaultAdmin, migrationsReady };
