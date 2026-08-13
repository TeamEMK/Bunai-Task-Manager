// ══════════════════════════════════════════════════════
// AUTH — login, logout, "who am I", plus the two operator endpoints
// (/api/setup runs migrations on demand, /api/debug reports connectivity).
// ══════════════════════════════════════════════════════
const express = require('express');
const config = require('../config');
const { db, isDbConnError, DB_DOWN_MESSAGE } = require('../db/pool');
const { runMigrations, seedDefaultAdmin } = require('../db/migrations');
const { signToken, requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errors');
const passwords = require('../services/passwords');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.one(
      'SELECT id, name, email, password, role FROM users WHERE email = ?', [email]);

    // No such address still costs one bcrypt comparison, so response time
    // cannot be used to discover which emails are registered.
    if (!user) {
      await passwords.burnTime(password);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!await passwords.verify(password, user.password)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Upgrade the stored hash in the background when BCRYPT_ROUNDS has moved.
    // The user is already authenticated, so a failure here costs nothing.
    if (passwords.needsRehash(user.password)) {
      passwords.hash(password)
        .then(h => db.query('UPDATE users SET password=? WHERE id=?', [h, user.id]))
        .catch(e => console.error('  ⚠️ password re-hash failed:', e.message));
    }

    const token = signToken(user);
    res.cookie('token', token, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      maxAge: config.auth.cookieMaxAgeMs,
    });
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role, token });
  } catch (err) {
    // If the DB itself is unreachable/rejecting us, show a clean message —
    // never the raw "Access denied for user ...@... (using password: YES)".
    if (isDbConnError(err)) {
      console.error('  ❌ Login failed — DB connection error:', err.message);
      return res.status(503).json({ error: DB_DOWN_MESSAGE });
    }
    console.error('  ❌ Login error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

const ME_COLUMNS = `id, name, email, notification_email, role,
       COALESCE(user_role, role) AS user_role,
       phone, profile_image, department, week_off`;

router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  // extra_off used to need its own query "in case the column is missing".
  // It is one column of the same row — the fallback only runs on a database
  // that predates the migration.
  let row;
  try {
    row = await db.one(
      `SELECT ${ME_COLUMNS}, COALESCE(extra_off,'') AS extra_off FROM users WHERE id=?`,
      [req.session.userId]);
  } catch (e) {
    if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    row = await db.one(`SELECT ${ME_COLUMNS} FROM users WHERE id=?`, [req.session.userId]);
    if (row) row.extra_off = '';
  }
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json(row);
}));

// ══════════════════════════════════════════════════════
// 🛠️ SETUP — forces migrations + admin seed on demand.
// Visit /api/setup in a browser when the automatic run at boot was skipped.
// It is the SAME migration code the server runs at startup (it used to be a
// second, hand-maintained copy of every CREATE TABLE that drifted from the first).
// ══════════════════════════════════════════════════════
router.get('/setup', async (req, res) => {
  const log = [];
  try {
    await db.query('SELECT 1');
    log.push('✅ DB connection OK');
    log.push(...await runMigrations({ verbose: false }));
    const seeded = await seedDefaultAdmin({ verbose: false });
    log.push(seeded ? `🌱 Admin user seeded: ${seeded} / password` : 'ℹ️ Users already exist — no seed needed');

    res.send(`
      <html><head><title>Setup Complete</title>
      <style>body{font-family:monospace;background:#1a1a1a;color:#0f0;padding:30px;line-height:1.6;}
      h2{color:#F39C12;}a{color:#F39C12;}</style></head>
      <body>
      <h2>🎯 Bunai Task Manager — Setup</h2>
      <pre>${log.join('\n')}</pre>
      <hr>
      <p>✅ Setup done! Now <a href="/">click here to login</a></p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`
      <html><body style="font-family:monospace;background:#1a1a1a;color:#f55;padding:30px;">
      <h2 style="color:#f55;">❌ Setup Failed</h2>
      <pre>${err.message}\n\nLogs so far:\n${log.join('\n')}</pre>
      </body></html>
    `);
  }
});

// ── Connectivity report for the operator ──────────────
router.get('/debug', async (req, res) => {
  const result = { time: new Date().toISOString(), env: {}, db: {}, tables: {} };
  result.env = {
    NODE_ENV: process.env.NODE_ENV || '(not set)',
    DB_HOST: config.db.host,
    DB_USER: config.db.user,
    DB_NAME: config.db.name,
    PORT: String(config.port),
  };
  try {
    await db.query('SELECT 1');
    result.db.connected = true;
    // One query instead of four round trips.
    const [[counts]] = await db.query(`SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM delegation_tasks) AS delegation_tasks,
      (SELECT COUNT(*) FROM checklist_tasks) AS checklist_tasks,
      (SELECT COUNT(*) FROM fms_sheets) AS fms_sheets`).catch(e => [[{ error: e.message }]]);
    result.tables = counts;
    try {
      result.users = await db.rows('SELECT id, name, role, department FROM users ORDER BY role, name');
    } catch (e) { result.users = 'ERROR: ' + e.message; }
  } catch (e) {
    result.db.connected = false;
    result.db.error = e.message;
  }
  res.json(result);
});

module.exports = router;
