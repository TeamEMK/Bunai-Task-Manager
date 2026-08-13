// ══════════════════════════════════════════════════════
// DAILY TASK REPORT — what each person actually spent the day on.
// One submission per person per date; editing is deliberately not allowed.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errors');
const { serverToday } = require('../utils/dates');

const router = express.Router();

// Has the caller already submitted for this date?
router.get('/daily-tasks/status', requireAuth, asyncRoute(async (req, res) => {
  const date = req.query.date || serverToday();
  const row = await db.one(
    'SELECT COUNT(*) AS cnt FROM daily_tasks WHERE user_id=? AND entry_date=?',
    [req.session.userId, date]);
  res.json({ submitted: row.cnt > 0, date });
}));

router.get('/daily-tasks/mine', requireAuth, asyncRoute(async (req, res) => {
  res.json(await db.rows(
    `SELECT id, DATE_FORMAT(entry_date,'%Y-%m-%d') AS entry_date,
            client_name, department, description, duration_min, created_at
       FROM daily_tasks WHERE user_id=?
      ORDER BY entry_date DESC, id DESC LIMIT 200`, [req.session.userId]));
}));

// Submit — several rows in a single call.
router.post('/daily-tasks', requireAuth, asyncRoute(async (req, res) => {
  const { entry_date, rows } = req.body;
  if (!entry_date || !Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'Date and at least 1 row required' });
  }

  // Only today or yesterday may be filled.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const todayStr = today.toISOString().split('T')[0];
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  if (entry_date !== todayStr && entry_date !== yesterdayStr) {
    return res.status(400).json({ error: 'Only today or yesterday entries are allowed' });
  }

  const cleanRows = [];
  for (const r of rows) {
    const client = (r.client_name || '').trim();
    const dept = (r.department || '').trim();
    const desc = (r.description || '').trim();
    const dur = parseInt(r.duration_min, 10) || 0;
    if (!client || !desc || dur <= 0) {
      return res.status(400).json({ error: 'Each row needs client, description, and duration > 0' });
    }
    cleanRows.push([req.session.userId, entry_date, client, dept, desc, dur]);
  }

  const lock = await db.one(
    'SELECT COUNT(*) AS cnt FROM daily_tasks WHERE user_id=? AND entry_date=?',
    [req.session.userId, entry_date]);
  if (lock.cnt > 0) {
    return res.status(400).json({ error: 'You have already submitted for this date. Editing is not allowed.' });
  }

  await db.query(
    `INSERT INTO daily_tasks (user_id, entry_date, client_name, department, description, duration_min) VALUES ?`,
    [cleanRows]);
  res.json({ success: true, count: cleanRows.length });
}));

// Admin view — every entry, with filters.
router.get('/daily-tasks/all', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { from, to, userId } = req.query;
  let where = '1=1';
  const params = [];
  if (from) { where += ' AND dt.entry_date >= ?'; params.push(from); }
  if (to) { where += ' AND dt.entry_date <= ?'; params.push(to); }
  if (userId) { where += ' AND dt.user_id = ?'; params.push(userId); }

  res.json(await db.rows(
    `SELECT dt.id, DATE_FORMAT(dt.entry_date,'%Y-%m-%d') AS entry_date,
            dt.client_name, dt.department, dt.description, dt.duration_min,
            u.name AS doer_name, u.email AS doer_email
       FROM daily_tasks dt
       JOIN users u ON dt.user_id = u.id
      WHERE ${where}
      ORDER BY dt.entry_date DESC, dt.id DESC
      LIMIT 1000`, params));
}));

// Monthly report — summary + every entry of the month.
router.get('/daily-tasks/report', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const now = new Date();
  const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM' });

  const [year, mm] = month.split('-').map(Number);
  const fromDate = `${year}-${String(mm).padStart(2, '0')}-01`;
  const lastDay = new Date(year, mm, 0).getDate();
  const toDate = `${year}-${String(mm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const rows = await db.rows(
    `SELECT dt.id, DATE_FORMAT(dt.entry_date,'%Y-%m-%d') AS entry_date,
            dt.client_name, dt.department, dt.description, dt.duration_min,
            dt.user_id, u.name AS doer_name, u.email AS doer_email,
            COALESCE(u.department, '') AS doer_department
       FROM daily_tasks dt
       JOIN users u ON dt.user_id = u.id
      WHERE dt.entry_date BETWEEN ? AND ?
      ORDER BY dt.entry_date ASC, u.name ASC, dt.id ASC`, [fromDate, toDate]);

  // Per-user totals, accumulated in one pass over the rows.
  const totals = new Map();
  let totalMinutes = 0;
  for (const r of rows) {
    let u = totals.get(r.user_id);
    if (!u) {
      u = { user_id: r.user_id, name: r.doer_name, email: r.doer_email,
            department: r.doer_department, total_minutes: 0, total_tasks: 0, days_filled: new Set() };
      totals.set(r.user_id, u);
    }
    u.total_minutes += r.duration_min;
    u.total_tasks += 1;
    u.days_filled.add(r.entry_date);
    totalMinutes += r.duration_min;
  }
  const summary = [...totals.values()]
    .map(u => ({ ...u, days_filled: u.days_filled.size }))
    .sort((a, b) => b.total_minutes - a.total_minutes);

  res.json({
    month, from: fromDate, to: toDate,
    total_entries: rows.length,
    total_minutes: totalMinutes,
    summary,
    entries: rows,
  });
}));

module.exports = router;
