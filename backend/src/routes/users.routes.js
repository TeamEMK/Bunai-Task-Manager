// ══════════════════════════════════════════════════════
// USERS, PROFILE, DEPARTMENTS
// Password writes all go through services/passwords, so the work factor is a
// setting rather than a literal repeated at six call sites.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const { isYmd } = require('../utils/dates');
const passwords = require('../services/passwords');

const router = express.Router();

const VALID_ROLES = ['admin', 'hod', 'pc', 'user'];
const pickRole = (v, dflt) => (VALID_ROLES.includes(v) ? v : dflt);

// ── PC helper: who currently has pending work ─────────
router.get('/users/with-pending-tasks', requireAuth, asyncRoute(async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  // Bound parameters — this used to interpolate the dates into the SQL text.
  const ranged = isYmd(dateFrom) && isYmd(dateTo);
  const dateFilter = ranged ? 'AND t.due_date BETWEEN ? AND ?' : 'AND t.due_date <= CURDATE()';
  const params = ranged ? [dateFrom, dateTo, dateFrom, dateTo] : [];

  const rows = await db.rows(`
    SELECT u.id, u.name FROM users u
    WHERE u.id IN (
      SELECT assigned_to FROM delegation_tasks t WHERE t.status='pending' ${dateFilter}
      UNION
      SELECT assigned_to FROM checklist_tasks t WHERE t.status='pending' ${dateFilter}
    ) AND u.role NOT IN ('admin','pc')
    ORDER BY u.name ASC`, params);
  res.json(rows);
}));

router.get('/users', requireAuth, asyncRoute(async (req, res) => {
  res.json(await db.rows(
    `SELECT id,name,email,notification_email,role,
            COALESCE(user_role, role) AS user_role,
            phone,department,week_off,extra_off,
            COALESCE(exclude_from_reminder,0) AS exclude_from_reminder
       FROM users ORDER BY role DESC,name ASC`));
}));

router.post('/users', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { name, email, notification_email, password, role, user_role, phone,
          department, week_off, extra_off, exclude_from_reminder } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

  const existing = await db.one('SELECT id FROM users WHERE email=?', [email]);
  if (existing) return res.status(400).json({ error: 'Email already exists' });

  const appRole = pickRole(role, 'user');
  await db.query(
    `INSERT INTO users (name,email,notification_email,password,role,user_role,phone,department,week_off,extra_off,exclude_from_reminder)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [name, email, notification_email || '', await passwords.hash(password), appRole,
     pickRole(user_role, appRole), phone || null, department || '', week_off || '',
     extra_off || '', exclude_from_reminder ? 1 : 0]);
  res.json({ success: true });
}));

router.put('/users/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { name, email, notification_email, role, user_role, password, phone,
          department, week_off, extra_off, exclude_from_reminder } = req.body;
  const appRole = pickRole(role, 'user');
  const common = [name, email, notification_email || '', appRole, pickRole(user_role, appRole)];
  const tail = [phone || null, department || '', week_off || '', extra_off || '',
                exclude_from_reminder ? 1 : 0, req.params.id];

  if (password) {
    await db.query(
      `UPDATE users SET name=?,email=?,notification_email=?,role=?,user_role=?,password=?,
              phone=?,department=?,week_off=?,extra_off=?,exclude_from_reminder=? WHERE id=?`,
      [...common, await passwords.hash(password), ...tail]);
  } else {
    await db.query(
      `UPDATE users SET name=?,email=?,notification_email=?,role=?,user_role=?,
              phone=?,department=?,week_off=?,extra_off=?,exclude_from_reminder=? WHERE id=?`,
      [...common, ...tail]);
  }
  res.json({ success: true });
}));

router.delete('/users/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  if (parseInt(req.params.id, 10) === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  await db.query('DELETE FROM users WHERE id=?', [req.params.id]);
  res.json({ success: true });
}));

// Bulk add via CSV. Existing emails are looked up in one query rather than one
// per row, and the hashes are computed together — bcrypt is the slow part, and
// hashing 50 users one after another used to hold the request open for seconds.
router.post('/users/bulk', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { users } = req.body;
  if (!users || !users.length) return res.status(400).json({ error: 'No users provided' });

  const errors = [];
  const candidates = [];
  for (const u of users) {
    if (!u.name || !u.email || !u.password) { errors.push(`${u.email || '?'}: missing fields`); continue; }
    candidates.push(u);
  }

  let skipped = 0;
  let added = 0;
  if (candidates.length) {
    const emails = candidates.map(u => u.email);
    const taken = new Set((await db.rows(
      `SELECT email FROM users WHERE email IN (${emails.map(() => '?').join(',')})`, emails))
      .map(r => String(r.email).toLowerCase()));

    const fresh = candidates.filter(u => {
      if (taken.has(String(u.email).toLowerCase())) { skipped++; return false; }
      return true;
    });

    if (fresh.length) {
      const hashes = await Promise.all(fresh.map(u => passwords.hash(u.password)));
      const values = fresh.map((u, i) => {
        const appRole = pickRole(u.role, 'user');
        return [u.name, u.email, hashes[i], appRole, pickRole(u.user_role, appRole),
                u.phone || null, u.department || '', u.week_off || '', u.extra_off || ''];
      });
      await db.query(
        `INSERT INTO users (name,email,password,role,user_role,phone,department,week_off,extra_off) VALUES ?`,
        [values]);
      added = values.length;
    }
  }
  res.json({ success: true, added, skipped, errors });
}));

// ── PROFILE ───────────────────────────────────────────
router.put('/profile', requireAuth, asyncRoute(async (req, res) => {
  const uid = req.session.userId;
  const { name, email, notification_email, phone, currentPassword, newPassword, profileImage } = req.body;

  if (currentPassword) {
    const row = await db.one('SELECT password FROM users WHERE id=?', [uid]);
    if (!await passwords.verify(currentPassword, row?.password)) {
      throw httpError(400, 'Current password is incorrect');
    }
    if (newPassword) {
      await db.query(
        'UPDATE users SET name=?,email=?,notification_email=?,phone=?,password=? WHERE id=?',
        [name, email, notification_email || '', phone || null, await passwords.hash(newPassword), uid]);
    } else {
      await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=? WHERE id=?',
        [name, email, notification_email || '', phone || null, uid]);
    }
  } else {
    await db.query('UPDATE users SET name=?,email=?,notification_email=?,phone=? WHERE id=?',
      [name, email, notification_email || '', phone || null, uid]);
  }

  if (profileImage !== undefined) {
    await db.query('UPDATE users SET profile_image=? WHERE id=?', [profileImage || null, uid]);
  }
  req.session.name = name;
  res.json({ success: true });
}));

router.post('/profile/image', requireAuth, asyncRoute(async (req, res) => {
  await db.query('UPDATE users SET profile_image=? WHERE id=?', [req.body.image || null, req.session.userId]);
  res.json({ success: true });
}));

// ── DEPARTMENTS — the distinct list, plus one the org uses without a user ──
router.get('/departments', requireAuth, asyncRoute(async (req, res) => {
  const rows = await db.rows(
    `SELECT DISTINCT department FROM users
      WHERE department IS NOT NULL AND department != ''
      ORDER BY department ASC`);
  const merged = [...new Set([...rows.map(r => r.department), 'YouTube'])]
    .sort((a, b) => a.localeCompare(b));
  res.json(merged);
}));

module.exports = router;
