// ══════════════════════════════════════════════════════
// Bunai Task Manager — Server
// Vercel-ready (serverless + local dev support)
// ══════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { Readable } = require('stream');
const ims = require('./ims');
const poUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // PO document upload — 20MB cap, kept in RAM (Vercel-safe, no disk write)

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.SESSION_SECRET || 'taskmanager_secret_2026';

const cookieParser = require('cookie-parser');
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════
// MIGRATION GATE — every /api request awaits in-flight schema migrations.
// On Vercel cold starts, fire-and-forget migration IIFEs may not complete
// before requests arrive. Without this, queries that reference newly-added
// columns (e.g. client_id) fail with "Unknown column" errors.
// On warm starts the promises are already resolved → near-zero overhead.
// ══════════════════════════════════════════════════════
app.use('/api', async (req, res, next) => {
  try {
    await _startupMigrationsPromise;
    await _clientsTableMigrationsPromise;
  } catch (e) { /* migration failures are logged elsewhere — keep serving */ }
  next();
});

// ══════════════════════════════════════════════════════
// MYSQL CONNECTION
// ══════════════════════════════════════════════════════
// Fields shared by both the TCP and the UNIX-socket connection styles.
const baseDbConfig = {
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bunai_task_manager',
  waitForConnections: true,
  // ⚠️ Shared hosting usually caps max_user_connections at 5-10.
  // Serverless platforms connect from several instances at once,
  // so the per-instance limit is kept small.
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 2,
  queueLimit: 0,
  connectTimeout: 30000,
  // Release idle connections quickly (MySQL defaults to 8 hours; 30s is ideal)
  idleTimeout: 30000,
  enableKeepAlive: false,
  // SSL support for cloud MySQL providers (Aiven, PlanetScale, Railway, etc.)
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
};

// Primary connection: TCP to DB_HOST:DB_PORT.
const tcpDbConfig = {
  ...baseDbConfig,
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
};

// ⚠️ WHY YOU MIGHT SEE "Access denied for user ...@'127.0.0.1' (using password: YES)":
// Node's mysql2 driver ALWAYS uses TCP. Even when DB_HOST is "localhost", it
// resolves to 127.0.0.1 and connects over TCP, so MySQL sees the connection as
// user@127.0.0.1. On Hostinger/cPanel the DB user is usually granted for
// 'localhost' (the UNIX socket) — a DIFFERENT account than '127.0.0.1' in MySQL.
// That's why flipping DB_HOST between "localhost" and "127.0.0.1" doesn't help.
// Fix: if TCP is rejected, we automatically retry through the local MySQL socket
// (below), which makes MySQL see user@localhost and matches the grant.
// `let` because the socket fallback may swap this pool out for a working one.
let _rawPool = mysql.createPool(tcpDbConfig);

// Resolves once a WORKING pool (TCP or socket) is established. Every query waits
// on this so migrations/requests never run against a dead pool. Assigned below.
let _dbReadyPromise = null;

// Wrap pool with retry logic for "max_user_connections" errors
// This error keeps appearing on shared hosting when Vercel sends concurrent requests.
// Auto-retry helps recover gracefully without showing errors to users.
const db = {
  async query(sql, params) {
    // Wait until a working pool (TCP or socket fallback) is ready.
    if (_dbReadyPromise) { try { await _dbReadyPromise; } catch (_) {} }
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await _rawPool.query(sql, params);
      } catch (err) {
        const isConnLimit = err.message && (
          err.message.includes('max_user_connections') ||
          err.message.includes('Too many connections') ||
          err.code === 'ER_USER_LIMIT_REACHED' ||
          err.code === 'ER_CON_COUNT_ERROR'
        );
        if (isConnLimit && attempt < maxRetries) {
          // Wait progressively longer before retry: 200ms, 500ms, 1000ms
          const wait = attempt * 250 + Math.random() * 250;
          console.warn(`  ⚠️ DB conn limit hit, retry ${attempt}/${maxRetries} after ${Math.round(wait)}ms`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw err;
      }
    }
  },
  // Pass-through for other methods (getConnection used by transactions)
  getConnection: async (...args) => {
    if (_dbReadyPromise) { try { await _dbReadyPromise; } catch (_) {} }
    return _rawPool.getConnection(...args);
  },
  end: (...args) => _rawPool.end(...args),
};

// Detect "the database itself is unreachable / rejected us" errors.
// These are infrastructure/config problems (wrong password, host, DB down) —
// NOT something the end user did. We must NEVER leak these raw to the browser:
// the raw message exposes the DB username/host publicly and confuses users.
function isDbConnError(err) {
  if (!err) return false;
  const code = err.code || '';
  return [
    'ER_ACCESS_DENIED_ERROR',   // wrong user/password
    'ER_DBACCESS_DENIED_ERROR', // user can't access this database
    'ER_BAD_DB_ERROR',          // database name doesn't exist
    'ECONNREFUSED',             // nothing listening on host:port
    'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', // host wrong/unreachable
    'PROTOCOL_CONNECTION_LOST',
    'ER_CON_COUNT_ERROR', 'ER_USER_LIMIT_REACHED',
  ].includes(code);
}

// Friendly message sent to the browser when the DB is the problem.
// The real error is always logged server-side for the operator.
const DB_DOWN_MESSAGE = 'Server can’t reach the database right now. Please check the server configuration (or try again in a moment).';

// Establish a working connection: try TCP first, then fall back to the local
// UNIX socket (fixes the Hostinger/cPanel "user granted for localhost" case).
_dbReadyPromise = (async () => {
  // ── 1) Try TCP (DB_HOST:DB_PORT) ──────────────────────
  try {
    await _rawPool.query('SELECT 1');
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
  const fs = require('fs');
  const socketPaths = [
    process.env.DB_SOCKET,                 // explicit override, if you know the path
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
      await _rawPool.end().catch(() => {});
      _rawPool = socketPool; // swap in the working pool — db.query picks it up
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

// ══════════════════════════════════════════════════════
// AUTO DB MIGRATIONS — runs on every server start
// Creates all tables + columns. Safe to re-run (uses IF NOT EXISTS / silent ALTER).
// On a fresh empty database, this gives you a fully working schema.
// ══════════════════════════════════════════════════════
// We capture the migration IIFE's promise so the request middleware can
// AWAIT it before serving any /api request. Vercel serverless cold starts
// otherwise begin handling requests while ALTERs are still in flight — which
// causes "Unknown column" errors for newly-added columns.
const _startupMigrationsPromise = (async () => {
  // Wait for a working pool (TCP or socket) before touching the schema.
  if (_dbReadyPromise) { try { await _dbReadyPromise; } catch (_) {} }
  // Idempotent DDL: "already exists" errors are the normal case on every restart
  // and stay quiet. Anything else is a real schema bug — a fully silent catch is
  // what let a bad TEXT DEFAULT hide a missing column and a missing table for good.
  const BENIGN_DDL = new Set([
    'ER_DUP_FIELDNAME', 'ER_TABLE_EXISTS_ERROR', 'ER_DUP_KEYNAME',
    'ER_DUP_ENTRY', 'ER_CANT_DROP_FIELD_OR_KEY', 'ER_MULTIPLE_PRI_KEY',
  ]);
  const sa = async (sql) => {
    try { await db.query(sql); }
    catch (e) {
      if (BENIGN_DDL.has(e.code)) return;
      console.error(`  ⚠️ migration failed [${e.code}] ${e.sqlMessage || e.message}`);
      console.error(`     ${String(sql).replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    }
  };

  // ── Base tables (CREATE IF NOT EXISTS) ────────────────
  await sa(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role ENUM('admin','hod','pc','user') DEFAULT 'user',
    phone VARCHAR(50) DEFAULT NULL,
    profile_image LONGTEXT DEFAULT NULL,
    exclude_from_reminder TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await sa(`CREATE TABLE IF NOT EXISTS delegation_tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    description TEXT NOT NULL,
    assigned_to INT NOT NULL,
    assigned_by INT NOT NULL,
    due_date DATE,
    status ENUM('pending','completed','revised') DEFAULT 'pending',
    priority ENUM('low','medium','high') DEFAULT 'low',
    approval ENUM('yes','no') DEFAULT 'no',
    waiting_approval TINYINT(1) DEFAULT 0,
    approver_id INT DEFAULT NULL,
    remarks TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_assigned_to (assigned_to),
    INDEX idx_status (status),
    INDEX idx_due_date (due_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await sa(`CREATE TABLE IF NOT EXISTS checklist_tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    description TEXT NOT NULL,
    assigned_to INT NOT NULL,
    assigned_by INT NOT NULL,
    due_date DATE,
    end_date DATE DEFAULT NULL,
    frequency VARCHAR(20) DEFAULT NULL,
    status ENUM('pending','completed') DEFAULT 'pending',
    priority ENUM('low','medium','high') DEFAULT 'low',
    remarks TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_assigned_to (assigned_to),
    INDEX idx_status (status),
    INDEX idx_due_date (due_date),
    INDEX idx_end_date (end_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await sa(`CREATE TABLE IF NOT EXISTS task_approvals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id INT NOT NULL,
    task_type VARCHAR(20) NOT NULL,
    requested_by INT NOT NULL,
    requested_to INT NOT NULL,
    action_type VARCHAR(50) DEFAULT NULL,
    status ENUM('pending','approved','rejected') DEFAULT 'pending',
    note TEXT DEFAULT NULL,
    new_date DATE DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_task (task_id, task_type),
    INDEX idx_requested_to (requested_to)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // WhatsApp daily reminder ka run-log + multi-instance lock.
  // The UNIQUE (log_date, kind) key lets only one instance run per day.
  await sa(`CREATE TABLE IF NOT EXISTS whatsapp_reminder_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    log_date DATE NOT NULL,
    kind VARCHAR(40) NOT NULL,
    status VARCHAR(20) DEFAULT 'running',
    sent INT DEFAULT 0,
    failed INT DEFAULT 0,
    note VARCHAR(500) DEFAULT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP NULL DEFAULT NULL,
    UNIQUE KEY uniq_day_kind (log_date, kind)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await sa(`CREATE TABLE IF NOT EXISTS task_comments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id INT NOT NULL,
    task_type VARCHAR(20) NOT NULL,
    user_id INT NOT NULL,
    comment TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_task (task_id, task_type)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await sa(`CREATE TABLE IF NOT EXISTS task_transfers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id INT NOT NULL,
    task_type VARCHAR(20) NOT NULL,
    from_user INT NOT NULL,
    to_user INT NOT NULL,
    requested_by INT NOT NULL,
    status ENUM('pending','approved','rejected') DEFAULT 'pending',
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await sa(`CREATE TABLE IF NOT EXISTS fms_sheets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sheet_name VARCHAR(255) NOT NULL,
    sheet_id VARCHAR(255) NOT NULL,
    header_row INT DEFAULT 1,
    total_steps INT DEFAULT 0,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await sa(`CREATE TABLE IF NOT EXISTS fms_steps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    fms_id INT NOT NULL,
    step_order INT NOT NULL,
    step_name VARCHAR(255) NOT NULL,
    plan_col VARCHAR(10) DEFAULT '',
    actual_col VARCHAR(10) DEFAULT '',
    extra_input VARCHAR(10) DEFAULT 'no',
    extra_col VARCHAR(10) DEFAULT '',
    INDEX idx_fms (fms_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await sa(`CREATE TABLE IF NOT EXISTS fms_step_doers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    step_id INT NOT NULL,
    user_id INT NOT NULL,
    INDEX idx_step (step_id),
    INDEX idx_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await sa(`CREATE TABLE IF NOT EXISTS fms_extra_rows (
    id INT AUTO_INCREMENT PRIMARY KEY,
    step_id INT NOT NULL,
    row_label VARCHAR(255) DEFAULT '',
    INDEX idx_step (step_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await sa(`CREATE TABLE IF NOT EXISTS week_plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    employee_id INT NOT NULL,
    hod_id INT,
    start_date DATE NOT NULL,
    target_count INT DEFAULT 0,
    improvement_pct DECIMAL(5,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_employee (employee_id),
    INDEX idx_start (start_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await sa(`CREATE TABLE IF NOT EXISTS holidays (
    id INT AUTO_INCREMENT PRIMARY KEY,
    holiday_date DATE NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    created_by INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_date (holiday_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await sa(`CREATE TABLE IF NOT EXISTS leave_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    leave_type ENUM('full_day','half_day','work_from_home','extra_working') NOT NULL,
    from_date DATE NOT NULL,
    to_date DATE NOT NULL,
    dates_json TEXT DEFAULT NULL,
    reason TEXT NOT NULL,
    status ENUM('pending','approved','rejected') DEFAULT 'pending',
    approver_id INT DEFAULT NULL,
    approver_note TEXT DEFAULT NULL,
    decided_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user (user_id),
    INDEX idx_status (status),
    INDEX idx_approver (approver_id),
    INDEX idx_from (from_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await sa(`ALTER TABLE leave_requests ADD COLUMN dates_json TEXT DEFAULT NULL AFTER to_date`);

  // ── Column additions (safe ALTERs from previous versions) ─────
  await sa(`ALTER TABLE fms_sheets ADD COLUMN fms_name VARCHAR(255) DEFAULT '' AFTER id`);
  await sa(`ALTER TABLE fms_steps ADD COLUMN show_cols TEXT AFTER extra_col`);
  await sa(`ALTER TABLE fms_steps ADD COLUMN delay_reason_col VARCHAR(10) DEFAULT '' AFTER show_cols`);
  await sa(`ALTER TABLE fms_steps ADD COLUMN doer_name_col VARCHAR(10) DEFAULT '' AFTER delay_reason_col`);
  await sa(`ALTER TABLE users ADD COLUMN department VARCHAR(255) DEFAULT '' AFTER phone`);
  await sa(`ALTER TABLE users ADD COLUMN week_off VARCHAR(50) DEFAULT '' AFTER department`);
  // No DEFAULT: MySQL rejects a default on TEXT/BLOB (error 1101), which made
  // this ALTER fail silently and left every query selecting extra_off broken.
  await sa(`ALTER TABLE users ADD COLUMN extra_off TEXT AFTER week_off`);
  await sa(`ALTER TABLE users ADD COLUMN notification_email VARCHAR(255) DEFAULT '' AFTER email`);
  await sa(`ALTER TABLE users ADD COLUMN exclude_from_reminder TINYINT(1) DEFAULT 0 AFTER extra_off`);
  // user_role — separate from app `role`. Decides leave-approval hierarchy
  // (e.g. an IT person may have app role 'admin' but user role 'user',
  // so their leave still goes to their HOD).
  await sa(`ALTER TABLE users ADD COLUMN user_role ENUM('admin','hod','pc','user') DEFAULT NULL AFTER role`);
  await sa(`UPDATE users SET user_role=role WHERE user_role IS NULL`);
  // Optional client tagging on tasks (uses clients table created later in this file)
  await sa(`ALTER TABLE delegation_tasks ADD COLUMN client_id INT DEFAULT NULL AFTER remarks`);
  await sa(`ALTER TABLE delegation_tasks ADD INDEX idx_client (client_id)`);
  await sa(`ALTER TABLE delegation_tasks ADD COLUMN url VARCHAR(2048) DEFAULT NULL AFTER client_id`);
  await sa(`ALTER TABLE checklist_tasks ADD COLUMN client_id INT DEFAULT NULL AFTER remarks`);
  await sa(`ALTER TABLE checklist_tasks ADD INDEX idx_client (client_id)`);
  // Why a revision was requested. It used to be dropped whenever the task did
  // not need approval — the person typed a reason and it went nowhere.
  // No DEFAULT: MySQL rejects one on TEXT.
  await sa(`ALTER TABLE delegation_tasks ADD COLUMN revise_reason TEXT AFTER remarks`);
  await sa(`ALTER TABLE checklist_tasks ADD COLUMN revise_reason TEXT AFTER remarks`);

  // ── Meetings ──────────────────────────────────────────
  // Feeds the Meetings page and the meetings section of Employee 360.
  await sa(`CREATE TABLE IF NOT EXISTS meetings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    agenda TEXT DEFAULT NULL,
    client_id INT DEFAULT NULL,
    organizer_id INT NOT NULL,
    meeting_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    meet_link VARCHAR(2048) DEFAULT NULL,
    status ENUM('scheduled','cancelled','done') DEFAULT 'scheduled',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_date (meeting_date),
    INDEX idx_organizer (organizer_id),
    INDEX idx_client (client_id),
    INDEX idx_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // One row per invitee. The UNIQUE key makes re-saving an attendee list idempotent.
  await sa(`CREATE TABLE IF NOT EXISTS meeting_attendees (
    id INT AUTO_INCREMENT PRIMARY KEY,
    meeting_id INT NOT NULL,
    user_id INT NOT NULL,
    UNIQUE KEY uq_meeting_user (meeting_id, user_id),
    INDEX idx_meeting (meeting_id),
    INDEX idx_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Units carry an active flag and a logo — both read by the Employee 360
  // scorecard, where the unit score is active/total.
  // Who owns this unit. Employee 360 lists the units an employee handles and
  // scores them on how many are still active.
  await sa(`ALTER TABLE clients ADD COLUMN handler_id INT DEFAULT NULL AFTER name`);
  await sa(`ALTER TABLE clients ADD INDEX idx_handler (handler_id)`);
  await sa(`ALTER TABLE clients ADD COLUMN logo_url LONGTEXT DEFAULT NULL AFTER handler_id`);
  await sa(`ALTER TABLE clients ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER logo_url`);

  // The weekly check-in: what the employee committed to for that Monday.
  await sa(`ALTER TABLE week_plans ADD COLUMN user_committed_score DECIMAL(5,1) DEFAULT NULL AFTER improvement_pct`);
  await sa(`ALTER TABLE week_plans ADD COLUMN user_committed_at TIMESTAMP NULL DEFAULT NULL AFTER user_committed_score`);
  // Checklist series metadata — end_date = is checklist ki last date (kab tak chalegi),
  // frequency = daily/weekly/monthly... Both are stored identically on every row of a series
  // so the "which checklist to delete" list can be built.
  await sa(`ALTER TABLE checklist_tasks ADD COLUMN end_date DATE DEFAULT NULL AFTER due_date`);
  await sa(`ALTER TABLE checklist_tasks ADD COLUMN frequency VARCHAR(20) DEFAULT NULL AFTER end_date`);
  await sa(`ALTER TABLE checklist_tasks ADD INDEX idx_end_date (end_date)`);
  // Approver: the specific user chosen to approve a delegation task's completion / revision.
  // Kept separate from assigned_by (the delegator) so the doer can never be the approver.
  await sa(`ALTER TABLE delegation_tasks ADD COLUMN approver_id INT DEFAULT NULL AFTER waiting_approval`);
  await sa(`ALTER TABLE delegation_tasks ADD INDEX idx_approver (approver_id)`);
  // Backfill: older rows stored the approver inside assigned_by — recover it where approval was required.
  await sa(`UPDATE delegation_tasks SET approver_id=assigned_by WHERE approval='yes' AND approver_id IS NULL`);
  // Pending revised date — held on the approval request until it is approved.
  await sa(`ALTER TABLE task_approvals ADD COLUMN new_date DATE DEFAULT NULL AFTER note`);
  await sa(`ALTER TABLE fms_extra_rows ADD COLUMN col_letter VARCHAR(10) DEFAULT '' AFTER row_label`);
  await sa(`ALTER TABLE fms_extra_rows ADD COLUMN field_type VARCHAR(20) DEFAULT 'text' AFTER col_letter`);
  await sa(`ALTER TABLE fms_extra_rows ADD COLUMN dropdown_options TEXT AFTER field_type`);
  // Required flag — default 1 so existing rows continue to be mandatory (backward compat)
  await sa(`ALTER TABLE fms_extra_rows ADD COLUMN required TINYINT(1) DEFAULT 1 AFTER dropdown_options`);

  console.log('  ✅ DB migrations checked');

  // ── Auto-seed default admin if no users exist ─────────
  try {
    const [[{ cnt }]] = await db.query('SELECT COUNT(*) AS cnt FROM users');
    if (cnt === 0) {
      const hash = bcrypt.hashSync('password', 10);
      await db.query(
        'INSERT INTO users (name, email, password, role, department) VALUES (?,?,?,?,?)',
        ['Aman Admin', 'aman@test.com', hash, 'admin', 'Management']
      );
      console.log('  🌱 Default admin seeded → aman@test.com / password');
    }
  } catch (e) {
    console.error('  ⚠️ Admin seed skipped:', e.message);
  }
})();

// ══════════════════════════════════════════════════════
// EMAIL (automation removed — sendMail is a no-op stub)
// ══════════════════════════════════════════════════════
// Email automation has been removed. This is a no-op stub kept so that any
// remaining caller (delegation / leave notifications) does not break.
async function sendMail() { return; }

// ══════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════
function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers['authorization']?.replace('Bearer ','');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.session = { userId: decoded.userId, role: decoded.role, name: decoded.name };
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
}
function requireAdmin(req, res, next) {
  if (req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}
function requireAdminOrHod(req, res, next) {
  if (req.session.role === 'admin' || req.session.role === 'hod' || req.session.role === 'pc') return next();
  res.status(403).json({ error: 'Admin or HOD only' });
}
function requireAdminOrHodOnly(req, res, next) {
  if (req.session.role === 'admin' || req.session.role === 'hod') return next();
  res.status(403).json({ error: 'Admin or HOD (App Role) only' });
}
function requireAdminOrPC(req, res, next) {
  if (req.session.role === 'admin' || req.session.role === 'pc') return next();
  res.status(403).json({ error: 'Admin or PC only' });
}

// ══════════════════════════════════════════════════════
// IMS (Inventory Management System) — admin only.
// Reads the same Google Sheets your Apps Script writes, via a service account.
// Frontend: serves your unmodified Apps Script index.html at /ims with a small
// shim so its existing google.script.run.* calls hit /api/ims/* below.
// ══════════════════════════════════════════════════════
// Data endpoint: dispatches to a ported read function. Returns the SAME shape
// your Apps Script returned (so the frontend works unchanged). On error it
// returns { __imsError } which the shim routes to the page's failure handler.
app.post('/api/ims/:fn', requireAuth, requireAdmin, async (req, res) => {
  try {
    const fn = ims.HANDLERS[req.params.fn];
    if (typeof fn !== 'function') return res.json({ __imsError: 'Unknown IMS function: ' + req.params.fn });
    const args = Array.isArray(req.body) ? req.body : [];
    const out = await fn(...args);
    res.json(out);
  } catch (e) {
    console.error('  ❌ /api/ims/' + req.params.fn + ':', e.message);
    res.json({ __imsError: e.message });
  }
});

// Serves your Apps Script index.html (placed at ims-app/index.html) with a
// google.script.run shim injected, so nothing inside that file needs editing.
const _imsShim = `<script>(function(){function runner(ok,fail){return new Proxy({},{get:function(_,prop){if(prop==='withSuccessHandler')return function(fn){return runner(fn,fail);};if(prop==='withFailureHandler')return function(fn){return runner(ok,fn);};if(prop==='withUserObject')return function(){return runner(ok,fail);};return function(){var args=Array.prototype.slice.call(arguments);fetch('/api/ims/'+prop,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify(args)}).then(function(r){return r.json();}).then(function(d){if(d&&d.__imsError){if(fail)fail({message:d.__imsError});}else{if(ok)ok(d);}}).catch(function(err){if(fail)fail({message:(err&&err.message)||'Network error'});});};}});}window.google=window.google||{};window.google.script=window.google.script||{};window.google.script.run=runner(null,null);window.google.script.host=window.google.script.host||{close:function(){},setHeight:function(){},setWidth:function(){},origin:''};})();</script>`;

app.get('/ims', requireAuth, requireAdmin, (req, res) => {
  const fs = require('fs');
  const file = path.join(__dirname, 'ims-app', 'index.html');
  let html;
  try {
    html = fs.readFileSync(file, 'utf8');
  } catch (e) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send('<div style="font-family:system-ui,sans-serif;padding:48px;max-width:640px;margin:0 auto;color:#0f172a;">'
      + '<h2>📦 IMS — almost ready</h2>'
      + '<p style="color:#475569;line-height:1.6">Place your Apps Script <b>index.html</b> at '
      + '<code style="background:#f1f5f9;padding:1px 6px;border-radius:5px">ims-app/index.html</code> in the project, '
      + 'set the <code style="background:#f1f5f9;padding:1px 6px;border-radius:5px">GOOGLE_SERVICE_ACCOUNT_JSON</code> env var, '
      + 'share the sheets with the service account email, then redeploy.</p></div>');
  }
  html = html.includes('</head>') ? html.replace('</head>', _imsShim + '</head>') : (_imsShim + html);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});
function getTable(type) {
  return type === 'delegation' ? 'delegation_tasks' : 'checklist_tasks';
}

// ── Checklist series helpers ──
// normDate: accepts only 'YYYY-MM-DD', else NULL (so an empty string does not become 0000-00-00 in the DB)
function normDate(v) {
  if (!v) return null;
  const s = String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
const VALID_FREQS = ['daily','weekly','alternative_week','monthly','quarterly','yearly'];
function normFreq(v) {
  const s = String(v || '').trim().toLowerCase();
  return VALID_FREQS.includes(s) ? s : null;
}

// ══════════════════════════════════════════════════════
// GOOGLE SHEETS HELPERS
// ══════════════════════════════════════════════════════
let _sheetsReadClient = null;
let _sheetsWriteClient = null;

async function getSheetsClient(scopes) {
  const { google } = require('googleapis');
  let creds;
  if (process.env.GOOGLE_CREDENTIALS) {
    creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } else {
    // Local-dev fallback — credentials.json file (gitignored, never committed)
    try {
      creds = require('./credentials.json');
    } catch (e) {
      throw new Error('Google credentials missing — set GOOGLE_CREDENTIALS env var (or place credentials.json locally for dev)');
    }
  }
  const isWrite = scopes.some(s => !s.includes('readonly'));
  if (isWrite) {
    if (_sheetsWriteClient) return _sheetsWriteClient;
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    _sheetsWriteClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
    return _sheetsWriteClient;
  } else {
    if (_sheetsReadClient) return _sheetsReadClient;
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    _sheetsReadClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
    return _sheetsReadClient;
  }
}

// Google Drive client — used to store PO documents that Finance uploads (Tally
// exports / own-software POs). Same service account as Sheets; needs the
// Google Drive API enabled on the same GCP project, and 'drive' scope.
let _driveClient = null;
async function getDriveClient() {
  const { google } = require('googleapis');
  let creds;
  if (process.env.GOOGLE_CREDENTIALS) {
    creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } else {
    try {
      creds = require('./credentials.json');
    } catch (e) {
      throw new Error('Google credentials missing — set GOOGLE_CREDENTIALS env var (or place credentials.json locally for dev)');
    }
  }
  if (_driveClient) return _driveClient;
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/drive'] });
  _driveClient = google.drive({ version: 'v3', auth: await auth.getClient() });
  return _driveClient;
}

// Uploads a buffer to Drive, makes it link-viewable, returns a shareable/downloadable link.
// PO_DRIVE_FOLDER_ID (optional) — if set, file goes into that folder (must be shared with the
// service account email as Editor); otherwise it lands in the service account's own Drive.
const PO_DRIVE_FOLDER_ID = process.env.PO_DRIVE_FOLDER_ID || '';
async function uploadPODocToDrive(buffer, originalName, mimeType) {
  const drive = await getDriveClient();
  const fileMeta = { name: `PO_${Date.now()}_${originalName}` };
  if (PO_DRIVE_FOLDER_ID) fileMeta.parents = [PO_DRIVE_FOLDER_ID];
  // supportsAllDrives is required whenever the parent is (or lives inside) a Shared Drive —
  // without it Drive API calls silently only look at "My Drive" and fail with 404/quota errors.
  const created = await drive.files.create({
    requestBody: fileMeta,
    media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from(buffer) },
    fields: 'id, webViewLink, webContentLink',
    supportsAllDrives: true
  });
  const fileId = created.data.id;
  // "Anyone with the link" viewer access — so Production/Finance/Admin can open/download
  // without needing their own Google account shared on the file.
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true
  });
  const meta = await drive.files.get({ fileId, fields: 'id, webViewLink, webContentLink', supportsAllDrives: true });
  return meta.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
}

// Pre-warm Google auth on startup (reduces cold start time)
(async () => {
  try {
    await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    console.log('  ✅ Google Auth pre-warmed');
  } catch(e) { console.log('  ⚠️ Google Auth pre-warm failed:', e.message); }
})();

function extractSpreadsheetId(raw) {
  const s = (raw || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : s;
}

function colToIdx(col) {
  if (!col) return -1;
  col = col.toUpperCase().trim();
  let idx = 0;
  for (let i = 0; i < col.length; i++) idx = idx * 26 + (col.charCodeAt(i) - 64);
  return idx - 1;
}

function idxToCol(idx) {
  let s = '', n = idx + 1;
  while (n > 0) { const r = (n-1) % 26; s = String.fromCharCode(65+r) + s; n = Math.floor((n-1)/26); }
  return s;
}

// Parse a date value coming from a Google Sheet cell — handles
// YYYY-MM-DD, and DD/MM/YYYY OR MM/DD/YYYY.
// format: 'DMY' (default) or 'MDY' — when both numbers are <=12 (ambiguous, e.g. "5/8/2026")
// this decides which position is the day and which is the month.
// If either number is >12 it is always detected unambiguously from the VALUE itself, and format is ignored.
// endOfDayIfNoTime: when no time is present use 23:59:59 (for plan dates — the whole day counts as valid)
function parseSheetDate(val, endOfDayIfNoTime, format) {
  const s = (val || '').trim();
  if (!s) return null;
  const slashy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:[ T](\d{1,2}:\d{2}(:\d{2})?))?/);
  const yyyymmdd = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}:\d{2}(:\d{2})?))?/);
  let d = null;
  if (slashy) {
    let [, a, b, yyyy, time] = slashy;
    const p1 = +a, p2 = +b;
    let dd, mm;
    if (p1 > 12 && p2 <= 12) { dd = p1; mm = p2; }        // unambiguous DD/MM
    else if (p2 > 12 && p1 <= 12) { dd = p2; mm = p1; }   // unambiguous MM/DD
    else if (format === 'MDY') { dd = p2; mm = p1; }      // ambiguous — column format se decide
    else { dd = p1; mm = p2; }                             // ambiguous — default DD/MM
    let t;
    if (time) {
      const tParts = time.split(':');
      t = tParts.map((p,i)=> i===0 ? p.padStart(2,'0') : p).join(':');
      if (t.length === 5) t += ':00';
    } else {
      t = endOfDayIfNoTime ? '23:59:59' : '00:00:00';
    }
    d = new Date(`${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T${t}`);
  } else if (yyyymmdd) {
    const [, yyyy, mm, dd, time] = yyyymmdd;
    let t;
    if (time) {
      const tParts = time.split(':');
      t = tParts.map((p,i)=> i===0 ? p.padStart(2,'0') : p).join(':');
      if (t.length === 5) t += ':00';
    } else {
      t = endOfDayIfNoTime ? '23:59:59' : '00:00:00';
    }
    d = new Date(`${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}T${t}`);
  }
  return (d && !isNaN(d.getTime())) ? d : null;
}

// Inspects every plan-date value in a column to decide whether that column
// is DD/MM/YYYY or MM/DD/YYYY — as soon as one value gives unambiguous evidence
// (day part >12), that format is applied to the column's ambiguous values too.
function detectColumnDateFormat(values) {
  for (const v of (values || [])) {
    const s = (v || '').trim();
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (!m) continue;
    const p1 = +m[1], p2 = +m[2];
    if (p1 > 12 && p2 <= 12) return 'DMY';
    if (p2 > 12 && p1 <= 12) return 'MDY';
  }
  return 'DMY'; // no unambiguous evidence — default to Indian format
}

// Sheet cell → 'YYYY-MM-DD' string or null (for date-range filtering, like MySQL BETWEEN)
function sheetDateToYMD(val, format) {
  const d = parseSheetDate(val, false, format);
  if (!d) return null;
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

// isRowDelayed: the same rule the "mark done" modal uses (actual > plan = delayed),
// and a row still pending is also counted as delayed once CURDATE > plan date.
// planFormat: plan_col ke column-wide detected format (DMY/MDY) — actualVal hamesha
// our own code always writes DD/MM/YYYY, so its format is fixed to DMY.
function isRowDelayed(planVal, actualVal, planFormat) {
  const planDate = parseSheetDate(planVal, true, planFormat); // plan date stays valid for the whole day
  if (!planDate) return false;
  if (actualVal) {
    const actualDate = parseSheetDate(actualVal, false, 'DMY');
    if (!actualDate) return false;
    return actualDate > planDate;
  }
  return new Date() > planDate; // still pending and the plan date has passed
}

// ══════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// 🛠️ SETUP ENDPOINT — Forces migrations + admin seed on demand
// Visit: /api/setup in browser to manually trigger
// Useful when auto-migrations on startup fail silently
// ══════════════════════════════════════════════════════
app.get('/api/setup', async (req, res) => {
  const log = [];
  const sa = async (sql, label) => {
    try { await db.query(sql); log.push(`✅ ${label}`); }
    catch(e) { log.push(`⚠️ ${label} — ${e.code || e.message}`); }
  };

  try {
    // Test connection first
    await db.query('SELECT 1');
    log.push('✅ DB connection OK');

    // ── Create base tables ────────────────────────────
    await sa(`CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE, notification_email VARCHAR(255) DEFAULT '',
      password VARCHAR(255) NOT NULL, role ENUM('admin','hod','pc','user') DEFAULT 'user',
      user_role ENUM('admin','hod','pc','user') DEFAULT NULL,
      phone VARCHAR(50) DEFAULT NULL, department VARCHAR(255) DEFAULT '',
      week_off VARCHAR(50) DEFAULT '', extra_off TEXT,
      exclude_from_reminder TINYINT(1) DEFAULT 0,
      profile_image LONGTEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'users table');
    await sa(`ALTER TABLE users ADD COLUMN user_role ENUM('admin','hod','pc','user') DEFAULT NULL AFTER role`, 'users.user_role');
    await sa(`UPDATE users SET user_role=role WHERE user_role IS NULL`, 'backfill user_role from role');
    await sa(`ALTER TABLE delegation_tasks ADD COLUMN client_id INT DEFAULT NULL AFTER remarks`, 'delegation_tasks.client_id');
    await sa(`ALTER TABLE delegation_tasks ADD COLUMN url VARCHAR(2048) DEFAULT NULL AFTER client_id`, 'delegation_tasks.url');
    await sa(`ALTER TABLE delegation_tasks ADD COLUMN approver_id INT DEFAULT NULL AFTER waiting_approval`, 'delegation_tasks.approver_id');
    await sa(`ALTER TABLE delegation_tasks ADD INDEX idx_approver (approver_id)`, 'delegation_tasks.idx_approver');
    await sa(`UPDATE delegation_tasks SET approver_id=assigned_by WHERE approval='yes' AND approver_id IS NULL`, 'backfill approver_id');
    await sa(`ALTER TABLE task_approvals ADD COLUMN new_date DATE DEFAULT NULL AFTER note`, 'task_approvals.new_date');
    await sa(`ALTER TABLE checklist_tasks ADD COLUMN client_id INT DEFAULT NULL AFTER remarks`, 'checklist_tasks.client_id');
    await sa(`ALTER TABLE checklist_tasks ADD COLUMN end_date DATE DEFAULT NULL AFTER due_date`, 'checklist_tasks.end_date');
    await sa(`ALTER TABLE checklist_tasks ADD COLUMN frequency VARCHAR(20) DEFAULT NULL AFTER end_date`, 'checklist_tasks.frequency');
    await sa(`ALTER TABLE checklist_tasks ADD INDEX idx_end_date (end_date)`, 'checklist_tasks.idx_end_date');

    await sa(`CREATE TABLE IF NOT EXISTS delegation_tasks (
      id INT AUTO_INCREMENT PRIMARY KEY, description TEXT NOT NULL,
      assigned_to INT NOT NULL, assigned_by INT NOT NULL, due_date DATE,
      status ENUM('pending','completed','revised') DEFAULT 'pending',
      priority ENUM('low','medium','high') DEFAULT 'low',
      approval ENUM('yes','no') DEFAULT 'no', waiting_approval TINYINT(1) DEFAULT 0,
      approver_id INT DEFAULT NULL,
      remarks TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_assigned_to (assigned_to), INDEX idx_status (status), INDEX idx_due_date (due_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'delegation_tasks table');

    await sa(`CREATE TABLE IF NOT EXISTS checklist_tasks (
      id INT AUTO_INCREMENT PRIMARY KEY, description TEXT NOT NULL,
      assigned_to INT NOT NULL, assigned_by INT NOT NULL, due_date DATE,
      end_date DATE DEFAULT NULL, frequency VARCHAR(20) DEFAULT NULL,
      status ENUM('pending','completed') DEFAULT 'pending',
      priority ENUM('low','medium','high') DEFAULT 'low', remarks TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_assigned_to (assigned_to), INDEX idx_status (status), INDEX idx_due_date (due_date),
      INDEX idx_end_date (end_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'checklist_tasks table');

    await sa(`CREATE TABLE IF NOT EXISTS task_approvals (
      id INT AUTO_INCREMENT PRIMARY KEY, task_id INT NOT NULL, task_type VARCHAR(20) NOT NULL,
      requested_by INT NOT NULL, requested_to INT NOT NULL, action_type VARCHAR(50),
      status ENUM('pending','approved','rejected') DEFAULT 'pending', note TEXT, new_date DATE DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_task (task_id, task_type), INDEX idx_requested_to (requested_to)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'task_approvals table');

    await sa(`CREATE TABLE IF NOT EXISTS task_comments (
      id INT AUTO_INCREMENT PRIMARY KEY, task_id INT NOT NULL, task_type VARCHAR(20) NOT NULL,
      user_id INT NOT NULL, comment TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_task (task_id, task_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'task_comments table');

    await sa(`CREATE TABLE IF NOT EXISTS whatsapp_reminder_log (
      id INT AUTO_INCREMENT PRIMARY KEY, log_date DATE NOT NULL, kind VARCHAR(40) NOT NULL,
      status VARCHAR(20) DEFAULT 'running', sent INT DEFAULT 0, failed INT DEFAULT 0,
      note VARCHAR(500) DEFAULT NULL,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMP NULL DEFAULT NULL,
      UNIQUE KEY uniq_day_kind (log_date, kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'whatsapp_reminder_log table');

    await sa(`CREATE TABLE IF NOT EXISTS task_transfers (
      id INT AUTO_INCREMENT PRIMARY KEY, task_id INT NOT NULL, task_type VARCHAR(20) NOT NULL,
      from_user INT NOT NULL, to_user INT NOT NULL, requested_by INT NOT NULL,
      status ENUM('pending','approved','rejected') DEFAULT 'pending', note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'task_transfers table');

    await sa(`CREATE TABLE IF NOT EXISTS fms_sheets (
      id INT AUTO_INCREMENT PRIMARY KEY, fms_name VARCHAR(255) DEFAULT '',
      sheet_name VARCHAR(255) NOT NULL, sheet_id VARCHAR(255) NOT NULL,
      header_row INT DEFAULT 1, total_steps INT DEFAULT 0, created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'fms_sheets table');

    await sa(`CREATE TABLE IF NOT EXISTS fms_steps (
      id INT AUTO_INCREMENT PRIMARY KEY, fms_id INT NOT NULL, step_order INT NOT NULL,
      step_name VARCHAR(255) NOT NULL, plan_col VARCHAR(10) DEFAULT '',
      actual_col VARCHAR(10) DEFAULT '', extra_input VARCHAR(10) DEFAULT 'no',
      extra_col VARCHAR(10) DEFAULT '', show_cols TEXT,
      delay_reason_col VARCHAR(10) DEFAULT '', doer_name_col VARCHAR(10) DEFAULT '',
      INDEX idx_fms (fms_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'fms_steps table');

    await sa(`CREATE TABLE IF NOT EXISTS fms_step_doers (
      id INT AUTO_INCREMENT PRIMARY KEY, step_id INT NOT NULL, user_id INT NOT NULL,
      INDEX idx_step (step_id), INDEX idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'fms_step_doers table');

    await sa(`CREATE TABLE IF NOT EXISTS fms_extra_rows (
      id INT AUTO_INCREMENT PRIMARY KEY, step_id INT NOT NULL,
      row_label VARCHAR(255) DEFAULT '', col_letter VARCHAR(10) DEFAULT '',
      field_type VARCHAR(20) DEFAULT 'text', dropdown_options TEXT,
      required TINYINT(1) DEFAULT 1,
      INDEX idx_step (step_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'fms_extra_rows table');
    await sa(`ALTER TABLE fms_extra_rows ADD COLUMN required TINYINT(1) DEFAULT 1 AFTER dropdown_options`, 'fms_extra_rows.required');

    await sa(`CREATE TABLE IF NOT EXISTS week_plans (
      id INT AUTO_INCREMENT PRIMARY KEY, employee_id INT NOT NULL, hod_id INT,
      start_date DATE NOT NULL, target_count INT DEFAULT 0,
      improvement_pct DECIMAL(5,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_employee (employee_id), INDEX idx_start (start_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'week_plans table');

    await sa(`CREATE TABLE IF NOT EXISTS holidays (
      id INT AUTO_INCREMENT PRIMARY KEY, holiday_date DATE NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL, created_by INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_date (holiday_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'holidays table');

    await sa(`CREATE TABLE IF NOT EXISTS leave_requests (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL,
      leave_type ENUM('full_day','half_day','work_from_home','extra_working') NOT NULL,
      from_date DATE NOT NULL, to_date DATE NOT NULL, dates_json TEXT DEFAULT NULL,
      reason TEXT NOT NULL,
      status ENUM('pending','approved','rejected') DEFAULT 'pending',
      approver_id INT DEFAULT NULL, approver_note TEXT DEFAULT NULL,
      decided_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id), INDEX idx_status (status),
      INDEX idx_approver (approver_id), INDEX idx_from (from_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, 'leave_requests table');
    await sa(`ALTER TABLE leave_requests ADD COLUMN dates_json TEXT DEFAULT NULL AFTER to_date`, 'leave_requests.dates_json');

    // ── Seed admin user ────────────────────────────────
    try {
      const [[{ cnt }]] = await db.query('SELECT COUNT(*) AS cnt FROM users WHERE email=?', ['aman@test.com']);
      if (cnt === 0) {
        const hash = bcrypt.hashSync('password', 10);
        await db.query(
          'INSERT INTO users (name, email, password, role, department) VALUES (?,?,?,?,?)',
          ['Aman Admin', 'aman@test.com', hash, 'admin', 'Management']
        );
        log.push('🌱 Admin user seeded: aman@test.com / password');
      } else {
        log.push('ℹ️ Admin user already exists');
      }
    } catch(e) {
      log.push(`❌ Admin seed failed: ${e.message}`);
    }

    res.send(`
      <html><head><title>Setup Complete</title>
      <style>body{font-family:monospace;background:#1a1a1a;color:#0f0;padding:30px;line-height:1.6;}
      h2{color:#F39C12;}a{color:#F39C12;}</style></head>
      <body>
      <h2>🎯 Bunai Task Manager — Setup</h2>
      <pre>${log.join('\n')}</pre>
      <hr>
      <p>✅ Setup done! Now <a href="/">click here to login</a></p>
      <p style="color:#aaa;font-size:12px;">Login: aman@test.com / password</p>
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

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Invalid email or password' });

    // Issue JWT token
    const token = jwt.sign(
      { userId: user.id, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
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

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id,name,email,notification_email,role,
              COALESCE(user_role, role) AS user_role,
              phone,profile_image,department,week_off
       FROM users WHERE id=?`, [req.session.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    // extra_off fetch separately — safe if column not yet added
    try {
      const [ex] = await db.query('SELECT extra_off FROM users WHERE id=?', [req.session.userId]);
      rows[0].extra_off = ex[0]?.extra_off || '';
    } catch(e) { rows[0].extra_off = ''; }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    const isAdmin = role === 'admin' || role === 'pc';
    const isHod = role === 'hod';
    const isPC = role === 'pc';
    const filterEmployee = req.query.employee;
    const hodDept = req.query.hodDept || '';
    // PC date range filter — default to today if not provided
    const dateFrom = req.query.dateFrom || '';
    const dateTo   = req.query.dateTo   || '';

    let userFilter, params;

    if (isAdmin && filterEmployee && filterEmployee !== 'all') {
      userFilter = 'AND t.assigned_to = ?'; params = [filterEmployee];
    } else if (isAdmin) {
      userFilter = ''; params = [];
    } else if (isHod) {
      if (filterEmployee && filterEmployee !== 'all') {
        userFilter = 'AND t.assigned_to = ?'; params = [filterEmployee];
      } else {
        // Fetch the HOD's department from the DB — do not trust the query param
        let resolvedDept = hodDept;
        if (!resolvedDept) {
          const [meRow] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
          resolvedDept = meRow[0]?.department || '';
        }
        if (!resolvedDept) {
          // No department set — show only their own tasks
          userFilter = 'AND t.assigned_to = ?'; params = [uid];
        } else {
          const [deptUsers] = await db.query('SELECT id FROM users WHERE department=? AND role NOT IN (?,?)', [resolvedDept, 'admin','hod']);
          if (!deptUsers.length) {
            // No users in the department — show only their own tasks
            userFilter = 'AND t.assigned_to = ?'; params = [uid];
          } else {
            const ids = deptUsers.map(u=>u.id);
            // Include the HOD themselves as well
            if (!ids.includes(uid)) ids.push(uid);
            userFilter = `AND t.assigned_to IN (${ids.map(()=>'?').join(',')})`;
            params = ids;
          }
        }
      }
    } else {
      userFilter = 'AND t.assigned_to = ?'; params = [uid];
    }

    // Stats + Table:
    //   Delegation: today + earlier (overdue / due today)
    //   Checklist : today + earlier (overdue / due today) — only these count as pending
    // PC: if a date range was given, use it (overrides both)
    const usingPCRange = isPC && dateFrom && dateTo;
    const delDateCond = usingPCRange
      ? `t.due_date BETWEEN '${dateFrom}' AND '${dateTo}'`
      : `t.due_date <= CURDATE()`;
    const chlDateCond = usingPCRange
      ? `t.due_date BETWEEN '${dateFrom}' AND '${dateTo}'`
      : `t.due_date <= CURDATE()`;
    const delDateClause = `AND ${delDateCond}`;
    const chlDateClause = `AND ${chlDateCond}`;

    const taskType = req.query.taskType || 'both';
    let pending = 0, revised = 0, completed = 0, total = 0;

    // Total counts EVERY task — completed included, and no "today or earlier"
    // cap, so next week's work is in there too. Note this is deliberately a
    // headline figure, not a row count: clicking Total lists only the work still
    // open, so the number is larger than the table by exactly `completed`.
    // A PC-selected range is still honoured; that range is an explicit choice.
    const totalDateClause = usingPCRange ? `AND ${delDateCond}` : '';
    if (taskType === 'delegation' || taskType === 'both') {
      const [d] = await db.query(`SELECT COUNT(*) AS n FROM delegation_tasks t WHERE 1=1 ${userFilter} ${totalDateClause}`, params);
      total += parseInt(d[0].n) || 0;
    }
    if (taskType === 'checklist' || taskType === 'both') {
      const [d] = await db.query(`SELECT COUNT(*) AS n FROM checklist_tasks t WHERE 1=1 ${userFilter} ${totalDateClause}`, params);
      total += parseInt(d[0].n) || 0;
    }

    // Upcoming = still-open work dated after today. Counted only in the default
    // view; with an explicit PC range "after today" has no meaning.
    let upcomingCount = 0;
    if (!usingPCRange) {
      if (taskType === 'delegation' || taskType === 'both') {
        const [d] = await db.query(`SELECT COUNT(*) AS n FROM delegation_tasks t WHERE t.due_date > CURDATE() AND t.status <> 'completed' ${userFilter}`, params);
        upcomingCount += parseInt(d[0].n) || 0;
      }
      if (taskType === 'checklist' || taskType === 'both') {
        const [d] = await db.query(`SELECT COUNT(*) AS n FROM checklist_tasks t WHERE t.due_date > CURDATE() AND t.status <> 'completed' ${userFilter}`, params);
        upcomingCount += parseInt(d[0].n) || 0;
      }
    }

    if (taskType === 'delegation' || taskType === 'both') {
      // pending/completed stay within the dashboard date window; revised is counted
      // across all dates (or the PC range) since revised tasks carry a future due date.
      const [d] = await db.query(`SELECT SUM(CASE WHEN status='pending' AND ${delDateCond} THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='revised'${usingPCRange?` AND ${delDateCond}`:''} THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN status='completed' AND ${delDateCond} THEN 1 ELSE 0 END) AS completed FROM delegation_tasks t WHERE 1=1 ${userFilter}`, params);
      pending += parseInt(d[0].pending)||0; revised += parseInt(d[0].revised)||0; completed += parseInt(d[0].completed)||0;
    }
    if (taskType === 'checklist' || taskType === 'both') {
      const [d] = await db.query(`SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='revised' THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed FROM checklist_tasks t WHERE 1=1 ${userFilter} ${chlDateClause}`, params);
      pending += parseInt(d[0].pending)||0; revised += parseInt(d[0].revised)||0; completed += parseInt(d[0].completed)||0;
    }

    let delegationPending = [], checklistPending = [];
    if (taskType === 'delegation' || taskType === 'both') {
      const [rows] = await db.query(`SELECT t.id,'delegation' AS type,t.description,t.status,t.assigned_to,COALESCE(t.priority,'low') AS priority,COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,t.approver_id,u3.name AS approverName,t.remarks,t.revise_reason,t.url,t.client_id,c.name AS client_name,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,u1.name AS assignedToName,u2.name AS assignedByName FROM delegation_tasks t JOIN users u1 ON t.assigned_to=u1.id JOIN users u2 ON t.assigned_by=u2.id LEFT JOIN users u3 ON t.approver_id=u3.id LEFT JOIN clients c ON t.client_id=c.id WHERE ((t.status='pending' AND ${delDateCond}) OR (t.status='revised'${usingPCRange?` AND ${delDateCond}`:''})) ${userFilter} ORDER BY t.due_date ASC LIMIT 500`, params);
      delegationPending = rows;
    }
    if (taskType === 'checklist' || taskType === 'both') {
      const [rows] = await db.query(`SELECT t.id,'checklist' AS type,t.description,t.status,t.assigned_to,COALESCE(t.priority,'low') AS priority,'no' AS approval,0 AS waiting_approval,t.remarks,t.revise_reason,t.client_id,c.name AS client_name,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,u1.name AS assignedToName,u2.name AS assignedByName FROM checklist_tasks t JOIN users u1 ON t.assigned_to=u1.id JOIN users u2 ON t.assigned_by=u2.id LEFT JOIN clients c ON t.client_id=c.id WHERE t.status='pending' ${chlDateClause} ${userFilter} ORDER BY t.due_date ASC LIMIT 500`, params);
      checklistPending = rows;
    }
    // Rows behind the "Completed" count card. Same date window as the count so
    // the number and the list agree. Newest first and capped — completed history
    // grows without bound, and this card is a quick look, not the archive (the
    // All Tasks page is the full, paged list).
    const COMPLETED_ROW_LIMIT = 300;
    let delegationCompleted = [], checklistCompleted = [];
    if (taskType === 'delegation' || taskType === 'both') {
      const [rows] = await db.query(`SELECT t.id,'delegation' AS type,t.description,t.status,t.assigned_to,COALESCE(t.priority,'low') AS priority,COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,t.approver_id,u3.name AS approverName,t.remarks,t.revise_reason,t.url,t.client_id,c.name AS client_name,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,u1.name AS assignedToName,u2.name AS assignedByName FROM delegation_tasks t JOIN users u1 ON t.assigned_to=u1.id JOIN users u2 ON t.assigned_by=u2.id LEFT JOIN users u3 ON t.approver_id=u3.id LEFT JOIN clients c ON t.client_id=c.id WHERE t.status='completed' AND ${delDateCond} ${userFilter} ORDER BY t.due_date DESC LIMIT ${COMPLETED_ROW_LIMIT}`, params);
      delegationCompleted = rows;
    }
    if (taskType === 'checklist' || taskType === 'both') {
      const [rows] = await db.query(`SELECT t.id,'checklist' AS type,t.description,t.status,t.assigned_to,COALESCE(t.priority,'low') AS priority,'no' AS approval,0 AS waiting_approval,t.remarks,t.revise_reason,t.client_id,c.name AS client_name,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,u1.name AS assignedToName,u2.name AS assignedByName FROM checklist_tasks t JOIN users u1 ON t.assigned_to=u1.id JOIN users u2 ON t.assigned_by=u2.id LEFT JOIN clients c ON t.client_id=c.id WHERE t.status='completed' ${chlDateClause} ${userFilter} ORDER BY t.due_date DESC LIMIT ${COMPLETED_ROW_LIMIT}`, params);
      checklistCompleted = rows;
    }

    // Future-dated OPEN rows. Every other list stops at today, so without these
    // the Total card would count work the Total view could not display.
    // Upcoming is a date bucket, not a status, so a task revised to a future
    // date belongs here too. Such a row also arrives via the pending query
    // (which takes 'revised' at any date), so the client de-duplicates.
    const UPCOMING_ROW_LIMIT = 300;
    let delegationUpcoming = [], checklistUpcoming = [];
    if (!usingPCRange) {
      if (taskType === 'delegation' || taskType === 'both') {
        const [rows] = await db.query(`SELECT t.id,'delegation' AS type,t.description,t.status,t.assigned_to,COALESCE(t.priority,'low') AS priority,COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,t.approver_id,u3.name AS approverName,t.remarks,t.revise_reason,t.url,t.client_id,c.name AS client_name,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,u1.name AS assignedToName,u2.name AS assignedByName FROM delegation_tasks t JOIN users u1 ON t.assigned_to=u1.id JOIN users u2 ON t.assigned_by=u2.id LEFT JOIN users u3 ON t.approver_id=u3.id LEFT JOIN clients c ON t.client_id=c.id WHERE t.due_date > CURDATE() AND t.status <> 'completed' ${userFilter} ORDER BY t.due_date ASC LIMIT ${UPCOMING_ROW_LIMIT}`, params);
        delegationUpcoming = rows;
      }
      if (taskType === 'checklist' || taskType === 'both') {
        const [rows] = await db.query(`SELECT t.id,'checklist' AS type,t.description,t.status,t.assigned_to,COALESCE(t.priority,'low') AS priority,'no' AS approval,0 AS waiting_approval,t.remarks,t.revise_reason,t.client_id,c.name AS client_name,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,u1.name AS assignedToName,u2.name AS assignedByName FROM checklist_tasks t JOIN users u1 ON t.assigned_to=u1.id JOIN users u2 ON t.assigned_by=u2.id LEFT JOIN clients c ON t.client_id=c.id WHERE t.due_date > CURDATE() AND t.status <> 'completed' ${userFilter} ORDER BY t.due_date ASC LIMIT ${UPCOMING_ROW_LIMIT}`, params);
        checklistUpcoming = rows;
      }
    }

    // Counts first, then the row lists they map to. `upcoming` is the count, so
    // the rows go out as `upcomingTasks` — two keys of the same name would have
    // silently dropped one of them.
    res.json({
      pending, revised, completed, total, upcoming: upcomingCount,
      todayPending: [...delegationPending, ...checklistPending],
      todayCompleted: [...delegationCompleted, ...checklistCompleted],
      upcomingTasks: [...delegationUpcoming, ...checklistUpcoming],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// TASKS
// ══════════════════════════════════════════════════════
app.get('/api/tasks', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    const isAdmin = role === 'admin';
    const isHod = role === 'hod';
    const { type, mine, full } = req.query;
    const isMine = (mine === '1' || mine === 'true');
    const isFull = (full === '1' || full === 'true');
    const table = getTable(type || 'delegation');
    const isDeleg = (type || 'delegation') === 'delegation';
    let where = 'WHERE 1=1';
    const params = [];

    if (isMine) {
      // "Delegate by Me" mode — only tasks that the current user assigned.
      // Role-based scoping is skipped — any role may see the tasks they assigned.
      where += ' AND t.assigned_by = ?';
      params.push(uid);
    } else if (isAdmin || role === 'pc') {
      // Admin/PC — everything is visible
    } else if (isHod) {
      // HOD — tasks of users in their own department
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      const [deptUsers] = await db.query('SELECT id FROM users WHERE department=?', [dept]);
      if (!deptUsers.length) {
        return res.json({ grouped: [] });
      }
      const ids = deptUsers.map(u=>u.id);
      where += ` AND t.assigned_to IN (${ids.map(()=>'?').join(',')})`;
      params.push(...ids);
    } else {
      // Regular user — only their own tasks
      where += ' AND t.assigned_to = ?';
      params.push(uid);
    }

    // All Tasks — in Delegation, show all future tasks (needed for transfer).
    // Checklist — recurring; only today or earlier (overdue / due today) count as
    // pending, so future recurring rows are not shown.
    // Exception: Admin/HOD "All Checklist" view (full=1) — pura history + upcoming +
    // completed rows must all be shown, so the restriction is skipped here.
    if (!isDeleg && !(isFull && (isAdmin || isHod))) {
      where += ' AND t.due_date <= CURDATE()';
    }

    const [tasks] = await db.query(`SELECT t.id,'${type||'delegation'}' AS type,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,${isDeleg?"COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,t.approver_id,u3.name AS approverName,t.remarks,t.revise_reason,t.url,":"'no' AS approval,0 AS waiting_approval,NULL AS approver_id,NULL AS approverName,t.remarks,NULL AS url,"}t.client_id,c.name AS client_name,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,${isDeleg?"NULL AS end_date,NULL AS frequency,":"DATE_FORMAT(t.end_date,'%Y-%m-%d') AS end_date,t.frequency,"}u1.name AS assignedToName,u2.name AS assignedByName FROM ${table} t JOIN users u1 ON t.assigned_to=u1.id JOIN users u2 ON t.assigned_by=u2.id ${isDeleg?"LEFT JOIN users u3 ON t.approver_id=u3.id":""} LEFT JOIN clients c ON t.client_id=c.id ${where} ORDER BY t.due_date ASC`, params);

    // mine=1 always returns a flat task list (never grouped)
    if (isMine) {
      return res.json({ tasks });
    }
    if (isAdmin || isHod || role === 'pc') {
      const grouped = {};
      tasks.forEach(t => {
        if (!grouped[t.assigned_to]) grouped[t.assigned_to] = { userId: t.assigned_to, name: t.assignedToName, tasks: [] };
        grouped[t.assigned_to].tasks.push(t);
      });
      return res.json({ grouped: Object.values(grouped) });
    }
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks', requireAuth, async (req, res) => {
  try {
    const { type, desc, assignedTo, approverEmail, approver, date, priority, approval, remarks, client_id, clientId, url } = req.body;
    // Checklist series ki end date + frequency (optional)
    const endDateVal   = normDate(req.body.endDate != null ? req.body.endDate : req.body.end_date);
    const frequencyVal = normFreq(req.body.frequency);
    // Accept either client_id or clientId from request body
    const clientIdInt = (() => {
      const raw = client_id != null ? client_id : clientId;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const isAdmin = req.session.role === 'admin';
    const isHod   = req.session.role === 'hod';
    const isUser  = req.session.role === 'user';
    // Admin, HOD and regular users can all assign to others; fallback to self if not specified
    const targetUser = (isAdmin || isHod || isUser) && assignedTo ? parseInt(assignedTo) : req.session.userId;
    if (!desc || !date) return res.status(400).json({ error: 'Description and date required' });

    // Holiday / week-off check — auto-adjust due_date if needed
    let effectiveDate = date;
    let adjusted = false, adjustedReason = '';
    try {
      const holidaysSet = await loadHolidaysSet();
      const [[doerUser]] = await db.query('SELECT week_off, extra_off FROM users WHERE id=? LIMIT 1', [targetUser]);
      if (doerUser && isUserOffOn(doerUser, date, holidaysSet)) {
        const tt = (type||'checklist') === 'delegation' ? 'delegation' : 'checklist';
        if (tt === 'delegation') {
          // Push to next working day
          effectiveDate = nextWorkingDay(doerUser, date, holidaysSet);
          adjusted = true;
          adjustedReason = `Original date was a holiday/week-off — moved to ${effectiveDate}`;
        } else {
          // Checklist: skip creation on off day
          return res.json({ success: true, skipped: true, reason: 'Skipped — selected date is a holiday or doer\'s week-off' });
        }
      }
    } catch (e) { console.error('holiday check error:', e.message); }

    if ((type||'checklist') === 'delegation') {
      // assigned_by is always the real delegator/creator.
      // The chosen approver is stored separately in approver_id so the doer
      // can never end up being their own approver.
      const assignedBy = req.session.userId;
      let approverId = null;
      if ((approval || 'no') === 'yes') {
        if (approverEmail) {
          const [aprRows] = await db.query('SELECT id FROM users WHERE email=? LIMIT 1', [approverEmail]);
          if (aprRows.length) approverId = aprRows[0].id;
        } else if (approver) {
          const apId = parseInt(approver);
          if (apId) {
            const [aprRows] = await db.query('SELECT id FROM users WHERE id=? LIMIT 1', [apId]);
            if (aprRows.length) approverId = aprRows[0].id;
          }
        }
        if (!approverId) return res.status(400).json({ error: 'Please select a valid approver for this task.' });
        if (approverId === targetUser) return res.status(400).json({ error: 'The approver cannot be the same person as the doer.' });
      }
      await db.query(`INSERT INTO delegation_tasks (description,assigned_to,assigned_by,due_date,status,priority,approval,waiting_approval,approver_id,remarks,client_id,url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [desc, targetUser, assignedBy, effectiveDate, 'pending', priority||'low', approval||'no', 0, approverId, remarks||'', clientIdInt, url||null]);

      // WhatsApp notify (Kwik Engage) — doer ko "task" template pe message.
      // Fire-and-forget: if this fails it does not affect the task-creation response.
      (async () => {
        try {
          const [[doer]] = await db.query('SELECT name, phone FROM users WHERE id=? LIMIT 1', [targetUser]);
          const [[byUser]] = await db.query('SELECT name FROM users WHERE id=? LIMIT 1', [assignedBy]);
          if (doer && doer.phone) {
            await sendWhatsApp(doer.phone, {
              doerName: doer.name,
              assignedByName: byUser ? byUser.name : '',
              dueDate: formatDueDateForWhatsApp(effectiveDate),
              priority: (priority || 'low').toUpperCase(),
              description: desc
            });
          }
        } catch (e) { console.error('WhatsApp notify error:', e.message); }
      })();
    } else {
      await db.query(`INSERT INTO checklist_tasks (description,assigned_to,assigned_by,due_date,end_date,frequency,status,priority,remarks,client_id) VALUES (?,?,?,?,?,?,?,?,?,?)`, [desc, targetUser, req.session.userId, effectiveDate, endDateVal, frequencyVal, 'pending', priority||'low', remarks||'', clientIdInt]);

      // WhatsApp — notify the doer even when a single checklist task is created
      (async () => {
        try {
          const [[doer]] = await db.query('SELECT name, phone FROM users WHERE id=? LIMIT 1', [targetUser]);
          if (!doer || !doer.phone) return;
          const [[byUser]] = await db.query('SELECT name FROM users WHERE id=? LIMIT 1', [req.session.userId]);
          let clientName = null;
          if (clientIdInt) { const [[cl]] = await db.query('SELECT name FROM clients WHERE id=? LIMIT 1', [clientIdInt]); clientName = cl ? cl.name : null; }
          await queueWhatsApp(doer.phone, buildChecklistCreatedMessage({
            doerName: doer.name,
            assignedByName: byUser ? byUser.name : '',
            description: desc,
            frequency: frequencyVal,
            startDate: effectiveDate,
            endDate: endDateVal,
            totalTasks: 1,
            clientName,
            remarks: remarks || ''
          }), { delayMs: WHATSAPP_DELAY_MS, label: 'checklist-created' });
        } catch (e) { console.error('Checklist WhatsApp notify error:', e.message); }
      })();
    }
    res.json({ success: true, adjusted, effectiveDate, adjustedReason });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/bulk-checklist', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { desc, assignedTo, priority, remarks, dates, client_id, clientId } = req.body;
    if (!desc || !assignedTo || !dates || !dates.length) return res.status(400).json({ error: 'Missing fields' });
    const cidRaw = client_id != null ? client_id : clientId;
    const cid = (() => { const n = parseInt(cidRaw, 10); return Number.isFinite(n) && n > 0 ? n : null; })();

    // Series metadata — if the client sent no end_date, use the last generated date
    const frequencyVal = normFreq(req.body.frequency);
    const endDateVal = normDate(req.body.endDate != null ? req.body.endDate : req.body.end_date)
      || normDate([...dates].sort().pop());

    // Filter out holiday + week-off dates for this user
    let skippedCount = 0;
    try {
      const holidaysSet = await loadHolidaysSet();
      const [[doerUser]] = await db.query('SELECT week_off, extra_off FROM users WHERE id=? LIMIT 1', [parseInt(assignedTo)]);
      if (doerUser) {
        const filtered = dates.filter(d => !isUserOffOn(doerUser, d, holidaysSet));
        skippedCount = dates.length - filtered.length;
        if (!filtered.length) return res.json({ success: true, count: 0, skipped: skippedCount, message: 'All dates were holidays / week-offs — nothing inserted' });
        dates.length = 0;
        dates.push(...filtered);
      }
    } catch (e) { console.error('bulk-checklist holiday filter err:', e.message); }

    const values = dates.map(date => [desc, parseInt(assignedTo), req.session.userId, date, endDateVal, frequencyVal, 'pending', priority||'low', remarks||'', cid]);
    await db.query(`INSERT INTO checklist_tasks (description,assigned_to,assigned_by,due_date,end_date,frequency,status,priority,remarks,client_id) VALUES ?`, [values]);

    // WhatsApp — checklist banate hi doer ko EK summary message (poori series ka).
    // Fire-and-forget: a failure here does not affect the task-creation response.
    (async () => {
      try {
        const [[doer]] = await db.query('SELECT name, phone FROM users WHERE id=? LIMIT 1', [parseInt(assignedTo)]);
        if (!doer || !doer.phone) return;
        const [[byUser]] = await db.query('SELECT name FROM users WHERE id=? LIMIT 1', [req.session.userId]);
        let clientName = null;
        if (cid) { const [[cl]] = await db.query('SELECT name FROM clients WHERE id=? LIMIT 1', [cid]); clientName = cl ? cl.name : null; }
        const sortedDates = [...dates].sort();
        await queueWhatsApp(doer.phone, buildChecklistCreatedMessage({
          doerName: doer.name,
          assignedByName: byUser ? byUser.name : '',
          description: desc,
          frequency: frequencyVal,
          startDate: sortedDates[0],
          endDate: endDateVal,
          totalTasks: dates.length,
          clientName,
          remarks: remarks || ''
        }), { delayMs: WHATSAPP_DELAY_MS, label: 'checklist-created' });
      } catch (e) { console.error('Checklist WhatsApp notify error:', e.message); }
    })();

    res.json({ success: true, count: dates.length, skipped: skippedCount, endDate: endDateVal, frequency: frequencyVal });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/:id/status', requireAuth, async (req, res) => {
  try {
    const { status, type, newDate, reason } = req.body;
    const tType = type || 'delegation';
    const table = getTable(tType);
    const isAdmin = req.session.role === 'admin';
    const isPC = req.session.role === 'pc';
    const uid = req.session.userId;
    const [rows] = await db.query(`SELECT * FROM ${table} WHERE id=?`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
    const task = rows[0];
    const isDoer = task.assigned_to === uid;
    if (!isAdmin && !isPC && !isDoer) return res.status(403).json({ error: 'Not allowed' });

    const needsApproval = tType === 'delegation' && task.approval === 'yes';
    // Admin/PC may act directly ONLY when they are not the task's own doer.
    // The doer can NEVER self-complete or self-approve an approval-required task.
    const canOverride = (isAdmin || isPC) && !isDoer;

    if (needsApproval && !canOverride) {
      // Route through the chosen approver — nothing is finalised here.
      const approverId = task.approver_id || task.assigned_by;
      if (!approverId || approverId === task.assigned_to) {
        return res.status(400).json({ error: 'No valid approver is set for this task. Please ask an admin to set an approver.' });
      }
      const [existing] = await db.query(`SELECT id FROM task_approvals WHERE task_id=? AND task_type=? AND status='pending'`, [req.params.id, tType]);
      if (existing[0]) return res.status(400).json({ error: 'An approval request is already pending for this task.' });
      const pendingNewDate = (status === 'revised' && newDate) ? newDate : null;
      await db.query(`INSERT INTO task_approvals (task_id,task_type,requested_by,requested_to,action_type,status,note,new_date) VALUES (?,?,?,?,?,'pending',?,?)`, [req.params.id, tType, uid, approverId, status, reason||'', pendingNewDate]);
      // Keep the ORIGINAL status and due date until the approver decides.
      await db.query(`UPDATE ${table} SET waiting_approval=1 WHERE id=?`, [req.params.id]);
      return res.json({ success: true, needsApproval: true });
    }

    // No approval needed, or an admin/PC override → apply immediately.
    if (status === 'revised' && newDate) {
      if (tType === 'checklist') await db.query(`UPDATE ${table} SET status=?,due_date=? WHERE id=?`, [status, newDate, req.params.id]);
      else await db.query(`UPDATE ${table} SET status=?,waiting_approval=0,due_date=? WHERE id=?`, [status, newDate, req.params.id]);
    } else {
      if (tType === 'checklist') await db.query(`UPDATE ${table} SET status=? WHERE id=?`, [status, req.params.id]);
      else await db.query(`UPDATE ${table} SET status=?,waiting_approval=0 WHERE id=?`, [status, req.params.id]);
    }
    // Keep the revision reason on the task itself. Previously it was only ever
    // written to task_approvals, so a revision that needed no approval lost it.
    if (status === 'revised') {
      await db.query(`UPDATE ${table} SET revise_reason=? WHERE id=?`, [reason || null, req.params.id]);
    }
    // Clear any leftover pending approval (e.g. after an admin override).
    await db.query(`DELETE FROM task_approvals WHERE task_id=? AND task_type=? AND status='pending'`, [req.params.id, tType]);
    res.json({ success: true, needsApproval: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tasks/:id/detail', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const table = getTable(type||'delegation');
    const [rows] = await db.query(`SELECT t.*,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date FROM ${table} t WHERE t.id=?`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/:id/edit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type, desc, date, priority, approval, remarks, url } = req.body;
    const table = getTable(type||'delegation');
    if (type === 'delegation') await db.query(`UPDATE ${table} SET description=?,due_date=?,priority=?,approval=?,remarks=?,url=? WHERE id=?`, [desc, date, priority||'low', approval||'no', remarks||'', url||null, req.params.id]);
    else await db.query(`UPDATE ${table} SET description=?,due_date=?,remarks=? WHERE id=?`, [desc, date, remarks||'', req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tasks/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    await db.query(`DELETE FROM ${getTable(type||'delegation')} WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk delete by user
app.delete('/api/tasks/user/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const table = getTable(type || 'delegation');
    await db.query(`DELETE FROM ${table} WHERE assigned_to = ?`, [req.params.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Transfer pending tasks to today
app.put('/api/tasks/user/:userId/transfer-today', requireAuth, requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { type } = req.query;
    const table = getTable(type || 'delegation');
    await db.query(`UPDATE ${table} SET due_date=? WHERE assigned_to=? AND status='pending'`,
      [today, req.params.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tasks/delete-by-date', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'Date required' });
    const [result] = await db.query('DELETE FROM checklist_tasks WHERE due_date=?', [date]);
    res.json({ success: true, deleted: result.affectedRows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Count checklist tasks for a user (all time or by year)
app.get('/api/tasks/checklist-year-count', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, year } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    let rows;
    if (!year || year === 'all') {
      [rows] = await db.query(`SELECT COUNT(*) AS count FROM checklist_tasks WHERE assigned_to=?`, [userId]);
    } else {
      [rows] = await db.query(`SELECT COUNT(*) AS count FROM checklist_tasks WHERE assigned_to=? AND YEAR(due_date)=?`, [userId, year]);
    }
    res.json({ count: rows[0].count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete all checklist tasks for a user (POST used to avoid body parse issues with DELETE)
app.post('/api/tasks/checklist-year-delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const [result] = await db.query(`DELETE FROM checklist_tasks WHERE assigned_to=?`, [userId]);
    res.json({ success: true, deleted: result.affectedRows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Checklist SERIES (groups) ──────────────────────────
// One "checklist" = an entire recurring series with the same description (can be 365 rows).
// This endpoint groups all of a user's checklists so the admin can choose
// which ones to delete (rather than all of them).
app.get('/api/tasks/checklist-groups', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const [rows] = await db.query(
      `SELECT t.description,
              COALESCE(t.frequency,'') AS frequency,
              COUNT(*) AS total,
              SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN t.status='pending' AND t.due_date >= CURDATE() THEN 1 ELSE 0 END) AS upcoming,
              DATE_FORMAT(MIN(t.due_date),'%Y-%m-%d') AS start_date,
              DATE_FORMAT(MAX(t.due_date),'%Y-%m-%d') AS last_date,
              DATE_FORMAT(MAX(t.end_date),'%Y-%m-%d') AS end_date
         FROM checklist_tasks t
        WHERE t.assigned_to=?
        GROUP BY t.description, COALESCE(t.frequency,'')
        ORDER BY MIN(t.due_date) ASC`, [userId]);
    res.json({ groups: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete the selected checklist series.
// body: { userId, groups: [{ description, frequency }], scope: 'all' | 'future' }
//   scope 'all'    → every row of that checklist (history included)
//   scope 'future'  → only pending rows from today onward (history is preserved)
app.post('/api/tasks/checklist-group-delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.body.userId, 10);
    const groups = Array.isArray(req.body.groups) ? req.body.groups : [];
    const scope = req.body.scope === 'future' ? 'future' : 'all';
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!groups.length) return res.status(400).json({ error: 'Please select at least one checklist' });

    let deleted = 0;
    const details = [];
    for (const g of groups) {
      const desc = String(g && g.description != null ? g.description : '');
      if (!desc) continue;
      const freq = String(g && g.frequency != null ? g.frequency : '');
      const params = [userId, desc];
      let sql = `DELETE FROM checklist_tasks WHERE assigned_to=? AND description=?`;
      // frequency '' means older rows (saved before frequency existed) — match both NULL and ''
      if (freq) { sql += ` AND frequency=?`; params.push(freq); }
      else      { sql += ` AND (frequency IS NULL OR frequency='')`; }
      if (scope === 'future') sql += ` AND status='pending' AND due_date >= CURDATE()`;
      const [r] = await db.query(sql, params);
      deleted += r.affectedRows || 0;
      details.push({ description: desc, frequency: freq, deleted: r.affectedRows || 0 });
    }
    res.json({ success: true, deleted, scope, details });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Change a checklist series' end date — removes pending tasks after the end date,
// and updates end_date on the rows that remain.
// body: { userId, description, frequency, endDate }
app.post('/api/tasks/checklist-set-end-date', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.body.userId, 10);
    const desc = String(req.body.description || '');
    const freq = String(req.body.frequency || '');
    const endDate = normDate(req.body.endDate != null ? req.body.endDate : req.body.end_date);
    if (!userId || !desc) return res.status(400).json({ error: 'userId and description required' });
    if (!endDate) return res.status(400).json({ error: 'Valid end date (YYYY-MM-DD) required' });

    const freqClause = freq ? ` AND frequency=?` : ` AND (frequency IS NULL OR frequency='')`;
    const freqParam = freq ? [freq] : [];

    // 1) Remove pending rows after the end date (completed history is left alone)
    const [del] = await db.query(
      `DELETE FROM checklist_tasks WHERE assigned_to=? AND description=?${freqClause} AND status='pending' AND due_date > ?`,
      [userId, desc, ...freqParam, endDate]);
    // 2) bachi hui rows par end_date set kar do
    const [upd] = await db.query(
      `UPDATE checklist_tasks SET end_date=? WHERE assigned_to=? AND description=?${freqClause}`,
      [endDate, userId, desc, ...freqParam]);

    res.json({ success: true, removed: del.affectedRows || 0, updated: upd.affectedRows || 0, endDate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// APPROVALS
// ══════════════════════════════════════════════════════
app.get('/api/approvals', requireAuth, async (req, res) => {
  try {
    const role = req.session.role;
    const isAdminOrPC = role === 'admin' || role === 'pc';
    // Admin/PC sees all pending approvals; others see only theirs
    const whereClause = isAdminOrPC
      ? `WHERE ta.status='pending'`
      : `WHERE ta.requested_to=? AND ta.status='pending'`;
    const params = isAdminOrPC ? [] : [req.session.userId];
    const [rows] = await db.query(`SELECT ta.*,DATE_FORMAT(ta.new_date,'%Y-%m-%d') AS new_date_fmt,u1.name AS requestedByName,u2.name AS requestedToName,dt.description,dt.approval AS taskApproval,DATE_FORMAT(dt.due_date,'%Y-%m-%d') AS currentDueDate FROM task_approvals ta JOIN users u1 ON ta.requested_by=u1.id JOIN users u2 ON ta.requested_to=u2.id LEFT JOIN delegation_tasks dt ON ta.task_id=dt.id AND ta.task_type='delegation' ${whereClause} ORDER BY ta.created_at DESC`, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/approvals/count', requireAuth, async (req, res) => {
  try {
    const role = req.session.role;
    const isAdminOrPC = role === 'admin' || role === 'pc';
    const [rows] = isAdminOrPC
      ? await db.query(`SELECT COUNT(*) AS count FROM task_approvals WHERE status='pending'`)
      : await db.query(`SELECT COUNT(*) AS count FROM task_approvals WHERE requested_to=? AND status='pending'`, [req.session.userId]);
    res.json({ count: rows[0].count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/approvals/:id', requireAuth, async (req, res) => {
  try {
    const { action, note } = req.body;
    const role = req.session.role;
    const uid = req.session.userId;
    const [rows] = await db.query('SELECT * FROM task_approvals WHERE id=?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Approval not found' });
    const appr = rows[0];
    if (appr.status !== 'pending') return res.status(400).json({ error: 'This request has already been decided.' });
    const table = getTable(appr.task_type);
    const isChecklist = appr.task_type === 'checklist';

    // Who is the doer of the underlying task?
    const [taskRows] = await db.query(`SELECT assigned_to FROM ${table} WHERE id=?`, [appr.task_id]);
    const doerId = taskRows[0] ? taskRows[0].assigned_to : null;

    const isAdmin = role === 'admin';
    const isPC = role === 'pc';
    const isDoer = doerId !== null && doerId === uid;

    // Admin has full authority — can approve/reject ANY pending request.
    if (!isAdmin) {
      // Regular users (and PC) can never approve a task they are the doer of.
      if (isDoer) {
        return res.status(403).json({ error: 'You cannot approve your own task. Only the chosen approver (or an admin) can approve it.' });
      }
      const isChosenApprover = appr.requested_to === uid;
      // PC may act as a fallback approver for other people's tasks.
      if (!isChosenApprover && !isPC) {
        return res.status(403).json({ error: 'Only the chosen approver can approve or reject this task.' });
      }
    }

    // The decision note is written over the request note, so capture the
    // requester's original reason first — otherwise approving a revision erases
    // the very explanation the approver just read.
    const requestReason = appr.note || null;
    await db.query('UPDATE task_approvals SET status=?,note=? WHERE id=?', [action, note||'', req.params.id]);

    if (action === 'approved') {
      if (appr.action_type === 'revised' && appr.new_date) {
        // Apply the revised date now that it is approved.
        if (isChecklist) await db.query(`UPDATE ${table} SET status='revised',due_date=? WHERE id=?`, [appr.new_date, appr.task_id]);
        else await db.query(`UPDATE ${table} SET status='revised',waiting_approval=0,due_date=? WHERE id=?`, [appr.new_date, appr.task_id]);
        await db.query(`UPDATE ${table} SET revise_reason=? WHERE id=?`, [requestReason, appr.task_id]);
      } else {
        if (isChecklist) await db.query(`UPDATE ${table} SET status=? WHERE id=?`, [appr.action_type, appr.task_id]);
        else await db.query(`UPDATE ${table} SET status=?,waiting_approval=0 WHERE id=?`, [appr.action_type, appr.task_id]);
      }
    } else {
      // Rejected — keep original status & due date, just clear the waiting flag.
      if (!isChecklist) await db.query(`UPDATE ${table} SET waiting_approval=0 WHERE id=?`, [appr.task_id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// MIS
// ══════════════════════════════════════════════════════
app.get('/api/mis', requireAuth, requireAdminOrHodOnly, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const isHod = req.session.role === 'hod';
    // Filter to the HOD's own department
    let deptFilter = '';
    let deptParams = [start, end];
    if (isHod) {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [req.session.userId]);
      const dept = me[0]?.department || '';
      deptFilter = 'AND u.department=?';
      deptParams = [start, end, dept];
    }

    const calc = rows => rows.map(r => {
      const total=parseInt(r.total)||0, pending=parseInt(r.pending)||0, overdue=parseInt(r.overdue)||0, revised=parseInt(r.revised)||0;
      let score = total > 0 ? Math.max(-100, Math.round((0-(pending/total)*100-(overdue/total)*50-(revised/total)*25)*10)/10) : 0;
      return { ...r, delayed: overdue, score };
    });
    const [delRows] = await db.query(`SELECT u.id AS userId,u.name,COUNT(*) AS total,SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,SUM(CASE WHEN t.status='revised' THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue FROM delegation_tasks t JOIN users u ON t.assigned_to=u.id WHERE t.due_date BETWEEN ? AND ? ${deptFilter} GROUP BY u.id,u.name ORDER BY u.name`, deptParams);
    const [chlRows] = await db.query(`SELECT u.id AS userId,u.name,COUNT(*) AS total,SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,0 AS revised,SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue FROM checklist_tasks t JOIN users u ON t.assigned_to=u.id WHERE t.due_date BETWEEN ? AND ? ${deptFilter} GROUP BY u.id,u.name ORDER BY u.name`, deptParams);
    res.json({ delegation: calc(delRows), checklist: calc(chlRows) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── FMS Dashboard — row-level pending tasks (like delegation/checklist) ──
app.get('/api/fms-dashboard', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    const isAdmin = role === 'admin' || role === 'pc';
    const isHod = role === 'hod';
    const filterEmployee = req.query.employee;

    const today = new Date().toISOString().split('T')[0];

    // Determine which user IDs to show
    let targetUserIds = null; // null = all (admin)
    if (isAdmin && filterEmployee && filterEmployee !== 'all') {
      targetUserIds = [parseInt(filterEmployee)];
    } else if (isHod) {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      if (filterEmployee && filterEmployee !== 'all') {
        targetUserIds = [parseInt(filterEmployee)];
      } else {
        const [deptUsers] = await db.query('SELECT id FROM users WHERE department=? AND role NOT IN (?,?)', [dept, 'admin', 'hod']);
        targetUserIds = deptUsers.map(u => u.id);
        if (!targetUserIds.length) return res.json({ rows: [], pendingCount: 0 });
      }
    } else {
      // Regular employee — only their own steps
      targetUserIds = [uid];
    }

    // Get FMS sheets
    let fmsList;
    if (isAdmin && !filterEmployee || (isAdmin && filterEmployee === 'all')) {
      [fmsList] = await db.query('SELECT * FROM fms_sheets ORDER BY fms_name ASC');
    } else {
      // Get FMS where targetUserIds are doers
      [fmsList] = await db.query(
        `SELECT DISTINCT fs.* FROM fms_sheets fs
         JOIN fms_steps fst ON fst.fms_id=fs.id
         JOIN fms_step_doers fsd ON fsd.step_id=fst.id
         WHERE fsd.user_id IN (${targetUserIds.map(()=>'?').join(',')})
         ORDER BY fs.fms_name ASC`, targetUserIds);
    }

    if (!fmsList.length) return res.json({ rows: [], pendingCount: 0 });

    const allRows = [];

    for (const sheet of fmsList) {
      const fmsName = sheet.fms_name || sheet.sheet_name;

      // Get steps for this FMS that are assigned to targetUserIds
      let steps;
      if (isAdmin && (!filterEmployee || filterEmployee === 'all')) {
        [steps] = await db.query('SELECT * FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC', [sheet.id]);
      } else {
        [steps] = await db.query(
          `SELECT DISTINCT fst.* FROM fms_steps fst
           JOIN fms_step_doers fsd ON fsd.step_id=fst.id
           WHERE fst.fms_id=? AND fsd.user_id IN (${targetUserIds.map(()=>'?').join(',')})
           ORDER BY fst.step_order ASC`, [sheet.id, ...targetUserIds]);
      }
      if (!steps.length) continue;

      // Get doer names for each step
      for (const step of steps) {
        const [doers] = await db.query(
          `SELECT u.id, u.name FROM fms_step_doers fsd JOIN users u ON fsd.user_id=u.id WHERE fsd.step_id=?`, [step.id]);
        step.doerNames = doers.map(d => d.name).join(', ');
        step.doerIds = doers.map(d => d.id);
      }

      try {
        const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
        const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
        const tabName = sheet.sheet_name || 'Sheet1';
        const headerRowIdx = (sheet.header_row || 1) - 1;

        const filteredSteps = steps; // fix: was undefined, use steps array
        const allCols = filteredSteps.flatMap(s => [colToIdx(s.plan_col), colToIdx(s.actual_col)]).filter(x => x >= 0);
        if (!allCols.length) continue;
        const maxCol = Math.max(...allCols);
        const lastCol = idxToCol(maxCol);
        const range = `${tabName}!A:${lastCol}`;

        const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
        const sheetData = response.data.values || [];
        const headers = sheetData[headerRowIdx] || [];
        const dataRows = sheetData.slice(headerRowIdx + 1);

        for (const step of steps) {
          const planIdx = colToIdx(step.plan_col);
          const actualIdx = colToIdx(step.actual_col);
          if (planIdx < 0 || actualIdx < 0) continue;
          const planFormat = detectColumnDateFormat(dataRows.map(r => r[planIdx]));

          dataRows.forEach((row, i) => {
            const planVal = (row[planIdx] || '').trim();
            const actualVal = (row[actualIdx] || '').trim();
            if (!planVal || actualVal) return; // skip if no plan or already done

            // Parse plan date — sheetDateToYMD auto-detects DD/MM/YYYY vs MM/DD/YYYY ambiguity
            const planDate = sheetDateToYMD(planVal, planFormat) || '';

            // isLate: plan date is in the past and still pending
            const isLate = planDate && planDate < today;

            allRows.push({
              fmsName,
              fmsId: sheet.id,
              stepName: step.step_name,
              stepId: step.id,
              doer: step.doerNames || '—',
              planValue: planVal,
              planDate: planDate || '',
              isLate,
              rowNumber: headerRowIdx + 1 + i + 1
            });
          });
        }
      } catch(e) {
        // Skip sheet on error, don't fail whole request
      }
    }

    res.json({ rows: allRows, pendingCount: allRows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mis/detail', requireAuth, requireAdminOrHodOnly, async (req, res) => {
  try {
    const { userId, type, start, end } = req.query;
    if (!userId || !start || !end) return res.status(400).json({ error: 'Missing params' });
    const table = type === 'delegation' ? 'delegation_tasks' : 'checklist_tasks';
    const [tasks] = await db.query(`SELECT t.id,t.description,t.status,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,u2.name AS assigned_by_name FROM ${table} t JOIN users u2 ON t.assigned_by=u2.id WHERE t.assigned_to=? AND t.due_date BETWEEN ? AND ? ORDER BY t.due_date ASC`, [userId, start, end]);
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── All MIS — per employee combined score ──
app.get('/api/mis/all', requireAuth, requireAdminOrHodOnly, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const isHod = req.session.role === 'hod';
    const uid = req.session.userId;

    // Same deptFilter logic as /api/mis — tasks JOIN users se filter
    let deptFilter = '';
    let deptParams = [start, end];
    if (isHod) {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      deptFilter = 'AND u.department=?';
      deptParams = [start, end, dept];
    }

    const calc = (total, pending, overdue, revised) => {
      total = parseInt(total)||0; pending = parseInt(pending)||0;
      overdue = parseInt(overdue)||0; revised = parseInt(revised)||0;
      const score = total > 0 ? Math.max(-100, Math.round((0-(pending/total)*100-(overdue/total)*50-(revised/total)*25)*10)/10) : 0;
      return { total, pending, overdue, revised, score };
    };

    // Fetch delegation + checklist stats per user (same style as /api/mis)
    const [delRows] = await db.query(
      `SELECT u.id AS userId, u.name, u.department,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN t.status='revised' THEN 1 ELSE 0 END) AS revised,
        SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
       FROM delegation_tasks t JOIN users u ON t.assigned_to=u.id
       WHERE t.due_date BETWEEN ? AND ? ${deptFilter}
       GROUP BY u.id, u.name, u.department ORDER BY u.name`, deptParams);

    const [chlRows] = await db.query(
      `SELECT u.id AS userId, u.name, u.department,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
        0 AS revised,
        SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
       FROM checklist_tasks t JOIN users u ON t.assigned_to=u.id
       WHERE t.due_date BETWEEN ? AND ? ${deptFilter}
       GROUP BY u.id, u.name, u.department ORDER BY u.name`, deptParams);

    // Merge by userId
    const userMap = {};
    for (const r of delRows) {
      userMap[r.userId] = { userId: r.userId, name: r.name, department: r.department||'',
        delegation: calc(r.total, r.pending, r.overdue, r.revised),
        delegationCompleted: parseInt(r.completed)||0,
        checklist: calc(0,0,0,0), checklistCompleted: 0 };
      userMap[r.userId].delegation.completed = parseInt(r.completed)||0;
    }
    for (const r of chlRows) {
      if (!userMap[r.userId]) {
        userMap[r.userId] = { userId: r.userId, name: r.name, department: r.department||'',
          delegation: calc(0,0,0,0), delegationCompleted: 0,
          checklist: calc(0,0,0,0), checklistCompleted: 0 };
        userMap[r.userId].delegation.completed = 0;
      }
      userMap[r.userId].checklist = calc(r.total, r.pending, r.overdue, 0);
      userMap[r.userId].checklist.completed = parseInt(r.completed)||0;
      userMap[r.userId].checklistCompleted = parseInt(r.completed)||0;
    }

    // Fetch the week plan for each user — DATE_FORMAT so the frontend gets a clean YYYY-MM-DD (not an ISO timestamp)
    let planMap = {};
    try {
      const [plans] = await db.query(
        `SELECT employee_id, target_count, DATE_FORMAT(start_date,'%Y-%m-%d') AS start_date, improvement_pct FROM week_plans WHERE start_date BETWEEN ? AND ? ORDER BY start_date DESC`, [start, end]);
      for (const p of plans) {
        if (!planMap[p.employee_id]) planMap[p.employee_id] = p;
      }
    } catch(e) { /* week_plans table may not exist yet */ }

    // ── FMS contribution per user ─────────────────────────────────────
    // For each user, count pending/done across the steps where they are the doer.
    // FMS applies to admins only (for a HOD, users in their department are counted too).
    const fmsUserMap = {};   // userId -> { total, pending, done }
    try {
      const [allSheets] = await db.query('SELECT * FROM fms_sheets');
      if (allSheets.length) {
        const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']).catch(()=>null);
        if (sheetsApi) {
          for (const sheet of allSheets) {
            const [steps] = await db.query('SELECT * FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC', [sheet.id]);
            if (!steps.length) continue;
            // Doers per step
            for (const step of steps) {
              const [doers] = await db.query(
                `SELECT fsd.user_id FROM fms_step_doers fsd WHERE fsd.step_id=?`, [step.id]);
              step.doerIds = doers.map(d => d.user_id);
            }
            try {
              const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
              const tabName = sheet.sheet_name || 'Sheet1';
              const headerRowIdx = (sheet.header_row || 1) - 1;
              const allCols = steps.flatMap(s => [colToIdx(s.plan_col), colToIdx(s.actual_col)]).filter(x => x >= 0);
              if (!allCols.length) continue;
              const maxCol = Math.max(...allCols);
              const lastCol = idxToCol(maxCol);
              const range = `${tabName}!A:${lastCol}`;
              const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
              const allRowsData = response.data.values || [];
              const dataRows = allRowsData.slice(headerRowIdx + 1);
              for (const step of steps) {
                if (!step.doerIds.length) continue;
                const planIdx = colToIdx(step.plan_col);
                const actualIdx = colToIdx(step.actual_col);
                if (planIdx < 0 || actualIdx < 0) continue;
                const planFormat = detectColumnDateFormat(dataRows.map(r => r[planIdx]));
                let stepPending = 0, stepDone = 0, stepDelayed = 0;
                dataRows.forEach(row => {
                  const planVal = (row[planIdx]||'').trim();
                  const actualVal = (row[actualIdx]||'').trim();
                  if (!planVal) return;
                  const planYMD = sheetDateToYMD(planVal, planFormat);
                  if (planYMD && (planYMD < start || planYMD > end)) return;
                  if (!actualVal) stepPending++;
                  if (actualVal) stepDone++;
                  if (isRowDelayed(planVal, actualVal, planFormat)) stepDelayed++;
                });
                // Distribute counts to each doer (the full count is attributed to every doer — shared work)
                step.doerIds.forEach(uid => {
                  if (!fmsUserMap[uid]) fmsUserMap[uid] = { total: 0, pending: 0, done: 0, delayed: 0 };
                  fmsUserMap[uid].pending += stepPending;
                  fmsUserMap[uid].done    += stepDone;
                  fmsUserMap[uid].total   += stepPending + stepDone;
                  fmsUserMap[uid].delayed += stepDelayed;
                });
              }
            } catch(e) { /* skip this sheet on error */ }
          }
        }
      }
    } catch(e) { /* ignore — FMS optional */ }

    // If a user works only in FMS (0 delegation/checklist tasks), add them to userMap as well,
    // so their FMS contribution shows up in All MIS.
    if (Object.keys(fmsUserMap).length) {
      const fmsUserIds = Object.keys(fmsUserMap).map(x => parseInt(x)).filter(x => !userMap[x]);
      if (fmsUserIds.length) {
        let userQ = `SELECT id, name, department FROM users WHERE id IN (${fmsUserIds.map(()=>'?').join(',')})`;
        const userQParams = [...fmsUserIds];
        if (isHod) {
          const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
          const dept = me[0]?.department || '';
          userQ += ' AND department=?';
          userQParams.push(dept);
        }
        const [extraUsers] = await db.query(userQ, userQParams);
        for (const u of extraUsers) {
          userMap[u.id] = { userId: u.id, name: u.name, department: u.department||'',
            delegation: calc(0,0,0,0), delegationCompleted: 0,
            checklist: calc(0,0,0,0), checklistCompleted: 0 };
          userMap[u.id].delegation.completed = 0;
        }
      }
    }

    const result = Object.values(userMap).map(u => {
      const d = u.delegation, c = u.checklist;
      const fms = fmsUserMap[u.userId] || { total: 0, pending: 0, done: 0, delayed: 0 };
      const totalAll = d.total + c.total + fms.total;
      const pendingAll = d.pending + c.pending + fms.pending;
      const overdueAll = d.overdue + c.overdue + (fms.delayed||0);
      const revisedAll = d.revised;
      const completedAll = (d.completed||0) + (c.completed||0) + fms.done;
      const overallScore = totalAll > 0
        ? Math.max(-100, Math.round((0-(pendingAll/totalAll)*100-(overdueAll/totalAll)*50-(revisedAll/totalAll)*25)*10)/10)
        : null;
      const plan = planMap[u.userId] || null;
      // FMS score: jitne pending/delayed utna negative, jitne done utna acha
      const fmsScore = fms.total > 0
        ? Math.max(-100, Math.round((0 - (fms.pending/fms.total)*100 - ((fms.delayed||0)/fms.total)*50)*10)/10)
        : null;
      return { ...u, fms: { ...fms, score: fmsScore }, totalAll, pendingAll, overdueAll, revisedAll, completedAll, overallScore, plan };
    }).filter(u => u.totalAll > 0).sort((a,b) => a.name.localeCompare(b.name));

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── FMS MIS ──
app.get('/api/mis/fms', requireAuth, requireAdminOrHodOnly, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const isHod = req.session.role === 'hod';
    const uid = req.session.userId;

    // Get FMS sheets
    const [sheets] = await db.query('SELECT * FROM fms_sheets ORDER BY fms_name ASC');
    if (!sheets.length) return res.json([]);

    // Fetch the HOD's department first (once)
    let hodDept = '';
    if (isHod) {
      const [meRow] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      hodDept = meRow[0]?.department || '';
    }

    const results = [];

    for (const sheet of sheets) {
      // Get all steps with doers
      const [steps] = await db.query('SELECT * FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC', [sheet.id]);
      for (const step of steps) {
        const [doers] = await db.query(
          `SELECT fsd.user_id, u.name, u.department FROM fms_step_doers fsd
           JOIN users u ON fsd.user_id=u.id WHERE fsd.step_id=?`, [step.id]);
        step.doers = doers;
      }

      // HOD: only steps whose doers belong to their department
      const filteredSteps = isHod
        ? steps.filter(s => s.doers.some(d => d.department === hodDept))
        : steps;
      if (isHod && filteredSteps.length === 0) continue;

      // Build per-user per-step stats from Google Sheet
      try {
        const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
        const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
        const tabName = sheet.sheet_name || 'Sheet1';
        const headerRowIdx = (sheet.header_row || 1) - 1;

        const allCols = filteredSteps.flatMap(s => [colToIdx(s.plan_col), colToIdx(s.actual_col)]).filter(x => x >= 0);
        if (!allCols.length) continue;
        const maxCol = Math.max(...allCols);
        const lastCol = idxToCol(maxCol);
        const range = `${tabName}!A:${lastCol}`;

        const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
        const allRowsData = response.data.values || [];
        const dataRows = allRowsData.slice(headerRowIdx + 1);

        // Per-FMS aggregate stats
        let fmsPending = 0, fmsDone = 0, fmsTotal = 0, fmsDelayed = 0;
        const perStepStats = [];

        // FMS score formula — same convention as Delegation/Checklist MIS:
        // 0 = perfect (everything done on time); negative = pending/delayed work lowers the score.
        const fmsScoreCalc = (total, pending, delayed) => {
          if (!total) return 0;
          return Math.max(-100, Math.round((0 - (pending/total)*100 - (delayed/total)*50) * 10) / 10);
        };

        for (const step of filteredSteps) {
          const planIdx = colToIdx(step.plan_col);
          const actualIdx = colToIdx(step.actual_col);
          if (planIdx < 0 || actualIdx < 0) continue;
          const planFormat = detectColumnDateFormat(dataRows.map(r => r[planIdx]));

          let stepPending = 0, stepDone = 0, stepDelayed = 0;
          dataRows.forEach(row => {
            const planVal = (row[planIdx]||'').trim();
            const actualVal = (row[actualIdx]||'').trim();
            if (!planVal) return;
            // Date-range filter — when the plan date is valid, count only within the selected range.
            // (if plan_col holds no date, e.g. a custom form, skip the filter — previous behaviour)
            const planYMD = sheetDateToYMD(planVal, planFormat);
            if (planYMD && (planYMD < start || planYMD > end)) return;
            if (!actualVal) stepPending++;
            if (actualVal) stepDone++;
            if (isRowDelayed(planVal, actualVal, planFormat)) stepDelayed++;
          });

          fmsPending += stepPending;
          fmsDone += stepDone;
          fmsTotal += stepPending + stepDone;
          fmsDelayed += stepDelayed;

          const stepDoerNames = step.doers.map(d=>d.name).join(', ') || '—';
          const stepTotal = stepPending + stepDone;

          perStepStats.push({
            stepName: step.step_name,
            stepOrder: step.step_order,
            doers: stepDoerNames,
            pending: stepPending,
            done: stepDone,
            total: stepTotal,
            delayed: stepDelayed,
            score: fmsScoreCalc(stepTotal, stepPending, stepDelayed)
          });
        }

        if (perStepStats.length > 0 || !isHod) {
          results.push({
            fmsId: sheet.id,
            fmsName: sheet.fms_name || sheet.sheet_name,
            pending: fmsPending,
            done: fmsDone,
            total: fmsTotal,
            delayed: fmsDelayed,
            score: fmsScoreCalc(fmsTotal, fmsPending, fmsDelayed),
            steps: perStepStats
          });
        }
      } catch(e) {
        results.push({
          fmsId: sheet.id,
          fmsName: sheet.fms_name || sheet.sheet_name,
          pending: 0, done: 0, total: 0, delayed: 0, score: 0,
          steps: [], error: e.message
        });
      }
    }

    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// MERCH FMS — Production Merchandising FMS - Unit 1
// Data-entry FORM: user SO NO, Party Name, SKU, No. of Pcs, Material Name,
// Material Type, Quantity, Unit, Quantity Required and Status —
// on submit a new row is appended straight into the Google Sheet:
// COL A = Timestamp (auto), COL B = Unique ID (auto), COL C se form data (Row 451 se).
// ══════════════════════════════════════════════════════
const MERCH_FMS_SHEET_ID = process.env.MERCH_FMS_SHEET_ID || '';
const MERCH_FMS_GID = Number(process.env.MERCH_FMS_GID || 0);
// Row the form starts writing at. 451/616/163 were offsets into the previous
// project's already-populated sheets; on a fresh sheet that would leave hundreds
// of blank rows above the first entry. Default 2 = straight after the header row.
const MERCH_FMS_START_ROW = Number(process.env.MERCH_FMS_START_ROW || 2);
const MERCH_FMS_STATUS_OPTIONS = ['Raise PO', 'Material Issue', 'Inhouse'];
const MERCH_FMS_UNIT_OPTIONS = ['PCS', 'MTR', 'GRS', 'KGS', 'ROLLS', 'BOX'];

// Resolves a gid to the actual tab name (the Values API needs the tab NAME, not the gid)
async function resolveMerchFMSTabName(sheetsApi) {
  const meta = await sheetsApi.spreadsheets.get({
    spreadsheetId: MERCH_FMS_SHEET_ID,
    fields: 'sheets.properties'
  });
  const match = (meta.data.sheets || []).find(s => s.properties.sheetId === MERCH_FMS_GID);
  if (!match) throw new Error('Sheet tab (gid=' + MERCH_FMS_GID + ') not found');
  return match.properties.title;
}

// POST — form submit: APPENDs the new row(s) to the sheet (COL C to K)
app.post('/api/merch-fms/submit', requireAuth, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'At least 1 row required' });

    for (const r of rows) {
      if (!r.soNo || !r.status) return res.status(400).json({ error: 'SO NO and Status are required in every row' });
      if (!MERCH_FMS_STATUS_OPTIONS.includes(r.status)) return res.status(400).json({ error: 'Invalid status value' });
      if (r.unit && !MERCH_FMS_UNIT_OPTIONS.includes(r.unit)) return res.status(400).json({ error: 'Invalid unit value' });
    }

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    const tabName = await resolveMerchFMSTabName(sheetsApi);

    // Timestamp in DD/MM/YYYY HH:mm:ss (IST) — the same convention is used across the app
    const nowStr = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '');

    const values = rows.map(r => [
      nowStr, crypto.randomUUID(),
      r.soNo||'', r.partyName||'', r.sku||'', r.noOfPcs||'', r.materialName||'',
      r.materialType||'', r.quantity||'', r.unit||'', r.vendorName||'', r.status||''
    ]);

    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: MERCH_FMS_SHEET_ID,
      range: `${tabName}!A${MERCH_FMS_START_ROW}:L`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values }
    });

    res.json({ success: true, count: values.length });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share this sheet with the service account.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found.' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/merch-fms/status-options', requireAuth, (req, res) => {
  res.json({ statusOptions: MERCH_FMS_STATUS_OPTIONS });
});

app.get('/api/merch-fms/unit-options', requireAuth, (req, res) => {
  res.json({ unitOptions: MERCH_FMS_UNIT_OPTIONS });
});

// ══════════════════════════════════════════════════════
// MERCH FMS — Production Merchandising FMS - Unit 2
// Identical to the Unit 1 form (SO NO, Party Name, SKU, No. of Pcs,
// Material Name, Material Type, Quantity, Unit, Quantity Required, Status), bas
// but writes to a different Google Sheet — MERCH_FMS_22GODAM_SHEET_ID (.env),
// tab MERCH_FMS_22GODAM_GID, COL C se K tak, Row 616 se.
// ══════════════════════════════════════════════════════
const MERCH_FMS_22GODAM_SHEET_ID = process.env.MERCH_FMS_22GODAM_SHEET_ID || '';
const MERCH_FMS_22GODAM_GID = Number(process.env.MERCH_FMS_22GODAM_GID || 0);
const MERCH_FMS_22GODAM_START_ROW = Number(process.env.MERCH_FMS_22GODAM_START_ROW || 2);

async function resolveMerch22GodamTabName(sheetsApi) {
  const meta = await sheetsApi.spreadsheets.get({
    spreadsheetId: MERCH_FMS_22GODAM_SHEET_ID,
    fields: 'sheets.properties'
  });
  const match = (meta.data.sheets || []).find(s => s.properties.sheetId === MERCH_FMS_22GODAM_GID);
  if (!match) throw new Error('Sheet tab (gid=' + MERCH_FMS_22GODAM_GID + ') not found');
  return match.properties.title;
}

// POST — form submit: APPENDs the new row(s) to the sheet (COL C to K)
app.post('/api/merch-fms-22godam/submit', requireAuth, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'At least 1 row required' });

    for (const r of rows) {
      if (!r.soNo || !r.status) return res.status(400).json({ error: 'SO NO and Status are required in every row' });
      if (!MERCH_FMS_STATUS_OPTIONS.includes(r.status)) return res.status(400).json({ error: 'Invalid status value' });
      if (r.unit && !MERCH_FMS_UNIT_OPTIONS.includes(r.unit)) return res.status(400).json({ error: 'Invalid unit value' });
    }

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    const tabName = await resolveMerch22GodamTabName(sheetsApi);

    const values = rows.map(r => [
      r.soNo||'', r.partyName||'', r.sku||'', r.noOfPcs||'', r.materialName||'',
      r.materialType||'', r.quantity||'', r.unit||'', r.vendorName||'', r.status||''
    ]);

    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: MERCH_FMS_22GODAM_SHEET_ID,
      range: `${tabName}!C${MERCH_FMS_22GODAM_START_ROW}:L`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values }
    });

    res.json({ success: true, count: values.length });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share this sheet with the service account.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found.' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/merch-fms-22godam/status-options', requireAuth, (req, res) => {
  res.json({ statusOptions: MERCH_FMS_STATUS_OPTIONS });
});

app.get('/api/merch-fms-22godam/unit-options', requireAuth, (req, res) => {
  res.json({ unitOptions: MERCH_FMS_UNIT_OPTIONS });
});

// ══════════════════════════════════════════════════════
// PO — Purchase Order (same database/spreadsheet as Merch FMS,
// alag "PO" tab). COL C se M tak:
//   C Order By | D Party Name | E Vendor Name | F SO Number |
//   G Material Type | H Style No | I Quantity Required | J Price |
//   K PO Document Link | L Uploaded By | M Uploaded At
// COL A and B stay empty/unused.
//
// Workflow: the Production department fills and submits the PO. Finance
// (and Admin) upload their PO document (from Tally / their own software)
// against that entry — it is stored on Drive and the link is written into the row.
// Production can then view/download the document from that same link.
// Admin has access to both sides.
// ══════════════════════════════════════════════════════
const PO_SHEET_ID = MERCH_FMS_SHEET_ID; // same spreadsheet as Merch FMS
const PO_TAB_NAME = 'PO';
const PO_START_ROW = 2; // row 1 = headers

// Resolves the current user's department (from the DB — the JWT has no department)
async function getUserDept(userId) {
  const [rows] = await db.query('SELECT department FROM users WHERE id=?', [userId]);
  return (rows[0]?.department || '').trim().toLowerCase();
}
function requirePOFill(req, res, next) {
  (async () => {
    if (req.session.role === 'admin') return next();
    const dept = await getUserDept(req.session.userId);
    if (dept === 'production') return next();
    res.status(403).json({ error: 'Only the Production department (or an Admin) can fill a PO.' });
  })().catch(err => res.status(500).json({ error: err.message }));
}
function requirePOUpload(req, res, next) {
  (async () => {
    if (req.session.role === 'admin') return next();
    const dept = await getUserDept(req.session.userId);
    if (dept === 'finance') return next();
    res.status(403).json({ error: 'Only the Finance department (or an Admin) can upload a PO document.' });
  })().catch(err => res.status(500).json({ error: err.message }));
}
function requirePOView(req, res, next) {
  (async () => {
    if (req.session.role === 'admin') return next();
    const dept = await getUserDept(req.session.userId);
    if (dept === 'production' || dept === 'finance') return next();
    res.status(403).json({ error: 'This PO section is only for Production, Finance or Admin.' });
  })().catch(err => res.status(500).json({ error: err.message }));
}

// Looks for a tab named "PO"; creates it (with headers) if it does not exist
async function ensurePOTab(sheetsApi) {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: PO_SHEET_ID, fields: 'sheets.properties' });
  const match = (meta.data.sheets || []).find(s => s.properties.title === PO_TAB_NAME);
  if (match) return match.properties.title;

  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId: PO_SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: PO_TAB_NAME } } }] }
  });
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: PO_SHEET_ID,
    range: `${PO_TAB_NAME}!C1:M1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[
      'Order By', 'Party Name', 'Vendor Name', 'SO Number', 'Material Type', 'Style No',
      'Quantity Required', 'Price', 'PO Document Link', 'Uploaded By', 'Uploaded At'
    ]] }
  });
  return PO_TAB_NAME;
}

// POST — form submit (Production / Admin only): APPENDs the new row(s) to the "PO" tab (COL C to J)
app.post('/api/po/submit', requireAuth, requirePOFill, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'At least 1 row required' });
    for (const r of rows) {
      if (!r.partyName) return res.status(400).json({ error: 'Party Name is required in every row' });
    }

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    const tabName = await ensurePOTab(sheetsApi);

    const values = rows.map(r => [
      r.orderBy||'', r.partyName||'', r.vendorName||'', r.soNumber||'', r.materialType||'', r.styleNo||'', r.qtyRequired||'', r.price||''
    ]);

    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: PO_SHEET_ID,
      range: `${tabName}!C${PO_START_ROW}:J`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values }
    });

    res.json({ success: true, count: values.length });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share this sheet with the service account.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found.' });
    res.status(500).json({ error: err.message });
  }
});

// GET — the complete list of entries recorded so far in the "PO" tab (Production / Finance / Admin)
app.get('/api/po/entries', requireAuth, requirePOView, async (req, res) => {
  try {
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const tabName = await ensurePOTab(sheetsApi);
    const resp = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: PO_SHEET_ID,
      range: `${tabName}!C${PO_START_ROW}:M`
    });
    const values = resp.data.values || [];
    const entries = values
      .map((row, i) => ({
        row: PO_START_ROW + i,
        orderBy: row[0]||'', partyName: row[1]||'', vendorName: row[2]||'', soNumber: row[3]||'',
        materialType: row[4]||'', styleNo: row[5]||'', qtyRequired: row[6]||'', price: row[7]||'',
        docUrl: row[8]||'', uploadedBy: row[9]||'', uploadedAt: row[10]||''
      }))
      .filter(e => e.partyName || e.orderBy || e.materialType || e.styleNo || e.qtyRequired || e.price || e.vendorName || e.soNumber);
    res.json({ entries });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share this sheet with the service account.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found.' });
    res.status(500).json({ error: err.message });
  }
});

// POST — Finance (or Admin) uploads the PO document here (Tally export / their own software's PO).
// The file goes to Google Drive (link-viewable) and its link + uploader + timestamp are written
// into COL K/L/M of that row — Production can view/download it from there.
app.post('/api/po/:row/upload-doc', requireAuth, requirePOUpload, poUpload.single('file'), async (req, res) => {
  try {
    const rowNum = parseInt(req.params.row, 10);
    if (!rowNum || rowNum < PO_START_ROW) return res.status(400).json({ error: 'Invalid row' });
    if (!req.file) return res.status(400).json({ error: 'A file is required' });

    const docUrl = await uploadPODocToDrive(req.file.buffer, req.file.originalname, req.file.mimetype);
    const nowStr = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '');

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    const tabName = await ensurePOTab(sheetsApi);
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: PO_SHEET_ID,
      range: `${tabName}!K${rowNum}:M${rowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[docUrl, req.session.name || '', nowStr]] }
    });

    res.json({ success: true, docUrl, uploadedBy: req.session.name || '', uploadedAt: nowStr });
  } catch (err) {
    const msg = err.message || '';
    if (/storage quota/i.test(msg)) {
      return res.status(400).json({ error: 'Drive upload failed: a service account has no storage quota of its own. Set PO_DRIVE_FOLDER_ID to a shared/personal Drive folder and share it with the service account.' });
    }
    if (err.code === 404) return res.status(400).json({ error: 'PO_DRIVE_FOLDER_ID is invalid, or the folder is not shared with the service account.' });
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share the Drive folder or Sheet with the service account.' });
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// PROCESS FMS — PRODUCTION MANAGMENT FMS - Unit 1
// Data-entry FORM: Doc Link, Actual Process Quantity, Design Number,
// SO Number and Party Name — the timestamp is added automatically —
// on submit a new row is appended to the Google Sheet ("Process FMS" tab), COL A to F.
// ══════════════════════════════════════════════════════
const PROCESS_FMS_SHEET_ID = process.env.PROCESS_FMS_SHEET_ID || '';
const PROCESS_FMS_GID = Number(process.env.PROCESS_FMS_GID || 0);
const PROCESS_FMS_START_ROW = Number(process.env.PROCESS_FMS_START_ROW || 2);

async function resolveTabNameByGid(sheetsApi, spreadsheetId, gid) {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const match = (meta.data.sheets || []).find(s => s.properties.sheetId === gid);
  if (!match) throw new Error('Sheet tab (gid=' + gid + ') not found');
  return match.properties.title;
}

app.post('/api/process-fms/submit', requireAuth, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'At least 1 row required' });

    for (const r of rows) {
      if (!r.soNumber) return res.status(400).json({ error: 'SO Number is required in every row' });
    }

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    const tabName = await resolveTabNameByGid(sheetsApi, PROCESS_FMS_SHEET_ID, PROCESS_FMS_GID);

    // Find the first empty row in COL A (Timestamp) from the start row onward, so that
    // older/stray data further down does not disturb this form's append point.
    const colA = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: PROCESS_FMS_SHEET_ID,
      range: `${tabName}!A${PROCESS_FMS_START_ROW}:A100000`
    });
    const colAValues = colA.data.values || [];
    let nextRow = PROCESS_FMS_START_ROW;
    for (let i = 0; i < colAValues.length; i++) {
      if (!colAValues[i] || !(colAValues[i][0]||'').trim()) { nextRow = PROCESS_FMS_START_ROW + i; break; }
      nextRow = PROCESS_FMS_START_ROW + i + 1; // all rows were filled, so use the row after them
    }

    // Timestamp in DD/MM/YYYY HH:mm:ss — the same convention is used across the app
    const nowStr = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '');

    const values = rows.map(r => [
      nowStr, r.docLink||'', r.actualQty||'', r.designNumber||'', r.soNumber||'', r.partyName||''
    ]);

    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: PROCESS_FMS_SHEET_ID,
      range: `${tabName}!A${nextRow}:F${nextRow + values.length - 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });

    res.json({ success: true, count: values.length });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied — please share this sheet with the service account.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found.' });
    res.status(500).json({ error: err.message });
  }
});

// ── PC: Users with pending tasks (for smart dropdown) ──
app.get('/api/users/with-pending-tasks', requireAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    let dateFilter = 'AND t.due_date <= CURDATE()';
    if (dateFrom && dateTo) dateFilter = `AND t.due_date BETWEEN '${dateFrom}' AND '${dateTo}'`;
    const [rows] = await db.query(`
      SELECT DISTINCT u.id, u.name FROM users u
      WHERE u.id IN (
        SELECT DISTINCT assigned_to FROM delegation_tasks t WHERE status='pending' ${dateFilter}
        UNION
        SELECT DISTINCT assigned_to FROM checklist_tasks t WHERE status='pending' ${dateFilter}
      ) AND u.role NOT IN ('admin','pc')
      ORDER BY u.name ASC`);
    res.json(rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id,name,email,notification_email,role,
              COALESCE(user_role, role) AS user_role,
              phone,department,week_off,extra_off,
              COALESCE(exclude_from_reminder,0) AS exclude_from_reminder
       FROM users ORDER BY role DESC,name ASC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, notification_email, password, role, user_role, phone, department, week_off, extra_off, exclude_from_reminder } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const [ex] = await db.query('SELECT id FROM users WHERE email=?', [email]);
    if (ex[0]) return res.status(400).json({ error: 'Email already exists' });
    const validRoles = ['admin','hod','pc','user'];
    const appRole = validRoles.includes(role) ? role : 'user';
    const userRole = validRoles.includes(user_role) ? user_role : appRole;
    await db.query('INSERT INTO users (name,email,notification_email,password,role,user_role,phone,department,week_off,extra_off,exclude_from_reminder) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [name, email, notification_email||'', bcrypt.hashSync(password,10), appRole, userRole, phone||null, department||'', week_off||'', extra_off||'', exclude_from_reminder?1:0]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, notification_email, role, user_role, password, phone, department, week_off, extra_off, exclude_from_reminder } = req.body;
    const exclVal = exclude_from_reminder ? 1 : 0;
    const validRoles = ['admin','hod','pc','user'];
    const appRole = validRoles.includes(role) ? role : 'user';
    const userRole = validRoles.includes(user_role) ? user_role : appRole;
    if (password) await db.query('UPDATE users SET name=?,email=?,notification_email=?,role=?,user_role=?,password=?,phone=?,department=?,week_off=?,extra_off=?,exclude_from_reminder=? WHERE id=?',
      [name,email,notification_email||'',appRole,userRole,bcrypt.hashSync(password,10),phone||null,department||'',week_off||'',extra_off||'',exclVal,req.params.id]);
    else await db.query('UPDATE users SET name=?,email=?,notification_email=?,role=?,user_role=?,phone=?,department=?,week_off=?,extra_off=?,exclude_from_reminder=? WHERE id=?',
      [name,email,notification_email||'',appRole,userRole,phone||null,department||'',week_off||'',extra_off||'',exclVal,req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
    await db.query('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk add users via CSV
app.post('/api/users/bulk', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { users } = req.body;
    if (!users || !users.length) return res.status(400).json({ error: 'No users provided' });
    const validRoles = ['admin','hod','pc','user'];
    let added = 0, skipped = 0, errors = [];
    for (const u of users) {
      if (!u.name || !u.email || !u.password) { errors.push(`${u.email||'?'}: missing fields`); continue; }
      const [ex] = await db.query('SELECT id FROM users WHERE email=?', [u.email]);
      if (ex[0]) { skipped++; continue; }
      const appRole = validRoles.includes(u.role) ? u.role : 'user';
      const userRole = validRoles.includes(u.user_role) ? u.user_role : appRole;
      await db.query('INSERT INTO users (name,email,password,role,user_role,phone,department,week_off,extra_off) VALUES (?,?,?,?,?,?,?,?,?)',
        [u.name, u.email, bcrypt.hashSync(u.password,10), appRole, userRole, u.phone||null, u.department||'', u.week_off||'', u.extra_off||'']);
      added++;
    }
    res.json({ success: true, added, skipped, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// PROFILE
// ══════════════════════════════════════════════════════
app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const { name, email, notification_email, phone, currentPassword, newPassword, profileImage } = req.body;
    if (currentPassword) {
      const [rows] = await db.query('SELECT password FROM users WHERE id=?', [uid]);
      if (!bcrypt.compareSync(currentPassword, rows[0].password)) return res.status(400).json({ error: 'Current password is incorrect' });
      if (newPassword) await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=?,password=? WHERE id=?', [name,email,notification_email||'',phone||null,bcrypt.hashSync(newPassword,10),uid]);
      else await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=? WHERE id=?', [name,email,notification_email||'',phone||null,uid]);
    } else {
      await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=? WHERE id=?', [name,email,notification_email||'',phone||null,uid]);
    }
    if (profileImage !== undefined) await db.query('UPDATE users SET profile_image=? WHERE id=?', [profileImage||null, uid]);
    req.session.name = name;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/profile/image', requireAuth, async (req, res) => {
  try {
    await db.query('UPDATE users SET profile_image=? WHERE id=?', [req.body.image||null, req.session.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// COMMENTS
// ══════════════════════════════════════════════════════
app.get('/api/comments/:type/:taskId', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT tc.id,tc.comment,tc.created_at,u.name AS userName FROM task_comments tc JOIN users u ON tc.user_id=u.id WHERE tc.task_id=? AND tc.task_type=? ORDER BY tc.created_at ASC`, [req.params.taskId, req.params.type]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/comments', requireAuth, async (req, res) => {
  try {
    const { taskId, taskType, comment } = req.body;
    if (!comment || !taskId || !taskType) return res.status(400).json({ error: 'All fields required' });
    await db.query('INSERT INTO task_comments (task_id,task_type,user_id,comment) VALUES (?,?,?,?)', [taskId, taskType, req.session.userId, comment]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM task_comments WHERE id=?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    if (rows[0].user_id !== req.session.userId && req.session.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
    await db.query('DELETE FROM task_comments WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// FMS ADMIN APIs
// ══════════════════════════════════════════════════════

app.get('/api/fms', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [sheets] = await db.query(`SELECT f.*,u.name AS createdByName FROM fms_sheets f JOIN users u ON f.created_by=u.id ORDER BY f.created_at DESC`);
    res.json(sheets);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// IMPORTANT: This route must be defined BEFORE /api/fms/:id
// to avoid being captured by the :id parameter wildcard.
// Get unique values from a specific column of a Google Sheet
// Used by FMS admin to auto-populate Step Doers from Doer Name column
// Query: ?sheetId=...&tabName=...&col=E&headerRow=1
app.get('/api/fms/sheet-column-values', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { sheetId, tabName, col, headerRow } = req.query;
    if (!sheetId || !col) return res.status(400).json({ error: 'sheetId and col required' });

    const colIdx = colToIdx(col);
    if (colIdx < 0) return res.status(400).json({ error: 'Invalid column letter' });

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const spreadsheetId = extractSpreadsheetId(sheetId);
    const tab = tabName || 'Sheet1';
    const headerIdx = (parseInt(headerRow) || 1) - 1;

    const range = `${tab}!${col}:${col}`;
    const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
    const values = response.data.values || [];

    // Skip header row(s), collect unique non-empty values
    const dataValues = values.slice(headerIdx + 1).map(r => (r[0] || '').trim()).filter(v => v);
    const uniqueNames = [...new Set(dataValues)];

    // Match each name with DB users (case-insensitive exact match)
    const [allUsers] = await db.query('SELECT id, name, email, role FROM users');
    const matched = [];
    const unmatched = [];
    for (const sheetName of uniqueNames) {
      const user = allUsers.find(u => u.name.trim().toLowerCase() === sheetName.toLowerCase());
      if (user) {
        matched.push({ sheet_name: sheetName, user_id: user.id, user_name: user.name, email: user.email });
      } else {
        unmatched.push(sheetName);
      }
    }

    res.json({
      total_unique: uniqueNames.length,
      matched_count: matched.length,
      unmatched_count: unmatched.length,
      matched,
      unmatched,
      all_unique: uniqueNames
    });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Sheet access denied. Share with service account.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found.' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fms/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.id]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC', [req.params.id]);
    for (const step of steps) {
      const [doers] = await db.query(`SELECT fsd.user_id,u.name FROM fms_step_doers fsd JOIN users u ON fsd.user_id=u.id WHERE fsd.step_id=?`, [step.id]);
      step.doers = doers;
      const [extraRows] = await db.query('SELECT * FROM fms_extra_rows WHERE step_id=? ORDER BY id ASC', [step.id]);
      step.extraRows = extraRows;
      try { step.show_cols_parsed = JSON.parse(step.show_cols || '[]'); } catch(e) { step.show_cols_parsed = []; }
    }
    res.json({ sheet: sheets[0], steps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fms', requireAuth, requireAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { fmsName, sheetName, sheetId, headerRow, totalSteps, steps } = req.body;
    const [result] = await conn.query(
      `INSERT INTO fms_sheets (fms_name,sheet_name,sheet_id,header_row,total_steps,created_by) VALUES (?,?,?,?,?,?)`,
      [fmsName||sheetName, sheetName, sheetId, headerRow||1, totalSteps||1, req.session.userId]
    );
    const fmsId = result.insertId;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const [sr] = await conn.query(
        `INSERT INTO fms_steps (fms_id,step_order,step_name,plan_col,actual_col,extra_input,extra_col,show_cols,delay_reason_col,doer_name_col) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [fmsId,i+1,s.stepName,s.planCol||'',s.actualCol||'',s.extraInput||'no',s.extraCol||'',JSON.stringify(s.showCols||[]),s.delayReasonCol||'',s.doerNameCol||'']
      );
      const stepId = sr.insertId;
      if (s.doers?.length) for (const uid of s.doers) await conn.query('INSERT INTO fms_step_doers (step_id,user_id) VALUES (?,?)', [stepId, uid]);
      if (s.extraInput==='yes' && s.extraRows?.length) for (const row of s.extraRows) await conn.query('INSERT INTO fms_extra_rows (step_id,row_label,col_letter,field_type,dropdown_options,required) VALUES (?,?,?,?,?,?)', [stepId, row.label||row.col_letter||'', row.col_letter||'', row.field_type||'text', row.dropdown_options||'', row.required===false||row.required===0?0:1]);
    }
    await conn.commit();
    res.json({ success: true, id: fmsId });
  } catch (err) { await conn.rollback(); res.status(500).json({ error: err.message }); } finally { conn.release(); }
});

app.put('/api/fms/:id', requireAuth, requireAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { fmsName, sheetName, sheetId, headerRow, steps } = req.body;
    await conn.query(`UPDATE fms_sheets SET fms_name=?,sheet_name=?,sheet_id=?,header_row=?,total_steps=? WHERE id=?`, [fmsName||sheetName, sheetName, sheetId, headerRow||1, steps.length, req.params.id]);
    const [oldSteps] = await conn.query('SELECT id FROM fms_steps WHERE fms_id=?', [req.params.id]);
    for (const os of oldSteps) {
      await conn.query('DELETE FROM fms_step_doers WHERE step_id=?', [os.id]);
      await conn.query('DELETE FROM fms_extra_rows WHERE step_id=?', [os.id]);
    }
    await conn.query('DELETE FROM fms_steps WHERE fms_id=?', [req.params.id]);
    for (let i=0; i<steps.length; i++) {
      const s = steps[i];
      const [sr] = await conn.query(
        `INSERT INTO fms_steps (fms_id,step_order,step_name,plan_col,actual_col,extra_input,extra_col,show_cols,delay_reason_col,doer_name_col) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id,i+1,s.stepName,s.planCol||'',s.actualCol||'',s.extraInput||'no',s.extraCol||'',JSON.stringify(s.showCols||[]),s.delayReasonCol||'',s.doerNameCol||'']
      );
      const stepId = sr.insertId;
      if (s.doers?.length) for (const uid of s.doers) await conn.query('INSERT INTO fms_step_doers (step_id,user_id) VALUES (?,?)', [stepId, uid]);
      if (s.extraInput==='yes' && s.extraRows?.length) for (const row of s.extraRows) await conn.query('INSERT INTO fms_extra_rows (step_id,row_label,col_letter,field_type,dropdown_options,required) VALUES (?,?,?,?,?,?)', [stepId, row.label||row.col_letter||'', row.col_letter||'', row.field_type||'text', row.dropdown_options||'', row.required===false||row.required===0?0:1]);
    }
    await conn.commit();
    res.json({ success: true });
  } catch (err) { await conn.rollback(); res.status(500).json({ error: err.message }); } finally { conn.release(); }
});

app.delete('/api/fms/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM fms_sheets WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fetch headers ONLY (fast — just one row from sheet) ──
app.post('/api/fms/fetch-headers', requireAuth, async (req, res) => {
  try {
    const { sheetId, sheetName, headerRow } = req.body;
    if (!sheetId) return res.status(400).json({ error: 'sheetId required' });
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const spreadsheetId = extractSpreadsheetId(sheetId);
    const hRow = parseInt(headerRow) || 1;
    // Fetch ONLY the header row — very fast even for 10000-row sheets
    const range = sheetName ? `${sheetName}!${hRow}:${hRow}` : `${hRow}:${hRow}`;
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId, range,
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const rawHeaders = (response.data.values || [[]])[0] || [];
    const headers = rawHeaders
      .map((h, i) => ({
        name: String(h ?? '').trim() || `COL_${idxToCol(i)}`,
        col: idxToCol(i),
        index: i
      }))
      .filter(h => String(h.name).trim().length > 0);
    res.json({ headers });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied. Share sheet with service account.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found. Check Sheet ID.' });
    res.status(500).json({ error: err.message });
  }
});

// ── Sync data (full) — FIX: now uses sheet.sheet_name as tab name ──
app.get('/api/fms/:id/sync', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.id]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const sheet = sheets[0];
    const headerRowIdx = (sheet.header_row || 1) - 1;
    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
    // ✅ FIXED: use sheet.sheet_name (actual tab name) instead of hardcoded 'Sheet1'
    const tabName = sheet.sheet_name || 'Sheet1';
    const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: tabName });
    const allRows = response.data.values || [];
    if (allRows.length <= headerRowIdx) {
      return res.status(400).json({ error: `Sheet has only ${allRows.length} rows but header row is set to ${sheet.header_row}` });
    }
    const headers = allRows[headerRowIdx].filter(h => h && h.trim());
    const dataRows = allRows.slice(headerRowIdx + 1);
    // Return ALL data rows
    res.json({ success: true, headers, totalRows: dataRows.length, headerRow: sheet.header_row, sample: dataRows });
  } catch (err) {
    if (err.message?.includes('ENOENT') || err.message?.includes('credentials')) return res.status(500).json({ error: 'credentials.json not found.' });
    if (err.code === 403) return res.status(400).json({ error: 'Access denied. Share sheet with service account.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found. Check Sheet ID.' });
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// FMS TASKS APIs (all users)
// ══════════════════════════════════════════════════════

// List FMS visible to user
app.get('/api/fms-tasks', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const isAdmin = req.session.role === 'admin';
    let list;
    if (isAdmin) {
      [list] = await db.query('SELECT * FROM fms_sheets ORDER BY created_at DESC');
    } else {
      [list] = await db.query(`SELECT DISTINCT fs.* FROM fms_sheets fs JOIN fms_steps fst ON fst.fms_id=fs.id JOIN fms_step_doers fsd ON fsd.step_id=fst.id WHERE fsd.user_id=? ORDER BY fs.created_at DESC`, [uid]);
    }
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get FMS steps for tasks view
app.get('/api/fms-tasks/:id', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const isAdmin = req.session.role === 'admin';
    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.id]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC', [req.params.id]);
    for (const step of steps) {
      const [doers] = await db.query(`SELECT fsd.user_id,u.name FROM fms_step_doers fsd JOIN users u ON fsd.user_id=u.id WHERE fsd.step_id=?`, [step.id]);
      step.doers = doers;
      step.isMyStep = isAdmin || doers.some(d => d.user_id === uid);
      try { step.show_cols_parsed = JSON.parse(step.show_cols||'[]'); } catch(e) { step.show_cols_parsed = []; }
      const [extraRows] = await db.query('SELECT * FROM fms_extra_rows WHERE step_id=? ORDER BY id ASC', [step.id]);
      step.extraRows = extraRows;
    }
    res.json({ sheet: sheets[0], steps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get pending rows for a step (plan filled, actual empty)
app.get('/api/fms-tasks/:fmsId/steps/:stepId/rows', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.session.role === 'admin';
    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.fmsId]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const sheet = sheets[0];
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE id=? AND fms_id=?', [req.params.stepId, req.params.fmsId]);
    if (!steps[0]) return res.status(404).json({ error: 'Step not found' });
    const step = steps[0];

    // Get current user's name for doer filtering
    const [[currentUser]] = await db.query('SELECT name FROM users WHERE id=?', [req.session.userId]);
    const myName = (currentUser?.name || '').trim().toLowerCase();

    const planIdx = colToIdx(step.plan_col);
    const actualIdx = colToIdx(step.actual_col);
    const doerNameIdx = step.doer_name_col ? colToIdx(step.doer_name_col) : -1;
    let showCols = [];
    try { showCols = JSON.parse(step.show_cols||'[]'); } catch(e) {}

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
    const tabName = sheet.sheet_name || 'Sheet1';

    // Optimized: fetch only up to the furthest needed column (include doerNameIdx if set)
    const maxIdx = Math.max(planIdx, actualIdx, doerNameIdx, ...(showCols.length ? showCols : [0]));
    const lastCol = maxIdx >= 0 ? idxToCol(maxIdx) : 'Z';
    const range = `${tabName}!A:${lastCol}`;

    const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
    const allRows = response.data.values || [];
    const headerRowIdx = (sheet.header_row || 1) - 1;
    const headers = allRows[headerRowIdx] || [];
    const dataRows = allRows.slice(headerRowIdx + 1);

    // Doer filtering: non-admins see only their rows; admins see all
    const applyDoerFilter = !isAdmin && doerNameIdx >= 0 && myName;

    const matchedRows = [];
    let totalPending = 0;       // total pending in this step (for admin info)
    let assignedToMe = 0;       // assigned to current user
    dataRows.forEach((row, i) => {
      const planVal = planIdx >= 0 ? (row[planIdx]||'').trim() : '';
      const actualVal = actualIdx >= 0 ? (row[actualIdx]||'').trim() : '';
      if (!planVal || actualVal) return; // skip non-pending rows
      totalPending++;

      // Check doer name match (case-insensitive exact)
      const rowDoer = doerNameIdx >= 0 ? (row[doerNameIdx]||'').trim() : '';
      const rowDoerLower = rowDoer.toLowerCase();
      const isMine = rowDoerLower === myName;
      if (isMine) assignedToMe++;

      // For non-admin, skip rows that don't belong to them
      if (applyDoerFilter && !isMine) return;

      const rowData = {};
      let colsToShow = showCols.length ? showCols : headers.map((_,hi) => hi);
      // Always show the plan column — it is mandatory
      if (planIdx >= 0 && !colsToShow.includes(planIdx)) colsToShow = [planIdx, ...colsToShow];
      colsToShow.forEach(ci => {
        const h = headers[ci] || `COL ${idxToCol(ci)}`;
        rowData[h] = row[ci] || '';
      });
      matchedRows.push({
        sheetRowNumber: headerRowIdx + 1 + i + 1,
        planValue: planVal,
        actualValue: actualVal,
        rowDoerName: rowDoer,
        isMine,
        data: rowData
      });
    });

    res.json({
      rows: matchedRows,
      headers,
      total: matchedRows.length,
      totalPending,
      assignedToMe,
      filtered: applyDoerFilter,
      doerColumn: step.doer_name_col || null,
      isAdmin
    });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied.' });
    if (err.code === 404) return res.status(400).json({ error: 'Sheet not found.' });
    res.status(500).json({ error: err.message });
  }
});

// Mark row as done — writes actual (full timestamp) + delay reason to sheet
app.post('/api/fms-tasks/:fmsId/steps/:stepId/done', requireAuth, async (req, res) => {
  try {
    const { rowNumber, actualValue, delayReason, extraInputs } = req.body;
    if (!rowNumber || !actualValue) return res.status(400).json({ error: 'rowNumber and actualValue required' });

    // IST timestamp — written as a Google-Sheets serial date-number, not as a TEXT string.
    // Reason: when a text string ("DD/MM/YYYY HH:mm:ss") is written, Sheets parses it according to the
    // spreadsheet LOCALE. Under en_US (MM/DD/YYYY), timestamps with a day > 12 (e.g. 14/07/2026)
    // become invalid dates and Sheets stores them as plain TEXT — which is why later date-math
    // formulas (HOUR/DATEVALUE/ADD etc.) return #VALUE! on that cell. A raw serial number is
    // locale-independent, so it is always stored as a real date-time.
    const istNow = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
    const fullTimestamp = Date.UTC(
      istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(),
      istNow.getUTCHours(), istNow.getUTCMinutes(), istNow.getUTCSeconds()
    ) / 86400000 + 25569; // 25569 = days between Sheets epoch (30 Dec 1899) aur Unix epoch (1 Jan 1970)

    const [sheets] = await db.query('SELECT * FROM fms_sheets WHERE id=?', [req.params.fmsId]);
    if (!sheets[0]) return res.status(404).json({ error: 'FMS not found' });
    const sheet = sheets[0];
    const [steps] = await db.query('SELECT * FROM fms_steps WHERE id=? AND fms_id=?', [req.params.stepId, req.params.fmsId]);
    if (!steps[0]) return res.status(404).json({ error: 'Step not found' });
    const step = steps[0];

    const actualCol = (step.actual_col||'').toUpperCase();
    if (!actualCol) return res.status(400).json({ error: 'Actual column not configured for this step' });

    const sheetsApi = await getSheetsClient(['https://www.googleapis.com/auth/spreadsheets']);
    const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
    const tabName = sheet.sheet_name || 'Sheet1';

    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!${actualCol}${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[fullTimestamp]] }
    });

    if (delayReason && step.delay_reason_col) {
      const drCol = step.delay_reason_col.toUpperCase();
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!${drCol}${rowNumber}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[delayReason]] }
      });
    }

    // Write extra input values to their respective columns
    if (extraInputs && extraInputs.length) {
      for (const ei of extraInputs) {
        if (ei.colLetter && ei.value !== undefined && ei.value !== '') {
          await sheetsApi.spreadsheets.values.update({
            spreadsheetId,
            range: `${tabName}!${ei.colLetter.toUpperCase()}${rowNumber}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[ei.value]] }
          });
        }
      }
    }

    // Write the doer's name into the sheet (when doer_name_col is configured)
    if (step.doer_name_col) {
      const [userRows] = await db.query('SELECT name FROM users WHERE id=? LIMIT 1', [req.session.userId]);
      const doerName = userRows[0]?.name || '';
      if (doerName) {
        await sheetsApi.spreadsheets.values.update({
          spreadsheetId,
          range: `${tabName}!${step.doer_name_col.toUpperCase()}${rowNumber}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[doerName]] }
        });
      }
    }

    res.json({ success: true });
  } catch (err) {
    if (err.code === 403) return res.status(400).json({ error: 'Access denied. Sheet write permission needed.' });
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// TASK TRANSFERS
// ══════════════════════════════════════════════════════

// POST — Create transfer request (user/hod/admin)
app.post('/api/transfers', requireAuth, async (req, res) => {
  try {
    const { tasks, toUserId } = req.body;
    // tasks = [{taskId, taskType}]
    if (!tasks || !tasks.length || !toUserId)
      return res.status(400).json({ error: 'Tasks and target user required' });

    const uid = req.session.userId;
    const role = req.session.role;

    // Validate each task — user can only transfer their own, HOD dept, admin any
    for (const t of tasks) {
      const table = getTable(t.taskType);
      const [rows] = await db.query(`SELECT * FROM ${table} WHERE id=?`, [t.taskId]);
      if (!rows[0]) return res.status(404).json({ error: `Task ${t.taskId} not found` });
      const task = rows[0];

      if (role === 'user' && task.assigned_to !== uid)
        return res.status(403).json({ error: 'You can only transfer your own tasks' });

      if (role === 'hod') {
        const [taskUser] = await db.query('SELECT department FROM users WHERE id=?', [task.assigned_to]);
        const [hodUser] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
        if (taskUser[0]?.department !== hodUser[0]?.department)
          return res.status(403).json({ error: 'HOD can only transfer tasks of their department' });
      }
    }

    // Insert transfer requests — skip if already pending
    let inserted = 0, skipped = 0;
    for (const t of tasks) {
      const table = getTable(t.taskType);
      const [rows] = await db.query(`SELECT assigned_to FROM ${table} WHERE id=?`, [t.taskId]);
      const fromUser = rows[0].assigned_to;
      const [existing] = await db.query(
        `SELECT id FROM task_transfers WHERE task_id=? AND task_type=? AND status='pending'`,
        [t.taskId, t.taskType]
      );
      if (existing[0]) { skipped++; continue; }
      await db.query(
        `INSERT INTO task_transfers (task_id, task_type, from_user, to_user, requested_by, status) VALUES (?,?,?,?,?,'pending')`,
        [t.taskId, t.taskType, fromUser, toUserId, uid]
      );
      inserted++;
    }

    res.json({ success: true, count: inserted, skipped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — Task IDs that already have a pending transfer (for current user's tasks)
app.get('/api/transfers/pending-tasks', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT task_id, task_type FROM task_transfers WHERE status='pending' AND requested_by=?`,
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — Pending transfers for approval (admin sees all, HOD sees dept)
app.get('/api/transfers', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    let deptFilter = '';
    let params = [];

    if (role === 'hod') {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      // HOD sees transfers of users in their department
      const [deptUsers] = await db.query('SELECT id FROM users WHERE department=?', [dept]);
      if (!deptUsers.length) return res.json([]);
      const ids = deptUsers.map(u=>u.id);
      deptFilter = `AND (tt.from_user IN (${ids.map(()=>'?').join(',')}) OR tt.to_user IN (${ids.map(()=>'?').join(',')}))`;
      params = [...ids, ...ids];
    }

    const [rows] = await db.query(`
      SELECT tt.*,
        uf.name AS fromUserName, ut.name AS toUserName,
        ur.name AS requestedByName,
        u_from.department AS fromDept
      FROM task_transfers tt
      JOIN users uf ON tt.from_user = uf.id
      JOIN users ut ON tt.to_user = ut.id
      JOIN users ur ON tt.requested_by = ur.id
      JOIN users u_from ON tt.from_user = u_from.id
      WHERE tt.status = 'pending' ${deptFilter}
      ORDER BY tt.created_at DESC`, params);

    // Attach task description
    for (const r of rows) {
      const table = getTable(r.task_type);
      const [t] = await db.query(`SELECT description, DATE_FORMAT(due_date,'%Y-%m-%d') AS due_date FROM ${table} WHERE id=?`, [r.task_id]);
      r.description = t[0]?.description || '—';
      r.due_date = t[0]?.due_date || '—';
    }

    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — Transfer count for badge
app.get('/api/transfers/count', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    let count = 0;
    if (role === 'admin') {
      const [r] = await db.query(`SELECT COUNT(*) AS c FROM task_transfers WHERE status='pending'`);
      count = r[0].c;
    } else {
      const [me] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      const [deptUsers] = await db.query('SELECT id FROM users WHERE department=?', [dept]);
      if (deptUsers.length) {
        const ids = deptUsers.map(u=>u.id);
        const [r] = await db.query(`SELECT COUNT(*) AS c FROM task_transfers WHERE status='pending' AND (from_user IN (${ids.map(()=>'?').join(',')}) OR to_user IN (${ids.map(()=>'?').join(',')}))`, [...ids,...ids]);
        count = r[0].c;
      }
    }
    res.json({ count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT — Approve or reject transfer
app.put('/api/transfers/:id', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { action, note } = req.body; // action: 'approved' | 'rejected'
    const [rows] = await db.query('SELECT * FROM task_transfers WHERE id=?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Transfer not found' });
    const tr = rows[0];

    await db.query('UPDATE task_transfers SET status=?, note=? WHERE id=?', [action, note||'', req.params.id]);

    if (action === 'approved') {
      const table = getTable(tr.task_type);
      await db.query(`UPDATE ${table} SET assigned_to=? WHERE id=?`, [tr.to_user, tr.task_id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — My sent transfer requests (for users to track)
app.get('/api/transfers/my', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT tt.*, uf.name AS fromUserName, ut.name AS toUserName
      FROM task_transfers tt
      JOIN users uf ON tt.from_user = uf.id
      JOIN users ut ON tt.to_user = ut.id
      WHERE tt.requested_by=?
      ORDER BY tt.created_at DESC LIMIT 20`, [req.session.userId]);
    for (const r of rows) {
      const table = getTable(r.task_type);
      const [t] = await db.query(`SELECT description FROM ${table} WHERE id=?`, [r.task_id]);
      r.description = t[0]?.description || '—';
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// MEETINGS
// Ported from the e-marketing task manager. Two things are deliberately left
// out: Google-Meet auto-link creation (needs Workspace domain-wide delegation,
// which this project is not set up for — paste a link instead) and WhatsApp
// invites (the queue cannot survive a serverless request). Everything else —
// scheduling, availability slots, recurrence, attendees — is here.
// ══════════════════════════════════════════════════════
// Working window for the availability grid, in minutes from midnight, so a
// half-hour start (8:30) is expressible. Last slot ends exactly at endMin.
const MEETING_BIZ_HOURS = { startMin: 8 * 60 + 30, endMin: 19 * 60, slotMin: 30 };

// Saturday is a working day here EXCEPT the last one of the month, which
// matches the rule the rest of the app uses for off-days.
function isLastSaturdayOfMonth(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (d.getUTCDay() !== 6) return false;
  const next = new Date(d.getTime() + 7 * 24 * 60 * 60 * 1000);
  return next.getUTCMonth() !== d.getUTCMonth();
}

// Builds the half-hour grid for a day and marks what is taken.
// A slot is "booked" only when the VIEWER is in that meeting — other people's
// calendars must not grey out your own. busyUserIds is still recorded for
// everyone so the attendee picker can warn about clashes.
async function buildMeetingSlots(dateStr, userIds = [], viewerId = null) {
  const slots = [];
  const { startMin, endMin, slotMin } = MEETING_BIZ_HOURS;
  const hhmm = t => String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  for (let t = startMin; t + slotMin <= endMin; t += slotMin) {
    slots.push({ start: hhmm(t), end: hhmm(t + slotMin), booked: false, busyUserIds: [] });
  }
  const [meetings] = await db.query(
    `SELECT m.id, m.title, TIME_FORMAT(m.start_time,'%H:%i') AS start_time,
            TIME_FORMAT(m.end_time,'%H:%i') AS end_time, m.organizer_id
       FROM meetings m
      WHERE m.meeting_date = ? AND m.status = 'scheduled'`, [dateStr]);

  const busyRanges = {};
  if (meetings.length) {
    const mIds = meetings.map(m => m.id);
    const [attendees] = await db.query(
      `SELECT meeting_id, user_id FROM meeting_attendees WHERE meeting_id IN (${mIds.map(() => '?').join(',')})`, mIds);
    const attByMtg = {};
    for (const a of attendees) (attByMtg[a.meeting_id] = attByMtg[a.meeting_id] || []).push(a.user_id);
    for (const m of meetings) {
      const involved = new Set([m.organizer_id, ...(attByMtg[m.id] || [])]);
      const viewerInvolved = viewerId != null && involved.has(viewerId);
      for (const slot of slots) {
        if (slot.start < m.end_time && slot.end > m.start_time) {
          if (viewerInvolved) slot.booked = true;
          for (const uid of involved) if (!slot.busyUserIds.includes(uid)) slot.busyUserIds.push(uid);
        }
      }
      for (const uid of involved) {
        if (userIds.length && !userIds.includes(uid)) continue;
        (busyRanges[uid] = busyRanges[uid] || []).push({ start: m.start_time, end: m.end_time, title: m.title });
      }
    }
  }
  if (userIds.length) {
    for (const slot of slots) slot.conflictForSelection = slot.busyUserIds.some(uid => userIds.includes(uid));
  }
  return { slots, busyRanges };
}

// Expands a recurrence rule into dates. Capped so a mistyped "repeat until
// 2099" cannot spawn thousands of rows.
const RECURRENCE_MAX_OCCURRENCES = 120;
function generateRecurrenceDates(startDateStr, frequency, untilStr, customDays) {
  const start = new Date(startDateStr + 'T00:00:00Z');
  const until = new Date(untilStr + 'T00:00:00Z');
  const dates = [];
  if (until < start) return dates;
  if (frequency === 'monthly') {
    const cur = new Date(start);
    while (cur <= until && dates.length < RECURRENCE_MAX_OCCURRENCES) {
      dates.push(cur.toISOString().split('T')[0]);
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    return dates;
  }
  const customSet = new Set((customDays || []).map(d => parseInt(d, 10)));
  const startDow = start.getUTCDay();
  const cur = new Date(start);
  while (cur <= until && dates.length < RECURRENCE_MAX_OCCURRENCES) {
    const dow = cur.getUTCDay();
    let include = false;
    if (frequency === 'daily') include = true;
    else if (frequency === 'weekday') include = dow !== 0;
    else if (frequency === 'weekly') include = dow === startDow;
    else if (frequency === 'custom') include = customSet.has(dow);
    if (include) dates.push(cur.toISOString().split('T')[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// Only the organiser or an admin may change a meeting.
async function loadMeetingForWrite(id, req, res) {
  const [[m]] = await db.query('SELECT id, organizer_id FROM meetings WHERE id=?', [id]);
  if (!m) { res.status(404).json({ error: 'Meeting not found' }); return null; }
  if (m.organizer_id !== req.session.userId && req.session.role !== 'admin') {
    res.status(403).json({ error: 'Only the organiser or an admin can change this meeting' });
    return null;
  }
  return m;
}

// GET — meetings the caller organises or is invited to.
app.get('/api/meetings', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const { from, to, status, organizer } = req.query;
    // Admin oversees every meeting; everyone else sees only their own —
    // the ones they organise or were invited to.
    const isAdmin = req.session.role === 'admin';
    let where = isAdmin ? '1=1' : `(m.organizer_id = ? OR EXISTS
      (SELECT 1 FROM meeting_attendees ma WHERE ma.meeting_id = m.id AND ma.user_id = ?))`;
    const params = isAdmin ? [] : [uid, uid];
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { where += ' AND m.meeting_date >= ?'; params.push(from); }
    if (to   && /^\d{4}-\d{2}-\d{2}$/.test(to))   { where += ' AND m.meeting_date <= ?'; params.push(to); }
    if (status) { where += ' AND m.status = ?'; params.push(status); }
    if (organizer && organizer !== 'all') { where += ' AND m.organizer_id = ?'; params.push(organizer); }

    const [rows] = await db.query(
      `SELECT m.id, m.title, m.agenda, m.client_id, m.organizer_id,
              DATE_FORMAT(m.meeting_date,'%Y-%m-%d') AS meeting_date,
              TIME_FORMAT(m.start_time,'%H:%i') AS start_time,
              TIME_FORMAT(m.end_time,'%H:%i')   AS end_time,
              m.meet_link, m.status, m.created_at,
              c.name AS client_name, u.name AS organizer_name
         FROM meetings m
         LEFT JOIN clients c ON m.client_id = c.id
         LEFT JOIN users   u ON m.organizer_id = u.id
        WHERE ${where}
        ORDER BY m.meeting_date ASC, m.start_time ASC
        LIMIT 500`, params);

    // Attendees in one extra query rather than one per meeting.
    if (rows.length) {
      const ids = rows.map(r => r.id);
      const [atts] = await db.query(
        `SELECT ma.meeting_id, ma.user_id, u.name
           FROM meeting_attendees ma JOIN users u ON ma.user_id = u.id
          WHERE ma.meeting_id IN (${ids.map(() => '?').join(',')})`, ids);
      const byMtg = {};
      for (const a of atts) (byMtg[a.meeting_id] = byMtg[a.meeting_id] || []).push({ id: a.user_id, name: a.name });
      for (const r of rows) r.attendees = byMtg[r.id] || [];
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — availability grid for one date.
app.get('/api/meetings/slots', requireAuth, async (req, res) => {
  try {
    const date = req.query.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
    const userIds = String(req.query.userIds || '')
      .split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n > 0);

    const holidays = await loadHolidaysSet();
    const d = new Date(date + 'T00:00:00Z');
    let offReason = null;
    if (d.getUTCDay() === 0) offReason = 'Sunday';
    else if (isLastSaturdayOfMonth(date)) offReason = 'Last Saturday (off)';
    else if (holidays.has(date)) offReason = 'Holiday';
    if (offReason) return res.json({ date, off: true, reason: offReason, slots: [], busyRanges: {} });

    const { slots, busyRanges } = await buildMeetingSlots(date, userIds, req.session.userId);
    res.json({ date, off: false, slots, busyRanges });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — one meeting with its attendees.
app.get('/api/meetings/:id', requireAuth, async (req, res) => {
  try {
    const [[m]] = await db.query(
      `SELECT m.id, m.title, m.agenda, m.client_id, m.organizer_id,
              DATE_FORMAT(m.meeting_date,'%Y-%m-%d') AS meeting_date,
              TIME_FORMAT(m.start_time,'%H:%i') AS start_time,
              TIME_FORMAT(m.end_time,'%H:%i')   AS end_time,
              m.meet_link, m.status,
              c.name AS client_name, u.name AS organizer_name
         FROM meetings m
         LEFT JOIN clients c ON m.client_id = c.id
         LEFT JOIN users   u ON m.organizer_id = u.id
        WHERE m.id = ?`, [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Meeting not found' });
    const [atts] = await db.query(
      `SELECT u.id, u.name, u.email FROM meeting_attendees ma
         JOIN users u ON ma.user_id = u.id WHERE ma.meeting_id = ?`, [req.params.id]);
    m.attendees = atts;
    res.json(m);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST — create one meeting, or a whole recurring series.
app.post('/api/meetings', requireAuth, async (req, res) => {
  try {
    const { title, agenda, client_id, meeting_date, start_time, end_time, meet_link,
            attendee_ids, frequency, repeat_until, repeat_days } = req.body;
    if (!title || !meeting_date || !start_time || !end_time) {
      return res.status(400).json({ error: 'Title, date, start time and end time are required' });
    }
    if (end_time <= start_time) return res.status(400).json({ error: 'End time must be after the start time' });

    const organizerId = req.session.userId;
    const freq = ['daily', 'weekday', 'weekly', 'monthly', 'custom'].includes(frequency) ? frequency : null;
    let occurrenceDates = [meeting_date];
    if (freq) {
      if (!repeat_until) return res.status(400).json({ error: 'Pick a "repeat until" date for a recurring meeting' });
      if (freq === 'custom' && !(Array.isArray(repeat_days) && repeat_days.length)) {
        return res.status(400).json({ error: 'Select at least one day to repeat on' });
      }
      occurrenceDates = generateRecurrenceDates(meeting_date, freq, repeat_until, repeat_days);
      if (!occurrenceDates.length) return res.status(400).json({ error: 'No occurrences fall in the selected range' });
    }

    const attIds = (Array.isArray(attendee_ids) ? attendee_ids : [])
      .map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0);

    const newIds = [];
    for (const dateStr of occurrenceDates) {
      const [r] = await db.query(
        `INSERT INTO meetings (title, agenda, client_id, organizer_id, meeting_date, start_time, end_time, meet_link)
         VALUES (?,?,?,?,?,?,?,?)`,
        [title, agenda || null, client_id || null, organizerId, dateStr, start_time, end_time, meet_link || null]);
      newIds.push(r.insertId);
      for (const uid of attIds) {
        await db.query('INSERT IGNORE INTO meeting_attendees (meeting_id, user_id) VALUES (?,?)', [r.insertId, uid]);
      }
    }
    res.json({ ok: true, id: newIds[0], count: newIds.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT — edit a meeting and replace its attendee list.
app.put('/api/meetings/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    if (!await loadMeetingForWrite(id, req, res)) return;
    const { title, agenda, client_id, meeting_date, start_time, end_time, meet_link, attendee_ids } = req.body;
    if (!title || !meeting_date || !start_time || !end_time) {
      return res.status(400).json({ error: 'Title, date, start time and end time are required' });
    }
    if (end_time <= start_time) return res.status(400).json({ error: 'End time must be after the start time' });

    await db.query(
      `UPDATE meetings SET title=?, agenda=?, client_id=?, meeting_date=?, start_time=?, end_time=?, meet_link=?
        WHERE id=?`,
      [title, agenda || null, client_id || null, meeting_date, start_time, end_time, meet_link || null, id]);

    if (Array.isArray(attendee_ids)) {
      await db.query('DELETE FROM meeting_attendees WHERE meeting_id=?', [id]);
      for (const uid of attendee_ids.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0)) {
        await db.query('INSERT IGNORE INTO meeting_attendees (meeting_id, user_id) VALUES (?,?)', [id, uid]);
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT — mark scheduled / done / cancelled. The Employee 360 meetings score
// is done/total, so this is what moves that number.
app.put('/api/meetings/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['scheduled', 'done', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    if (!await loadMeetingForWrite(req.params.id, req, res)) return;
    await db.query('UPDATE meetings SET status=? WHERE id=?', [status, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE — cancels rather than removes, so the history stays in the scorecard.
app.delete('/api/meetings/:id', requireAuth, async (req, res) => {
  try {
    if (!await loadMeetingForWrite(req.params.id, req, res)) return;
    await db.query("UPDATE meetings SET status='cancelled' WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// EMPLOYEE 360
// Everything about one employee in one place for an increment review:
// delegation + checklist stats, daily-report compliance, the units they handle,
// meetings, a weighted scorecard, and week-by-week committed vs achieved.
// ══════════════════════════════════════════════════════

// Monday of the week containing `date`, in IST.
function istMondayOf(date) {
  const ist = new Date(date.getTime() + (5.5 * 60 * 60 * 1000));
  const dayUTC = ist.getUTCDay();                 // 0=Sun, 1=Mon..6=Sat
  const diff = (dayUTC === 0 ? -6 : 1 - dayUTC);  // shift back to Monday
  const mon = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + diff));
  return mon.toISOString().split('T')[0];
}
function addDays(yyyyMmDd, n) {
  const d = new Date(yyyyMmDd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

// Weekly performance score, [-100, 0] where 0 is perfect. Deliberately a
// deficit scale: it answers "how much did this week slip", not "how good".
function scoreFor(total, pending, overdue, revised) {
  total = parseInt(total) || 0; pending = parseInt(pending) || 0;
  overdue = parseInt(overdue) || 0; revised = parseInt(revised) || 0;
  if (total <= 0) return null;
  return Math.max(-100, Math.round((0 - (pending / total) * 100 - (overdue / total) * 50 - (revised / total) * 25) * 10) / 10);
}

// admin → anyone; hod/pc → their own department; everyone else → only themselves.
async function canViewComplianceEmployee(req, targetId) {
  const role = req.session.role;
  const uid = req.session.userId;
  if (role === 'admin') return true;
  if (Number(targetId) === Number(uid)) return true;
  if (role === 'hod' || role === 'pc') {
    const [[me]] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
    const [[target]] = await db.query('SELECT department FROM users WHERE id=?', [targetId]);
    return !!me?.department && me.department === target?.department;
  }
  return false;
}

app.get('/api/compliance/employee/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid employee id' });
    if (!await canViewComplianceEmployee(req, id)) return res.status(403).json({ error: 'Not allowed' });

    // Window defaults to the current IST month.
    const ist = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
    const yy = ist.getUTCFullYear(), mm = ist.getUTCMonth();
    const defaultFrom = `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
    const defaultTo = `${yy}-${String(mm + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const from = isDate(req.query.from) ? req.query.from : defaultFrom;
    const to   = isDate(req.query.to)   ? req.query.to   : defaultTo;

    const [[user]] = await db.query(
      `SELECT id, name, email, role, COALESCE(department,'—') AS department,
              COALESCE(week_off,'') AS week_off, COALESCE(extra_off,'') AS extra_off
         FROM users WHERE id=?`, [id]);
    if (!user) return res.status(404).json({ error: 'Employee not found' });

    const N = v => Number(v) || 0;

    // ── Task stats, bucketed by due date inside the window ──
    const [[del]] = await db.query(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status='revised'   THEN 1 ELSE 0 END) AS revised,
        SUM(CASE WHEN status='pending' AND due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
       FROM delegation_tasks WHERE assigned_to=? AND due_date BETWEEN ? AND ?`, [id, from, to]);
    const [[chl]] = await db.query(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status='pending' AND due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
       FROM checklist_tasks WHERE assigned_to=? AND due_date BETWEEN ? AND ?`, [id, from, to]);
    const delegation = { total: N(del.total), pending: N(del.pending), completed: N(del.completed), revised: N(del.revised), overdue: N(del.overdue) };
    const checklist  = { total: N(chl.total), pending: N(chl.pending), completed: N(chl.completed), revised: 0, overdue: N(chl.overdue) };

    // ── Daily-report compliance ──
    const [[dr]] = await db.query(
      `SELECT COUNT(*) AS entries, COALESCE(SUM(duration_min),0) AS minutes,
              COUNT(DISTINCT entry_date) AS days_filled
         FROM daily_tasks WHERE user_id=? AND entry_date BETWEEN ? AND ?`, [id, from, to]);

    // Working days = the window minus Sundays, last Saturdays and holidays.
    const holidaysSet = await loadHolidaysSet();
    let workingDays = 0;
    {
      let cur = new Date(from + 'T00:00:00Z');
      const endU = new Date(to + 'T00:00:00Z');
      let guard = 0;
      while (cur <= endU && guard++ < 1000) {
        const ds = cur.toISOString().split('T')[0];
        const off = cur.getUTCDay() === 0
                 || isLastSaturdayOfMonth(ds)
                 || isUserOffOn(user, ds, holidaysSet);
        if (!off) workingDays++;
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }
    const daysFilled = N(dr.days_filled);
    const dailyReport = {
      entries: N(dr.entries), minutes: N(dr.minutes), hours: Math.round(N(dr.minutes) / 6) / 10,
      daysFilled, workingDays,
      fillPct: workingDays > 0 ? Math.round((daysFilled / workingDays) * 100) : 0
    };
    const [recentEntries] = await db.query(
      `SELECT id, DATE_FORMAT(entry_date,'%Y-%m-%d') AS entry_date,
              client_name, COALESCE(department,'') AS department, description, duration_min
         FROM daily_tasks WHERE user_id=? AND entry_date BETWEEN ? AND ?
        ORDER BY entry_date DESC, id DESC LIMIT 20`, [id, from, to]);

    // ── Units this employee handles, plus what happened on them in the window ──
    const [clientRows] = await db.query(
      `SELECT id, name, COALESCE(is_active,1) AS is_active, logo_url
         FROM clients WHERE handler_id=? ORDER BY COALESCE(is_active,1) DESC, name ASC`, [id]);
    if (clientRows.length) {
      const ids = clientRows.map(c => c.id);
      const ph = ids.map(() => '?').join(',');
      const [dc] = await db.query(
        `SELECT client_id, COUNT(*) AS total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
           FROM delegation_tasks WHERE client_id IN (${ph}) AND due_date BETWEEN ? AND ? GROUP BY client_id`, [...ids, from, to]);
      const [cc] = await db.query(
        `SELECT client_id, COUNT(*) AS total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
           FROM checklist_tasks WHERE client_id IN (${ph}) AND due_date BETWEEN ? AND ? GROUP BY client_id`, [...ids, from, to]);
      const [mc] = await db.query(
        `SELECT client_id, COUNT(*) AS total FROM meetings
          WHERE client_id IN (${ph}) AND meeting_date BETWEEN ? AND ? GROUP BY client_id`, [...ids, from, to]);
      const dMap = Object.fromEntries(dc.map(r => [r.client_id, r]));
      const cMap = Object.fromEntries(cc.map(r => [r.client_id, r]));
      const mMap = Object.fromEntries(mc.map(r => [r.client_id, r]));
      for (const c of clientRows) {
        c.is_active = N(c.is_active);
        const d = dMap[c.id] || {}, k = cMap[c.id] || {}, m = mMap[c.id] || {};
        c.tasks = N(d.total) + N(k.total);
        c.pending = N(d.pending) + N(k.pending);
        c.meetings = N(m.total);
        c.activity = c.tasks + c.meetings;
      }
    }
    const clients = {
      total: clientRows.length,
      active: clientRows.filter(c => c.is_active).length,
      inactive: clientRows.filter(c => !c.is_active).length,
      list: clientRows
    };

    // ── Meetings organised and attended ──
    const [[mo]] = await db.query(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='scheduled' THEN 1 ELSE 0 END) AS scheduled,
        SUM(CASE WHEN status='done'      THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled
       FROM meetings WHERE organizer_id=? AND meeting_date BETWEEN ? AND ?`, [id, from, to]);
    const [[ma]] = await db.query(
      `SELECT COUNT(DISTINCT m.id) AS total
         FROM meetings m JOIN meeting_attendees mt ON mt.meeting_id=m.id
        WHERE mt.user_id=? AND m.meeting_date BETWEEN ? AND ?`, [id, from, to]);
    const [mtgRecent] = await db.query(
      `SELECT m.id, m.title, m.status,
              DATE_FORMAT(m.meeting_date,'%Y-%m-%d') AS meeting_date,
              TIME_FORMAT(m.start_time,'%H:%i') AS start_time,
              c.name AS client_name,
              CASE WHEN m.organizer_id=? THEN 'Organizer' ELSE 'Attendee' END AS my_role
         FROM meetings m LEFT JOIN clients c ON m.client_id=c.id
        WHERE (m.organizer_id=? OR EXISTS (SELECT 1 FROM meeting_attendees mt WHERE mt.meeting_id=m.id AND mt.user_id=?))
          AND m.meeting_date BETWEEN ? AND ?
        ORDER BY m.meeting_date DESC, m.start_time DESC LIMIT 20`, [id, id, id, from, to]);
    const meetings = {
      organized: { total: N(mo.total), scheduled: N(mo.scheduled), done: N(mo.done), cancelled: N(mo.cancelled) },
      attended: N(ma.total),
      recent: mtgRecent
    };

    // ── Scorecard. Each section 0-100, or null when it does not apply to this
    // employee — a null section is dropped and its weight is shared out among
    // the rest, so nobody is penalised for work they were never given.
    const clamp = n => Math.max(0, Math.min(100, n));
    const r1 = n => Math.round(n * 10) / 10;
    const cat = {
      delegation: delegation.total > 0
        ? r1(clamp((delegation.completed / delegation.total) * 100 - (delegation.overdue / delegation.total) * 30 - (delegation.revised / delegation.total) * 15))
        : null,
      checklist: checklist.total > 0
        ? r1(clamp((checklist.completed / checklist.total) * 100 - (checklist.overdue / checklist.total) * 30))
        : null,
      dailyReport: dailyReport.workingDays > 0 ? r1(clamp(dailyReport.fillPct)) : null,
      meetings: meetings.organized.total > 0 ? r1(clamp((meetings.organized.done / meetings.organized.total) * 100)) : null,
      clients: clients.total > 0 ? r1(clamp((clients.active / clients.total) * 100)) : null
    };
    const weights = { delegation: 30, checklist: 25, dailyReport: 20, meetings: 15, clients: 10 };
    const present = Object.keys(weights).filter(k => cat[k] !== null);
    const average = present.length ? r1(present.reduce((a, k) => a + cat[k], 0) / present.length) : null;
    let wSum = 0, wTot = 0;
    for (const k of present) { wSum += cat[k] * weights[k]; wTot += weights[k]; }
    const final = wTot ? r1(wSum / wTot) : null;
    const grade = final == null ? 'N/A'
      : final >= 85 ? 'Excellent' : final >= 70 ? 'Good' : final >= 50 ? 'Average' : 'Needs Improvement';
    const scores = { categories: cat, weights, average, final, grade };

    // ── Weekly: what they committed on Monday vs what the week actually scored.
    const weekly = [];
    {
      const firstMon = istMondayOf(new Date(from + 'T00:00:00Z'));
      const mondays = [];
      for (let m = firstMon; m <= to; m = addDays(m, 7)) mondays.push(m);
      // One week before the window is loaded purely as the regression baseline.
      const baselineMon = addDays(firstMon, -7);
      const allMons = [baselineMon, ...mondays];
      const rangeStart = baselineMon;
      const rangeEnd = mondays.length ? addDays(mondays[mondays.length - 1], 6) : addDays(baselineMon, 6);

      const [planRows] = await db.query(
        `SELECT DATE_FORMAT(start_date,'%Y-%m-%d') AS mon, user_committed_score
           FROM week_plans WHERE employee_id=? AND start_date IN (${allMons.map(() => '?').join(',')})`,
        [id, ...allMons]);
      const committedBy = {};
      for (const r of planRows) committedBy[r.mon] = r.user_committed_score == null ? null : Number(r.user_committed_score);

      // Bucket tasks by their own Monday in SQL — two grouped queries beat one
      // query per week.
      const wkExpr = `DATE_FORMAT(DATE_SUB(due_date, INTERVAL WEEKDAY(due_date) DAY),'%Y-%m-%d')`;
      const [delWk] = await db.query(
        `SELECT ${wkExpr} AS wk, COUNT(*) AS total,
          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status='revised' THEN 1 ELSE 0 END) AS revised,
          SUM(CASE WHEN status='pending' AND due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
         FROM delegation_tasks WHERE assigned_to=? AND due_date BETWEEN ? AND ? GROUP BY wk`, [id, rangeStart, rangeEnd]);
      const [chlWk] = await db.query(
        `SELECT ${wkExpr} AS wk, COUNT(*) AS total,
          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status='pending' AND due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
         FROM checklist_tasks WHERE assigned_to=? AND due_date BETWEEN ? AND ? GROUP BY wk`, [id, rangeStart, rangeEnd]);

      const agg = {};
      const bump = (wk, t, p, o, r) => {
        const a = agg[wk] || (agg[wk] = { total: 0, pending: 0, overdue: 0, revised: 0 });
        a.total += t; a.pending += p; a.overdue += o; a.revised += r;
      };
      for (const r of delWk) bump(r.wk, N(r.total), N(r.pending), N(r.overdue), N(r.revised));
      for (const r of chlWk) bump(r.wk, N(r.total), N(r.pending), N(r.overdue), 0);

      const achievedBy = {};
      for (const wkMon of allMons) {
        const a = agg[wkMon];
        achievedBy[wkMon] = a ? scoreFor(a.total, a.pending, a.overdue, a.revised) : null;
      }
      for (const wkMon of mondays) {
        const committed = wkMon in committedBy ? committedBy[wkMon] : null;
        const achieved = achievedBy[wkMon];
        const prevAchieved = achievedBy[addDays(wkMon, -7)];
        const wAgg = agg[wkMon] || { total: 0, pending: 0, revised: 0 };
        weekly.push({
          weekStart: wkMon, weekEnd: addDays(wkMon, 6),
          committed, achieved,
          prevAchieved: prevAchieved == null ? null : prevAchieved,
          gap: (committed !== null && achieved !== null) ? Math.round((achieved - committed) * 10) / 10 : null,
          // Committing to less than you already achieved last week.
          regression: committed !== null && prevAchieved != null && committed < prevAchieved,
          taskTotal: wAgg.total,
          taskPending: wAgg.pending,
          taskCompleted: Math.max(0, wAgg.total - wAgg.pending - (wAgg.revised || 0))
        });
      }
    }

    res.json({
      range: { from, to },
      user: { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department },
      delegation, checklist, dailyReport, recentEntries, clients, meetings, scores, weekly
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Drill-down behind a row of the weekly table.
app.get('/api/compliance/employee/:id/week-tasks', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid employee id' });
    if (!await canViewComplianceEmployee(req, id)) return res.status(403).json({ error: 'Not allowed' });
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const from = isDate(req.query.from) ? req.query.from : null;
    const to   = isDate(req.query.to)   ? req.query.to   : null;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

    const [delTasks] = await db.query(
      `SELECT dt.id, dt.description AS title, dt.status, DATE_FORMAT(dt.due_date,'%Y-%m-%d') AS due_date,
              COALESCE(c.name,'—') AS client_name, 'delegation' AS task_type,
              COALESCE(u2.name,'—') AS assigned_by
         FROM delegation_tasks dt
         LEFT JOIN clients c ON c.id = dt.client_id
         LEFT JOIN users u2 ON u2.id = dt.assigned_by
        WHERE dt.assigned_to=? AND dt.due_date BETWEEN ? AND ?
        ORDER BY dt.due_date, dt.id`, [id, from, to]);
    const [chlTasks] = await db.query(
      `SELECT ct.id, ct.description AS title, ct.status, DATE_FORMAT(ct.due_date,'%Y-%m-%d') AS due_date,
              COALESCE(c.name,'—') AS client_name, 'checklist' AS task_type,
              COALESCE(u2.name,'—') AS assigned_by
         FROM checklist_tasks ct
         LEFT JOIN clients c ON c.id = ct.client_id
         LEFT JOIN users u2 ON u2.id = ct.assigned_by
        WHERE ct.assigned_to=? AND ct.due_date BETWEEN ? AND ?
        ORDER BY ct.due_date, ct.id`, [id, from, to]);
    res.json([...delTasks, ...chlTasks].sort((a, b) => a.due_date < b.due_date ? -1 : 1));
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ══════════════════════════════════════════════════════
// WEEK PLAN
// ══════════════════════════════════════════════════════
app.post('/api/week-plan', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { employeeId, startDate, targetCount, hodId, improvementPct } = req.body;
    if (!employeeId || !startDate) {
      return res.json({ error: 'employeeId and startDate required' });
    }
    const impPct = (improvementPct !== undefined && improvementPct !== null && improvementPct !== '') ? parseInt(improvementPct) : null;
    // Upsert: insert or update if same employee+startDate exists
    await db.execute(
      `INSERT INTO week_plans (employee_id, hod_id, start_date, target_count, improvement_pct, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE target_count = VALUES(target_count), hod_id = VALUES(hod_id), improvement_pct = VALUES(improvement_pct), created_at = NOW()`,
      [employeeId, hodId || req.session.userId, startDate, targetCount, impPct]
    );
    res.json({ success: true });
  } catch (e) {
    // If table doesn't exist, create it first then retry
    if (e.code === 'ER_NO_SUCH_TABLE') {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS week_plans (
          id INT AUTO_INCREMENT PRIMARY KEY,
          employee_id INT NOT NULL,
          hod_id INT NOT NULL,
          start_date DATE NOT NULL,
          target_count INT NOT NULL,
          improvement_pct INT DEFAULT NULL,
          created_at DATETIME,
          UNIQUE KEY uq_emp_week (employee_id, start_date)
        )
      `);
      const { employeeId, startDate, targetCount, hodId, improvementPct } = req.body;
      const impPct = (improvementPct !== undefined && improvementPct !== null && improvementPct !== '') ? parseInt(improvementPct) : null;
      await db.execute(
        `INSERT INTO week_plans (employee_id, hod_id, start_date, target_count, improvement_pct, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE target_count = VALUES(target_count), hod_id = VALUES(hod_id), improvement_pct = VALUES(improvement_pct), created_at = NOW()`,
        [employeeId, hodId || req.session.userId, startDate, targetCount, impPct]
      );
      return res.json({ success: true });
    }
    // If improvement_pct column missing (old table), add it then retry
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        await db.execute(`ALTER TABLE week_plans ADD COLUMN improvement_pct INT DEFAULT NULL`);
      } catch(ae) { /* already exists */ }
      const { employeeId, startDate, targetCount, hodId, improvementPct } = req.body;
      const impPct = (improvementPct !== undefined && improvementPct !== null && improvementPct !== '') ? parseInt(improvementPct) : null;
      await db.execute(
        `INSERT INTO week_plans (employee_id, hod_id, start_date, target_count, improvement_pct, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE target_count = VALUES(target_count), hod_id = VALUES(hod_id), improvement_pct = VALUES(improvement_pct), created_at = NOW()`,
        [employeeId, hodId || req.session.userId, startDate, targetCount, impPct]
      );
      return res.json({ success: true });
    }
    console.error(e);
    res.json({ error: 'Failed to save plan' });
  }
});

app.get('/api/week-plan', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT wp.*, u.name as employee_name FROM week_plans wp
       JOIN users u ON u.id = wp.employee_id
       ORDER BY wp.start_date DESC LIMIT 50`
    );
    res.json(rows);
  } catch (e) {
    res.json([]);
  }
});

// ══════════════════════════════════════════════════════
// DEBUG ENDPOINT (remove after fixing)
// ══════════════════════════════════════════════════════
app.get('/api/debug', async (req, res) => {
  const result = { time: new Date().toISOString(), env: {}, db: {}, tables: {} };
  result.env = {
    NODE_ENV: process.env.NODE_ENV || '(not set)',
    DB_HOST: process.env.DB_HOST || 'localhost (default)',
    DB_USER: process.env.DB_USER || 'root (default)',
    DB_NAME: process.env.DB_NAME || 'bunai_task_manager (default)',
    PORT: process.env.PORT || '3000 (default)',
  };
  try {
    await db.query('SELECT 1');
    result.db.connected = true;
    const counts = ['users','delegation_tasks','checklist_tasks','fms_sheets'];
    for (const t of counts) {
      try {
        const [[row]] = await db.query(`SELECT COUNT(*) AS c FROM ${t}`);
        result.tables[t] = row.c;
      } catch(e) { result.tables[t] = 'ERROR: ' + e.message; }
    }
    // Show users with their roles and departments
    try {
      const [users] = await db.query('SELECT id, name, role, department FROM users ORDER BY role, name');
      result.users = users;
    } catch(e) { result.users = 'ERROR: ' + e.message; }
  } catch(e) {
    result.db.connected = false;
    result.db.error = e.message;
  }
  res.json(result);
});

// ══════════════════════════════════════════════════════
// PAGES
// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// 📅 DAILY TASK FORM + CLIENTS + COMPLIANCE + WHATSAPP
// ══════════════════════════════════════════════════════

// Auto-create new tables on startup (safe, runs once per cold start)
const _clientsTableMigrationsPromise = (async () => {
  const sa = async (sql) => { try { await db.query(sql); } catch(e){} };
  await sa(`CREATE TABLE IF NOT EXISTS clients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await sa(`CREATE TABLE IF NOT EXISTS daily_tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    entry_date DATE NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    department VARCHAR(255) DEFAULT '',
    description TEXT NOT NULL,
    duration_min INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_date (user_id, entry_date),
    INDEX idx_entry_date (entry_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  console.log('  ✅ Daily Task tables ready');
})();

// ══════════════════════════════════════════════════════
// WHATSAPP AUTOMATION — Aumfig
// 1) Message to the doer as soon as a task is delegated (after a 1 min delay)
// 2) Summary message to the doer as soon as a checklist is generated
// 3) Every day at 10:00 AM (IST) — that day's whole checklist in a single message
// Leaving AUMFIG_API_KEY blank silently disables all of this.
// ══════════════════════════════════════════════════════
const AUMFIG_API_KEY = process.env.AUMFIG_API_KEY || '';
const AUMFIG_API_URL = process.env.AUMFIG_API_URL || 'https://api.aumfig.com/api/v1/send-message';

// Normalises Indian mobile numbers to "91XXXXXXXXXX" (no +, no leading 0).
function normalizeWhatsAppPhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (digits.length === 10) digits = '91' + digits;                 // bare 10-digit number
  else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1); // 0XXXXXXXXXX
  return digits;
}

// Low-level call to the Aumfig "Send Message" API.
async function sendWhatsAppRaw(phone, message) {
  if (!AUMFIG_API_KEY) return { ok: false, reason: 'disabled — AUMFIG_API_KEY not set' };
  const to = normalizeWhatsAppPhone(phone);
  if (!to) return { ok: false, reason: 'no valid phone number' };
  try {
    const resp = await fetch(AUMFIG_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AUMFIG_API_KEY
      },
      body: JSON.stringify({ phone: to, message })
    });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!resp.ok) {
      console.error('⚠️ Aumfig WhatsApp send failed:', resp.status, data);
      return { ok: false, status: resp.status, data };
    }
    return { ok: true, status: resp.status, data };
  } catch (err) {
    console.error('⚠️ Aumfig WhatsApp send error:', err.message);
    return { ok: false, reason: err.message };
  }
}

// ── Shared FIFO send queue ────────────────────────────
// All WhatsApp messages (delegation + checklist + daily reminder) go out one at a
// time from a SINGLE queue, with a 4-5 minute gap between messages. That keeps
// WhatsApp/Aumfig from flagging it as spam and preserves message order.
//
// The gap is RANDOM between 4-5 min each time (a fixed interval looks bot-like).
// It can be changed from .env:
//   WHATSAPP_GAP_MIN_MS / WHATSAPP_GAP_MAX_MS  → set the range
//   WHATSAPP_GAP_MS                            → fixed gap (the range is then ignored)
const WHATSAPP_GAP_MIN_MS = parseInt(process.env.WHATSAPP_GAP_MIN_MS || String(4 * 60 * 1000), 10); // 4 min
const WHATSAPP_GAP_MAX_MS = parseInt(process.env.WHATSAPP_GAP_MAX_MS || String(5 * 60 * 1000), 10); // 5 min
const WHATSAPP_GAP_FIXED  = (process.env.WHATSAPP_GAP_MS != null && process.env.WHATSAPP_GAP_MS !== '')
  ? parseInt(process.env.WHATSAPP_GAP_MS, 10) : null;

// How long to wait after each message (ms) — random 4-5 min unless a fixed value is set.
function _nextGapMs() {
  if (WHATSAPP_GAP_FIXED != null && WHATSAPP_GAP_FIXED >= 0) return WHATSAPP_GAP_FIXED;
  const lo = Math.min(WHATSAPP_GAP_MIN_MS, WHATSAPP_GAP_MAX_MS);
  const hi = Math.max(WHATSAPP_GAP_MIN_MS, WHATSAPP_GAP_MAX_MS);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
// For estimates/labels only — the average gap (min+max)/2, or the fixed value.
function _avgGapMs() {
  if (WHATSAPP_GAP_FIXED != null && WHATSAPP_GAP_FIXED >= 0) return WHATSAPP_GAP_FIXED;
  return Math.round((WHATSAPP_GAP_MIN_MS + WHATSAPP_GAP_MAX_MS) / 2);
}
const _waQueue = [];
let _waDraining = false;

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

function _enqueueWhatsApp(phone, message, label) {
  return new Promise((resolve) => {
    _waQueue.push({ phone, message, label: label || 'msg', resolve });
    _drainWhatsAppQueue();
  });
}

async function _drainWhatsAppQueue() {
  if (_waDraining) return;
  _waDraining = true;
  try {
    while (_waQueue.length) {
      const job = _waQueue.shift();
      let result;
      try { result = await sendWhatsAppRaw(job.phone, job.message); }
      catch (e) { result = { ok: false, reason: e.message }; }
      try { job.resolve(result); } catch {}
      // No pointless wait after the last message
      if (_waQueue.length) await _sleep(_nextGapMs());
    }
  } finally {
    _waDraining = false;
  }
}

// Queues the message after delayMs (the queue handles its own gap).
function queueWhatsApp(phone, message, { delayMs = 0, label = 'msg' } = {}) {
  if (delayMs > 0) {
    return new Promise((resolve) => {
      setTimeout(() => { _enqueueWhatsApp(phone, message, label).then(resolve); }, delayMs);
    });
  }
  return _enqueueWhatsApp(phone, message, label);
}

// Message sent when a delegation task is assigned — 1 min delay (existing behaviour).
const WHATSAPP_DELAY_MS = parseInt(process.env.WHATSAPP_DELAY_MS || String(60 * 1000), 10);
function sendWhatsApp(phone, { doerName, assignedByName, dueDate, priority, description }) {
  const message =
    `Hello ${doerName || ''},\n` +
    `New Task Delegated\n` +
    `By: ${assignedByName || ''}\n` +
    `Due: ${dueDate || ''}\n` +
    `Priority: ${(priority || '').toUpperCase()}\n` +
    `Task:- ${description || ''}`;
  return queueWhatsApp(phone, message, { delayMs: WHATSAPP_DELAY_MS, label: 'delegation' });
}

// Human-friendly "15-Jul-2026" style date for the WhatsApp message (DB gives YYYY-MM-DD).
function formatDueDateForWhatsApp(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(d.getDate()).padStart(2,'0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

// ── Checklist WhatsApp helpers ────────────────────────
const _FREQ_LABEL_WA = {
  daily: 'Daily', weekly: 'Weekly', alternative_week: 'Alternative Week',
  monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly'
};
const _PRIORITY_EMOJI = { high: '🔴', medium: '🟠', low: '🟢' };
const _NUM_EMOJI = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
const _numBullet = (i) => (i < 10 ? _NUM_EMOJI[i] : `🔹 ${i + 1}.`);

// Summary message sent to the doer as soon as a checklist is created.
function buildChecklistCreatedMessage({ doerName, assignedByName, description, frequency, startDate, endDate, totalTasks, clientName, remarks }) {
  const lines = [];
  lines.push(`🔔 *New Checklist Assigned*`);
  lines.push('');
  lines.push(`Hello ${doerName || ''} 👋`);
  lines.push('');
  lines.push(`📋 *Task:* ${description || ''}`);
  if (clientName) lines.push(`🏢 *Client:* ${clientName}`);
  lines.push(`🔁 *Frequency:* ${_FREQ_LABEL_WA[frequency] || 'Recurring'}`);
  lines.push(`📅 *Start:* ${formatDueDateForWhatsApp(startDate)}`);
  if (endDate) lines.push(`🏁 *End:* ${formatDueDateForWhatsApp(endDate)}`);
  if (totalTasks) lines.push(`🗂 *Total:* ${totalTasks} task`);
  if (assignedByName) lines.push(`👤 *Assign by:* ${assignedByName}`);
  if (remarks) lines.push(`📝 *Remarks:* ${remarks}`);
  lines.push('');
  lines.push(`⏰ You will get a reminder for that day’s checklist every morning at 10 AM.`);
  lines.push(`— Bunai Task Manager`);
  return lines.join('\n');
}

// ALL of one user's checklist tasks for that day — in a single message.
function buildChecklistDailyMessage(doerName, dateStr, tasks) {
  const lines = [];
  lines.push(`🌅 *Good Morning ${doerName || ''}!*`);
  lines.push('');
  lines.push(`📋 *Today’s Checklist* — ${formatDueDateForWhatsApp(dateStr)}`);
  lines.push(tasks.length === 1 ? `You have *1 task* today:` : `You have *${tasks.length} tasks* today:`);
  lines.push('');
  tasks.forEach((t, i) => {
    lines.push(`${_numBullet(i)} ${t.description || ''}`);
    const meta = [];
    const pr = String(t.priority || 'low').toLowerCase();
    meta.push(`${_PRIORITY_EMOJI[pr] || '🟢'} ${pr.toUpperCase()}`);
    if (t.client_name) meta.push(`🏢 ${t.client_name}`);
    lines.push(`     ${meta.join('  •  ')}`);
    if (t.remarks) lines.push(`     📝 ${t.remarks}`);
    lines.push('');
  });
  lines.push(`✅ Mark it as *Done* in the app as soon as the work is finished.`);
  lines.push(`— Bunai Task Manager`);
  return lines.join('\n');
}

// ── IST time helpers ──────────────────────────────────
// On Hostinger/serverless the server runs in UTC, so IST is computed explicitly everywhere.
function istParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: parseInt(p.hour, 10),
    minute: parseInt(p.minute, 10)
  };
}
function istToday() { return istParts().date; }

// ── Daily 10 AM checklist reminder ────────────────────
const CHECKLIST_REMINDER_HOUR = parseInt(process.env.CHECKLIST_REMINDER_HOUR || '10', 10);
const CHECKLIST_REMINDER_MINUTE = parseInt(process.env.CHECKLIST_REMINDER_MINUTE || '0', 10);
const CHECKLIST_REMINDER_ENABLED = String(process.env.CHECKLIST_REMINDER_ENABLED || '1') !== '0';

// Multi-instance safe lock — the UNIQUE key lets only one instance insert,
// the others fail on the duplicate insert and simply skip.
async function acquireReminderLock(dateStr, kind) {
  const insert = () => db.query(
    `INSERT INTO whatsapp_reminder_log (log_date, kind, status) VALUES (?,?,'running')`, [dateStr, kind]);
  try {
    await insert();
    return true;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return false;   // kisi aur instance ne already le liya — skip
    if (e.code === 'ER_NO_SUCH_TABLE') {
      // Migration did not run — create the table and retry once
      try {
        await db.query(`CREATE TABLE IF NOT EXISTS whatsapp_reminder_log (
          id INT AUTO_INCREMENT PRIMARY KEY, log_date DATE NOT NULL, kind VARCHAR(40) NOT NULL,
          status VARCHAR(20) DEFAULT 'running', sent INT DEFAULT 0, failed INT DEFAULT 0,
          note VARCHAR(500) DEFAULT NULL,
          started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMP NULL DEFAULT NULL,
          UNIQUE KEY uniq_day_kind (log_date, kind)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        await insert();
        return true;
      } catch (e2) {
        if (e2.code === 'ER_DUP_ENTRY') return false;
        console.error('reminder lock retry failed:', e2.message);
        return false;
      }
    }
    console.error('reminder lock error:', e.message);
    return false;
  }
}
async function releaseReminderLock(dateStr, kind, status, sent, failed, note) {
  try {
    await db.query(
      `UPDATE whatsapp_reminder_log SET status=?, sent=?, failed=?, note=?, finished_at=NOW() WHERE log_date=? AND kind=?`,
      [status, sent || 0, failed || 0, (note || '').slice(0, 480), dateStr, kind]);
  } catch (e) { console.error('reminder lock release:', e.message); }
}

// Collects all pending checklists for that day, groups them per user,
// and sends each user ONE message.
async function runChecklistDailyReminder({ dateStr, force = false } = {}) {
  const day = dateStr || istToday();
  const kind = 'checklist_daily';

  if (!force) {
    const got = await acquireReminderLock(day, kind);
    if (!got) return { skipped: true, reason: 'already run/locked for ' + day };
  }

  try {
    const [rows] = await db.query(
      `SELECT t.id, t.description, COALESCE(t.priority,'low') AS priority, t.remarks,
              u.id AS userId, u.name AS userName, u.phone,
              c.name AS client_name
         FROM checklist_tasks t
         JOIN users u ON t.assigned_to = u.id
         LEFT JOIN clients c ON t.client_id = c.id
        WHERE t.status = 'pending'
          AND t.due_date = ?
          AND COALESCE(u.exclude_from_reminder, 0) = 0
        ORDER BY u.name ASC, t.id ASC`, [day]);

    // Group per user — if there are 2 tasks, both go in the same message
    const byUser = new Map();
    for (const r of rows) {
      if (!r.phone) continue;                       // no phone number, skip
      if (!byUser.has(r.userId)) byUser.set(r.userId, { name: r.userName, phone: r.phone, tasks: [] });
      byUser.get(r.userId).tasks.push(r);
    }
    const users = byUser.size;

    // There is a 4-5 min gap between messages, so a blast to 15-20 people can take
    // over an hour. So nothing is AWAITed here — everything is queued and we return
    // immediately, while the queue keeps sending in the background with its gap. The
    // HTTP request neither stalls nor times out.
    const sendPromises = [];
    for (const [, u] of byUser) {
      const msg = buildChecklistDailyMessage(u.name, day, u.tasks);
      sendPromises.push(queueWhatsApp(u.phone, msg, { label: 'checklist-daily' }));
    }

    // Background: update the log once every message has gone out (however long it takes)
    if (sendPromises.length) {
      Promise.allSettled(sendPromises).then(async (results) => {
        let sent = 0, failed = 0;
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value && r.value.ok) sent++; else failed++;
        }
        await releaseReminderLock(day, kind, 'done', sent, failed, `${users} users, ${rows.length} tasks`);
        console.log(`📲 Checklist daily reminder (${day}) COMPLETE: ${sent} sent, ${failed} failed, ${users} users`);
      });
    } else {
      // Nothing to send to anyone — release the lock immediately
      await releaseReminderLock(day, kind, 'done', 0, 0, `no recipients (${rows.length} tasks)`);
    }

    const avgGapMin = _avgGapMs() / 60000;
    const estimateMinutes = users > 1 ? Math.ceil((users - 1) * avgGapMin) : 0;
    console.log(`📲 Checklist daily reminder (${day}) QUEUED: ${users} messages, ~${estimateMinutes} min for all of them to go out`);

    return {
      success: true, started: true, date: day,
      users, tasks: rows.length, queued: users, estimateMinutes
    };
  } catch (err) {
    if (!force) await releaseReminderLock(day, kind, 'error', 0, 0, err.message);
    console.error('❌ Checklist daily reminder error:', err.message);
    return { success: false, error: err.message };
  }
}

// Scheduler — checks every minute whether it is 10:00 in IST.
// (No extra npm package — plain setInterval.)
let _lastReminderTick = '';
function startChecklistReminderScheduler() {
  if (!CHECKLIST_REMINDER_ENABLED) {
    console.log('⏸ Checklist WhatsApp reminder disabled (CHECKLIST_REMINDER_ENABLED=0)');
    return;
  }
  // A serverless function only lives for the length of one request, so a
  // setInterval here would never fire. On Vercel the schedule comes from
  // vercel.json crons hitting /api/cron/checklist-reminder instead.
  if (process.env.VERCEL || process.env.NOW_REGION) {
    console.log('⏰ Serverless runtime — daily reminder runs via Vercel Cron, not setInterval');
    return;
  }
  setInterval(async () => {
    try {
      const { date, hour, minute } = istParts();
      if (hour !== CHECKLIST_REMINDER_HOUR || minute !== CHECKLIST_REMINDER_MINUTE) return;
      if (_lastReminderTick === date) return;       // already sent by this instance today
      _lastReminderTick = date;
      await runChecklistDailyReminder({ dateStr: date });
    } catch (e) { console.error('reminder scheduler:', e.message); }
  }, 60 * 1000);
  console.log(`⏰ Checklist WhatsApp reminder scheduled daily at ${String(CHECKLIST_REMINDER_HOUR).padStart(2,'0')}:${String(CHECKLIST_REMINDER_MINUTE).padStart(2,'0')} IST`);
}
startChecklistReminderScheduler();

// Manual trigger (admin) — for testing. force=1 ignores the lock and sends again.
app.post('/api/whatsapp/checklist-daily-run', requireAuth, requireAdmin, async (req, res) => {
  try {
    const dateStr = normDate(req.body && req.body.date) || istToday();
    const force = !!(req.body && (req.body.force === true || req.body.force === 1 || req.body.force === '1'));
    const result = await runChecklistDailyReminder({ dateStr, force });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cron entry point for the daily reminder. Vercel Cron calls this on a schedule
// because setInterval cannot survive between serverless invocations.
// Auth is a shared secret, not a login: cron has no session. Vercel sends its
// own Authorization: Bearer <CRON_SECRET> header, and the same secret is
// accepted via ?key= so the job can be triggered from anywhere.
app.get('/api/cron/checklist-reminder', async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not configured' });
  const sent = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.key || '';
  if (sent !== secret) return res.status(401).json({ error: 'Unauthorized' });
  try {
    // The DB lock (UNIQUE log_date) still guards against a double fire.
    const result = await runChecklistDailyReminder({ dateStr: istToday() });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('  ❌ cron checklist-reminder:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Who would receive a message today — a preview without sending (admin)
app.get('/api/whatsapp/checklist-daily-preview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const day = normDate(req.query.date) || istToday();
    const [rows] = await db.query(
      `SELECT t.description, COALESCE(t.priority,'low') AS priority, t.remarks,
              u.id AS userId, u.name AS userName, u.phone, c.name AS client_name
         FROM checklist_tasks t
         JOIN users u ON t.assigned_to = u.id
         LEFT JOIN clients c ON t.client_id = c.id
        WHERE t.status='pending' AND t.due_date=? AND COALESCE(u.exclude_from_reminder,0)=0
        ORDER BY u.name ASC, t.id ASC`, [day]);
    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.userId)) byUser.set(r.userId, { name: r.userName, phone: r.phone, tasks: [] });
      byUser.get(r.userId).tasks.push(r);
    }
    const preview = [...byUser.values()].map(u => ({
      name: u.name, phone: u.phone || null, hasPhone: !!u.phone,
      taskCount: u.tasks.length,
      message: buildChecklistDailyMessage(u.name, day, u.tasks)
    }));
    res.json({ date: day, users: preview.length, willSend: preview.filter(p => p.hasPhone).length, preview });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// DAILY / PENDING REMINDERS — removed (WhatsApp automation).
// All scheduled reminder + cron endpoints have been deleted for this build.
// ══════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════
// CLIENTS — admin manages, everyone reads
// ══════════════════════════════════════════════════════
app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, name FROM clients ORDER BY name ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients', requireAuth, requireAdmin, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Client name required' });
    await db.query('INSERT INTO clients (name) VALUES (?)', [name]);
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Client already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/clients/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM clients WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk add clients via CSV
app.post('/api/clients/bulk', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { names } = req.body;
    if (!Array.isArray(names) || !names.length) {
      return res.status(400).json({ error: 'No clients to add' });
    }
    // Clean + dedupe within request
    const cleanNames = [...new Set(
      names.map(n => String(n||'').trim()).filter(n => n)
    )];
    if (!cleanNames.length) return res.status(400).json({ error: 'No valid client names' });

    let added = 0, skipped = 0;
    const skippedNames = [];
    for (const name of cleanNames) {
      try {
        await db.query('INSERT INTO clients (name) VALUES (?)', [name]);
        added++;
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') { skipped++; skippedNames.push(name); }
        else throw e;
      }
    }
    res.json({ success: true, added, skipped, skippedNames });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Client stats — total hours + top 3 workers (all-time)
app.get('/api/clients/:id/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [[client]] = await db.query('SELECT name FROM clients WHERE id=?', [req.params.id]);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const [[totals]] = await db.query(
      'SELECT COALESCE(SUM(duration_min),0) AS total_minutes FROM daily_tasks WHERE client_name=?',
      [client.name]
    );
    const [topWorkers] = await db.query(
      `SELECT u.name, COALESCE(u.department,'') AS department,
              SUM(dt.duration_min) AS total_minutes, COUNT(*) AS task_count
       FROM daily_tasks dt
       JOIN users u ON dt.user_id = u.id
       WHERE dt.client_name = ?
       GROUP BY dt.user_id, u.name, u.department
       ORDER BY total_minutes DESC
       LIMIT 3`,
      [client.name]
    );
    res.json({ client_name: client.name, total_minutes: totals.total_minutes, top_workers: topWorkers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// DEPARTMENTS — unique list from users.department
// ══════════════════════════════════════════════════════
app.get('/api/departments', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT DISTINCT department FROM users
       WHERE department IS NOT NULL AND department != ''
       ORDER BY department ASC`
    );
    const fromUsers = rows.map(r => r.department);
    const extras = ['YouTube'];
    const merged = [...new Set([...fromUsers, ...extras])].sort((a,b) => a.localeCompare(b));
    res.json(merged);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// DAILY TASK — submit, list, and check today's status
// ══════════════════════════════════════════════════════

// Check if current user already submitted for given date (default today)
app.get('/api/daily-tasks/status', requireAuth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const [[{ cnt }]] = await db.query(
      'SELECT COUNT(*) AS cnt FROM daily_tasks WHERE user_id=? AND entry_date=?',
      [req.session.userId, date]
    );
    res.json({ submitted: cnt > 0, date });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get current user's own past entries (read-only)
app.get('/api/daily-tasks/mine', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, DATE_FORMAT(entry_date,'%Y-%m-%d') AS entry_date,
              client_name, department, description, duration_min, created_at
       FROM daily_tasks WHERE user_id=?
       ORDER BY entry_date DESC, id DESC LIMIT 200`,
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Submit daily task — multiple rows in single call
app.post('/api/daily-tasks', requireAuth, async (req, res) => {
  try {
    const { entry_date, rows } = req.body;
    if (!entry_date || !Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: 'Date and at least 1 row required' });
    }

    // Date restriction: only today or yesterday
    const today = new Date(); today.setHours(0,0,0,0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const todayStr = today.toISOString().split('T')[0];
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    if (entry_date !== todayStr && entry_date !== yesterdayStr) {
      return res.status(400).json({ error: 'Only today or yesterday entries are allowed' });
    }

    // Validate each row
    const cleanRows = [];
    for (const r of rows) {
      const client = (r.client_name || '').trim();
      const dept = (r.department || '').trim();
      const desc = (r.description || '').trim();
      const dur = parseInt(r.duration_min) || 0;
      if (!client || !desc || dur <= 0) {
        return res.status(400).json({ error: 'Each row needs client, description, and duration > 0' });
      }
      cleanRows.push([req.session.userId, entry_date, client, dept, desc, dur]);
    }

    // Lock check — already submitted for this date?
    const [[{ cnt }]] = await db.query(
      'SELECT COUNT(*) AS cnt FROM daily_tasks WHERE user_id=? AND entry_date=?',
      [req.session.userId, entry_date]
    );
    if (cnt > 0) {
      return res.status(400).json({ error: 'You have already submitted for this date. Editing is not allowed.' });
    }

    // Bulk insert
    await db.query(
      `INSERT INTO daily_tasks (user_id, entry_date, client_name, department, description, duration_min) VALUES ?`,
      [cleanRows]
    );

    res.json({ success: true, count: cleanRows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// COMPLIANCE — Last 7 days grid (admin only)
// ══════════════════════════════════════════════════════
app.get('/api/compliance/last7', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Last 7 days inclusive of today
    const dates = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    // All users with week_off / extra_off so we can mark off-days
    const [users] = await db.query(
      `SELECT id, name, email, role, department,
              COALESCE(week_off,'') AS week_off,
              COALESCE(extra_off,'') AS extra_off
       FROM users
       WHERE role IN ('admin','hod','pc','user')
       ORDER BY name ASC`
    );

    // All filled (user_id, date) pairs in this range
    const [filled] = await db.query(
      `SELECT user_id, DATE_FORMAT(entry_date,'%Y-%m-%d') AS d
       FROM daily_tasks
       WHERE entry_date BETWEEN ? AND ?
       GROUP BY user_id, entry_date`,
      [dates[0], dates[dates.length - 1]]
    );

    // Build lookup: { userId: Set(dates) }
    const filledMap = {};
    for (const f of filled) {
      if (!filledMap[f.user_id]) filledMap[f.user_id] = new Set();
      filledMap[f.user_id].add(f.d);
    }

    const holidaysSet = await loadHolidaysSet();

    // Build grid — mark off-days so UI doesn't count them as missed
    const grid = users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      department: u.department || '—',
      status: dates.map(d => ({
        date: d,
        filled: filledMap[u.id]?.has(d) || false,
        off: isUserOffOn(u, d, holidaysSet),
        isHoliday: holidaysSet.has(d)
      }))
    }));

    res.json({ dates, users: grid, holidays: [...holidaysSet] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin view — all daily task entries with filters
app.get('/api/daily-tasks/all', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { from, to, userId } = req.query;
    let where = '1=1';
    const params = [];
    if (from) { where += ' AND dt.entry_date >= ?'; params.push(from); }
    if (to)   { where += ' AND dt.entry_date <= ?'; params.push(to); }
    if (userId) { where += ' AND dt.user_id = ?'; params.push(userId); }

    const [rows] = await db.query(
      `SELECT dt.id, DATE_FORMAT(dt.entry_date,'%Y-%m-%d') AS entry_date,
              dt.client_name, dt.department, dt.description, dt.duration_min,
              u.name AS doer_name, u.email AS doer_email
       FROM daily_tasks dt
       JOIN users u ON dt.user_id = u.id
       WHERE ${where}
       ORDER BY dt.entry_date DESC, dt.id DESC
       LIMIT 1000`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Monthly report — summary + day-wise entries (admin only)
app.get('/api/daily-tasks/report', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Default to current month if not provided
    const now = new Date();
    const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM' });
    }
    const [year, mm] = month.split('-').map(Number);
    const fromDate = `${year}-${String(mm).padStart(2,'0')}-01`;
    // last day of month
    const lastDay = new Date(year, mm, 0).getDate();
    const toDate = `${year}-${String(mm).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

    // All entries in this month
    const [rows] = await db.query(
      `SELECT dt.id, DATE_FORMAT(dt.entry_date,'%Y-%m-%d') AS entry_date,
              dt.client_name, dt.department, dt.description, dt.duration_min,
              dt.user_id, u.name AS doer_name, u.email AS doer_email,
              COALESCE(u.department, '') AS doer_department
       FROM daily_tasks dt
       JOIN users u ON dt.user_id = u.id
       WHERE dt.entry_date BETWEEN ? AND ?
       ORDER BY dt.entry_date ASC, u.name ASC, dt.id ASC`,
      [fromDate, toDate]
    );

    // Per-user totals
    const userTotals = {};
    for (const r of rows) {
      if (!userTotals[r.user_id]) {
        userTotals[r.user_id] = {
          user_id: r.user_id, name: r.doer_name, email: r.doer_email,
          department: r.doer_department, total_minutes: 0, total_tasks: 0,
          days_filled: new Set()
        };
      }
      userTotals[r.user_id].total_minutes += r.duration_min;
      userTotals[r.user_id].total_tasks += 1;
      userTotals[r.user_id].days_filled.add(r.entry_date);
    }
    // Convert Set to count
    const summary = Object.values(userTotals)
      .map(u => ({ ...u, days_filled: u.days_filled.size }))
      .sort((a, b) => b.total_minutes - a.total_minutes);

    res.json({
      month, from: fromDate, to: toDate,
      total_entries: rows.length,
      total_minutes: rows.reduce((a, b) => a + b.duration_min, 0),
      summary,
      entries: rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// LEAVE TRACKER
// Flow: user → HOD of same dept; hod/pc → admin; admin → self (auto-approved)
// ══════════════════════════════════════════════════════
async function resolveLeaveApprover(userId) {
  // Uses `user_role` (org hierarchy), NOT `role` (app permissions). An IT employee
  // may have role='admin' for full app access but user_role='user' so leaves still
  // route to their HOD.
  const [rows] = await db.query(
    `SELECT id, COALESCE(user_role, role) AS user_role, department
     FROM users WHERE id=?`, [userId]);
  const me = rows[0];
  if (!me) return null;
  if (me.user_role === 'admin') {
    // Admin's leave → another admin (by user_role) if available, else self
    const [adm] = await db.query(
      `SELECT id FROM users
       WHERE COALESCE(user_role, role)='admin' AND id<>? ORDER BY id ASC LIMIT 1`,
      [me.id]);
    if (adm[0]) return adm[0].id;
    return me.id;
  }
  if (me.user_role === 'hod' || me.user_role === 'pc') {
    const [adm] = await db.query(
      `SELECT id FROM users WHERE COALESCE(user_role, role)='admin' ORDER BY id ASC LIMIT 1`);
    return adm[0]?.id || null;
  }
  // user → HOD of same department; fallback to admin
  if (me.department) {
    const [hods] = await db.query(
      `SELECT id FROM users
       WHERE COALESCE(user_role, role)='hod' AND department=? ORDER BY id ASC LIMIT 1`,
      [me.department]);
    if (hods[0]) return hods[0].id;
  }
  const [adm] = await db.query(
    `SELECT id FROM users WHERE COALESCE(user_role, role)='admin' ORDER BY id ASC LIMIT 1`);
  return adm[0]?.id || null;
}

// List leaves — scope based on role + ?scope= filter
//   scope=mine       → only my requests (default for users)
//   scope=approvals  → requests awaiting my approval (hod/admin/pc)
//   scope=team       → all in my visibility (hod = dept, admin = all)
app.get('/api/leaves', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    const scope = req.query.scope || 'mine';
    const status = req.query.status || '';

    let where = '1=1', params = [];
    if (scope === 'mine') {
      where += ' AND lr.user_id=?'; params.push(uid);
    } else if (scope === 'approvals') {
      // If this user is an HOD, show leaves for ALL HODs in same department
      const [[meInfo]] = await db.query(
        'SELECT department, COALESCE(user_role, role) AS user_role FROM users WHERE id=?', [uid]);
      if (meInfo?.user_role === 'hod' && meInfo?.department) {
        const [deptHods] = await db.query(
          `SELECT id FROM users WHERE COALESCE(user_role, role)='hod' AND department=?`,
          [meInfo.department]);
        const hodIds = deptHods.map(h => h.id);
        where += ` AND lr.approver_id IN (${hodIds.map(()=>'?').join(',')}) AND lr.user_id<>?`;
        params.push(...hodIds, uid);
      } else {
        where += ' AND lr.approver_id=? AND lr.user_id<>?'; params.push(uid, uid);
      }
    } else if (scope === 'team') {
      if (role === 'admin') {
        // no filter — all
      } else if (role === 'hod') {
        const [[me]] = await db.query('SELECT department FROM users WHERE id=?', [uid]);
        if (me?.department) {
          where += ' AND u.department=?'; params.push(me.department);
        } else {
          where += ' AND lr.user_id=?'; params.push(uid);
        }
      } else {
        where += ' AND lr.user_id=?'; params.push(uid);
      }
    }
    if (status) { where += ' AND lr.status=?'; params.push(status); }

    const [rows] = await db.query(`
      SELECT lr.id, lr.user_id, lr.leave_type, lr.status, lr.reason,
        lr.approver_id, lr.approver_note, lr.dates_json,
        DATE_FORMAT(lr.from_date,'%Y-%m-%d') AS from_date,
        DATE_FORMAT(lr.to_date,'%Y-%m-%d')   AS to_date,
        DATE_FORMAT(lr.created_at,'%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(lr.decided_at,'%Y-%m-%d %H:%i:%s') AS decided_at,
        u.name AS user_name, u.email AS user_email, u.department AS user_department,
        ap.name AS approver_name,
        (SELECT GROUP_CONCAT(hod.name ORDER BY hod.name SEPARATOR ', ')
         FROM users hod
         WHERE COALESCE(hod.user_role, hod.role)='hod'
           AND hod.department=u.department
           AND u.department IS NOT NULL AND u.department<>'') AS dept_hod_names
      FROM leave_requests lr
      JOIN users u ON lr.user_id=u.id
      LEFT JOIN users ap ON lr.approver_id=ap.id
      WHERE ${where}
      ORDER BY lr.created_at DESC
      LIMIT 500
    `, params);
    // Parse dates_json into structured array for client
    for (const r of rows) {
      if (r.dates_json) {
        try { r.dates = JSON.parse(r.dates_json); }
        catch { r.dates = null; }
      } else {
        // Legacy rows (pre dates_json): fall back to from/to range
        r.dates = [{ date: r.from_date }];
      }
      delete r.dates_json;
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pending approvals count — for badge
// Returns names of all HODs who will approve current user's leave
app.get('/api/leaves/my-approvers', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const [[me]] = await db.query(
      'SELECT department, COALESCE(user_role, role) AS user_role FROM users WHERE id=?', [uid]);
    if (!me) return res.json({ names: '' });
    if (me.user_role === 'admin') return res.json({ names: 'Another Admin' });
    if (me.user_role === 'hod' || me.user_role === 'pc') return res.json({ names: 'Admin' });
    if (me.department) {
      const [hods] = await db.query(
        `SELECT name FROM users WHERE COALESCE(user_role, role)='hod' AND department=? ORDER BY name`,
        [me.department]);
      return res.json({ names: hods.map(h => h.name).join(', ') || 'HOD' });
    }
    res.json({ names: 'HOD' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leaves/pending-count', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    // Count pending leaves for all HODs in same department
    const [[meInfo]] = await db.query(
      'SELECT department, COALESCE(user_role, role) AS user_role FROM users WHERE id=?', [uid]);
    let cnt = 0;
    if (meInfo?.user_role === 'hod' && meInfo?.department) {
      const [deptHods] = await db.query(
        `SELECT id FROM users WHERE COALESCE(user_role, role)='hod' AND department=?`,
        [meInfo.department]);
      const hodIds = deptHods.map(h => h.id);
      const [[r]] = await db.query(
        `SELECT COUNT(*) AS cnt FROM leave_requests WHERE approver_id IN (${hodIds.map(()=>'?').join(',')}) AND status='pending' AND user_id<>?`,
        [...hodIds, uid]);
      cnt = r.cnt || 0;
    } else {
      const [[r]] = await db.query(
        "SELECT COUNT(*) AS cnt FROM leave_requests WHERE approver_id=? AND status='pending' AND user_id<>?",
        [uid, uid]);
      cnt = r.cnt || 0;
    }
    res.json({ count: cnt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Apply for leave
app.post('/api/leaves', requireAuth, async (req, res) => {
  try {
    const { leave_type, dates, reason } = req.body;
    const allowedTypes = ['full_day','half_day','work_from_home','extra_working'];
    if (!allowedTypes.includes(leave_type)) return res.status(400).json({ error: 'Invalid leave type' });
    if (!Array.isArray(dates) || !dates.length) return res.status(400).json({ error: 'Select at least one date' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason required' });

    // Normalize + validate dates
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const seen = new Set();
    const cleanDates = [];
    for (const d of dates) {
      const date = (d && d.date) || d;
      if (!dateRe.test(date)) return res.status(400).json({ error: 'Invalid date format' });
      if (seen.has(date)) continue;
      seen.add(date);
      const item = { date };
      if (leave_type === 'extra_working') {
        const h = Number(d && d.hours);
        if (!h || h <= 0 || h > 24) return res.status(400).json({ error: `Hours required (1-24) for ${date}` });
        item.hours = h;
      }
      cleanDates.push(item);
    }
    cleanDates.sort((a,b) => a.date.localeCompare(b.date));
    const from_date = cleanDates[0].date;
    const to_date = cleanDates[cleanDates.length - 1].date;

    const uid = req.session.userId;
    const approverId = await resolveLeaveApprover(uid);

    const [r] = await db.query(
      `INSERT INTO leave_requests
       (user_id, leave_type, from_date, to_date, dates_json, reason, status, approver_id)
       VALUES (?,?,?,?,?,?,'pending',?)`,
      [uid, leave_type, from_date, to_date, JSON.stringify(cleanDates), reason.trim(), approverId]
    );

    // (Approval notifications removed.)
    res.json({ id: r.insertId, status: 'pending', approver_id: approverId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approve / Reject leave — only the assigned approver (or admin) can act
app.put('/api/leaves/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { action, note } = req.body; // action = 'approve' | 'reject'
    if (!['approve','reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const [rows] = await db.query('SELECT * FROM leave_requests WHERE id=?', [id]);
    const lr = rows[0];
    if (!lr) return res.status(404).json({ error: 'Leave not found' });
    if (lr.status !== 'pending') return res.status(400).json({ error: 'Already decided' });

    const uid = req.session.userId;
    const role = req.session.role;
    // Allow: admin always, assigned approver, OR any HOD in same department as the assigned approver
    if (lr.approver_id !== uid && role !== 'admin') {
      const [[myInfo]] = await db.query(
        'SELECT department, COALESCE(user_role, role) AS user_role FROM users WHERE id=?', [uid]);
      const [[apInfo]] = await db.query(
        'SELECT department FROM users WHERE id=?', [lr.approver_id]);
      const samedept = myInfo?.user_role === 'hod' && myInfo?.department &&
                       apInfo?.department === myInfo.department;
      if (!samedept) return res.status(403).json({ error: 'Not authorized to act on this request' });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await db.query(
      `UPDATE leave_requests
         SET status=?, approver_id=?, approver_note=?, decided_at=NOW()
       WHERE id=?`,
      [newStatus, uid, (note || '').trim() || null, id]
    );

    // (Decision notifications removed.)
    res.json({ success: true, status: newStatus });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete own pending leave (or admin force-delete)
app.delete('/api/leaves/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const uid = req.session.userId;
    const role = req.session.role;
    const [rows] = await db.query('SELECT * FROM leave_requests WHERE id=?', [id]);
    const lr = rows[0];
    if (!lr) return res.status(404).json({ error: 'Not found' });
    if (role !== 'admin' && (lr.user_id !== uid || lr.status !== 'pending')) {
      return res.status(403).json({ error: 'Cannot delete this request' });
    }
    await db.query('DELETE FROM leave_requests WHERE id=?', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// HOLIDAYS — global; everyone reads, admin writes
// Plus helpers used everywhere to decide if a user is "off" on a date.
// ══════════════════════════════════════════════════════
function _toDateStr(v) {
  if (v instanceof Date) return v.toISOString().slice(0,10);
  return String(v).slice(0,10);
}

// dateStr = 'YYYY-MM-DD'; holidaysSet = Set of YYYY-MM-DD strings
// Single source of truth for off-days: the Holiday tab (holidays table).
// Per-user week_off / extra_off are NOT considered — same holiday list applies to everyone.
function isUserOffOn(_user, dateStr, holidaysSet) {
  const ds = _toDateStr(dateStr);
  if (holidaysSet && holidaysSet.has(ds)) return true;
  return false;
}

async function loadHolidaysSet() {
  try {
    const [rows] = await db.query('SELECT DATE_FORMAT(holiday_date,"%Y-%m-%d") AS d FROM holidays');
    return new Set(rows.map(r => r.d));
  } catch (e) {
    console.error('loadHolidaysSet error:', e.message);
    return new Set();
  }
}

// Find next working day on/after fromDate for a given user (max 60 day lookahead)
function nextWorkingDay(user, fromDateStr, holidaysSet) {
  const d = new Date(_toDateStr(fromDateStr) + 'T00:00:00');
  for (let i = 0; i < 60; i++) {
    d.setDate(d.getDate() + 1);
    const yy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    const ds = `${yy}-${mm}-${dd}`;
    if (!isUserOffOn(user, ds, holidaysSet)) return ds;
  }
  return _toDateStr(fromDateStr); // fallback
}

app.get('/api/holidays', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT id, name, DATE_FORMAT(holiday_date,'%Y-%m-%d') AS holiday_date
      FROM holidays ORDER BY holiday_date ASC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/holidays', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { date, name } = req.body;
    if (!date || !name) return res.status(400).json({ error: 'date and name required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });

    await db.query(
      'INSERT INTO holidays (holiday_date, name, created_by) VALUES (?,?,?) ' +
      'ON DUPLICATE KEY UPDATE name=VALUES(name)',
      [date, name.trim(), req.session.userId]
    );

    // Cascade: delete checklist tasks on this date + push delegation tasks forward
    const cascade = await cascadeHolidayDate(date);
    res.json({ success: true, ...cascade });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk holidays — accepts array of {date, name}
app.post('/api/holidays/bulk', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { holidays } = req.body;
    if (!Array.isArray(holidays) || !holidays.length) return res.status(400).json({ error: 'No holidays provided' });

    let added = 0, skipped = 0, errors = [];
    let cascadeDeleted = 0, cascadePushed = 0;

    for (const h of holidays) {
      const date = (h.date || '').trim();
      const name = (h.name || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !name) {
        skipped++; errors.push({ row: h, reason: 'invalid date or empty name' });
        continue;
      }
      try {
        await db.query(
          'INSERT INTO holidays (holiday_date, name, created_by) VALUES (?,?,?) ' +
          'ON DUPLICATE KEY UPDATE name=VALUES(name)',
          [date, name, req.session.userId]
        );
        const c = await cascadeHolidayDate(date);
        cascadeDeleted += c.deletedChecklist || 0;
        cascadePushed += c.pushedDelegation || 0;
        added++;
      } catch (e) {
        skipped++; errors.push({ row: h, reason: e.message });
      }
    }

    res.json({ success: true, added, skipped, cascadeDeleted, cascadePushed, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/holidays/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM holidays WHERE id=?', [parseInt(req.params.id, 10)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// On holiday add: delete checklist tasks on that date + push delegation tasks
async function cascadeHolidayDate(dateStr) {
  let deletedChecklist = 0, pushedDelegation = 0;
  try {
    const [del] = await db.query("DELETE FROM checklist_tasks WHERE due_date=? AND status='pending'", [dateStr]);
    deletedChecklist = del.affectedRows || 0;
  } catch (e) { console.error('cascade checklist:', e.message); }

  try {
    const holidaysSet = await loadHolidaysSet();
    const [delegationsOnDate] = await db.query(
      "SELECT t.id, t.assigned_to, u.week_off, u.extra_off " +
      "FROM delegation_tasks t JOIN users u ON t.assigned_to=u.id " +
      "WHERE t.due_date=? AND t.status='pending'",
      [dateStr]
    );
    for (const t of delegationsOnDate) {
      const newDate = nextWorkingDay(t, dateStr, holidaysSet);
      await db.query('UPDATE delegation_tasks SET due_date=? WHERE id=?', [newDate, t.id]);
      pushedDelegation++;
    }
  } catch (e) { console.error('cascade delegation:', e.message); }

  return { deletedChecklist, pushedDelegation };
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Auth check is handled client-side via /api/me in init() — removing server-side
// requireAuth here prevents app.html from loading if cookie has any timing/domain issue
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// ══════════════════════════════════════════════════════
// EXPORT FOR VERCEL (serverless) + LISTEN FOR LOCAL DEV
// ══════════════════════════════════════════════════════
// On Vercel, the platform handles HTTP — we just export the app.
// Locally (and on traditional hosts), we call app.listen().
if (process.env.VERCEL || process.env.NOW_REGION) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`\n  ✦ Bunai Task Manager: http://localhost:${PORT}`);
    console.log(`  Login: aman@test.com / password\n`);
  });
  module.exports = app;
}