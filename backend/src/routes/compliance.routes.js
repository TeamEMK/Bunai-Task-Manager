// ══════════════════════════════════════════════════════
// EMPLOYEE 360 + daily-report compliance grid.
// Everything about one employee in one place for an increment review:
// delegation + checklist stats, daily-report compliance, the units they handle,
// a weighted scorecard, and week-by-week committed vs achieved.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const { isYmd, istMondayOf, addDays } = require('../utils/dates');
const { placeholders, indexBy, N } = require('../utils/collections');
const { round1, deficitScoreOrNull } = require('../utils/scores');
const { loadHolidaysSet, isUserOffOn } = require('../services/holidays');

const router = express.Router();

// admin → anyone; hod/pc → their own department; everyone else → themselves.
async function canViewEmployee(req, targetId) {
  const role = req.session.role;
  const uid = req.session.userId;
  if (role === 'admin') return true;
  if (Number(targetId) === Number(uid)) return true;
  if (role === 'hod' || role === 'pc') {
    // Both departments in one query instead of two sequential ones.
    const rows = await db.rows('SELECT id, department FROM users WHERE id IN (?,?)', [uid, targetId]);
    const byId = indexBy(rows, 'id');
    const mine = byId.get(Number(uid))?.department;
    return !!mine && mine === byId.get(Number(targetId))?.department;
  }
  return false;
}

// The window defaults to the current IST month.
function resolveWindow(req) {
  const ist = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
  const yy = ist.getUTCFullYear(), mm = ist.getUTCMonth();
  const defaultFrom = `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  const defaultTo = `${yy}-${String(mm + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return {
    from: isYmd(req.query.from) ? req.query.from : defaultFrom,
    to: isYmd(req.query.to) ? req.query.to : defaultTo,
  };
}

router.get('/compliance/employee/:id', requireAuth, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid employee id' });
  if (!await canViewEmployee(req, id)) throw httpError(403, 'Not allowed');

  const { from, to } = resolveWindow(req);

  // ── Everything that depends only on (id, from, to) is fetched together.
  // Sequentially this was eleven round trips before the page could render.
  const [user, del, chl, clientRows] = await Promise.all([
    db.one(
      `SELECT id, name, email, role, COALESCE(department,'—') AS department,
              COALESCE(week_off,'') AS week_off, COALESCE(extra_off,'') AS extra_off
         FROM users WHERE id=?`, [id]),

    // Task stats, bucketed by due date inside the window.
    db.one(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status='revised'   THEN 1 ELSE 0 END) AS revised,
         SUM(CASE WHEN status='pending' AND due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
        FROM delegation_tasks WHERE assigned_to=? AND due_date BETWEEN ? AND ?`, [id, from, to]),
    db.one(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status='pending' AND due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
        FROM checklist_tasks WHERE assigned_to=? AND due_date BETWEEN ? AND ?`, [id, from, to]),

    // Units this employee handles.
    db.rows(
      `SELECT id, name, COALESCE(is_active,1) AS is_active, logo_url
         FROM clients WHERE handler_id=? ORDER BY COALESCE(is_active,1) DESC, name ASC`, [id]),

  ]);

  if (!user) throw httpError(404, 'Employee not found');

  const delegation = { total: N(del.total), pending: N(del.pending), completed: N(del.completed), revised: N(del.revised), overdue: N(del.overdue) };
  const checklist = { total: N(chl.total), pending: N(chl.pending), completed: N(chl.completed), revised: 0, overdue: N(chl.overdue) };

  // ── What happened on each unit inside the window ─────
  if (clientRows.length) {
    const ids = clientRows.map(c => c.id);
    const ph = placeholders(ids);
    const [dc, cc] = await Promise.all([
      db.rows(`SELECT client_id, COUNT(*) AS total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
                 FROM delegation_tasks WHERE client_id IN (${ph}) AND due_date BETWEEN ? AND ? GROUP BY client_id`, [...ids, from, to]),
      db.rows(`SELECT client_id, COUNT(*) AS total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
                 FROM checklist_tasks WHERE client_id IN (${ph}) AND due_date BETWEEN ? AND ? GROUP BY client_id`, [...ids, from, to]),
    ]);
    const dMap = indexBy(dc, 'client_id');
    const cMap = indexBy(cc, 'client_id');
    for (const c of clientRows) {
      c.is_active = N(c.is_active);
      const d = dMap.get(c.id) || {}, k = cMap.get(c.id) || {};
      c.tasks = N(d.total) + N(k.total);
      c.pending = N(d.pending) + N(k.pending);
      c.activity = c.tasks;
    }
  }
  const clients = {
    total: clientRows.length,
    active: clientRows.filter(c => c.is_active).length,
    inactive: clientRows.filter(c => !c.is_active).length,
    list: clientRows,
  };

  // ── Scorecard. Each section is 0-100, or null when it does not apply to this
  // employee — a null section is dropped and its weight shared among the rest,
  // so nobody is penalised for work they were never given.
  const clamp = n => Math.max(0, Math.min(100, n));
  const cat = {
    delegation: delegation.total > 0
      ? round1(clamp((delegation.completed / delegation.total) * 100 - (delegation.overdue / delegation.total) * 30 - (delegation.revised / delegation.total) * 15))
      : null,
    checklist: checklist.total > 0
      ? round1(clamp((checklist.completed / checklist.total) * 100 - (checklist.overdue / checklist.total) * 30))
      : null,
    clients: clients.total > 0 ? round1(clamp((clients.active / clients.total) * 100)) : null,
  };
  // Daily reports and meetings used to be scored here too; their share is
  // spread over what is left.
  const weights = { delegation: 45, checklist: 35, clients: 20 };
  const present = Object.keys(weights).filter(k => cat[k] !== null);
  const average = present.length ? round1(present.reduce((a, k) => a + cat[k], 0) / present.length) : null;
  let wSum = 0, wTot = 0;
  for (const k of present) { wSum += cat[k] * weights[k]; wTot += weights[k]; }
  const final = wTot ? round1(wSum / wTot) : null;
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

    // Tasks are bucketed by their own Monday in SQL — two grouped queries beat
    // one query per week.
    const wkExpr = `DATE_FORMAT(DATE_SUB(due_date, INTERVAL WEEKDAY(due_date) DAY),'%Y-%m-%d')`;
    const [planRows, delWk, chlWk] = await Promise.all([
      db.rows(
        `SELECT DATE_FORMAT(start_date,'%Y-%m-%d') AS mon, user_committed_score
           FROM week_plans WHERE employee_id=? AND start_date IN (${placeholders(allMons)})`,
        [id, ...allMons]),
      db.rows(
        `SELECT ${wkExpr} AS wk, COUNT(*) AS total,
          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status='revised' THEN 1 ELSE 0 END) AS revised,
          SUM(CASE WHEN status='pending' AND due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
         FROM delegation_tasks WHERE assigned_to=? AND due_date BETWEEN ? AND ? GROUP BY wk`,
        [id, rangeStart, rangeEnd]),
      db.rows(
        `SELECT ${wkExpr} AS wk, COUNT(*) AS total,
          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status='pending' AND due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
         FROM checklist_tasks WHERE assigned_to=? AND due_date BETWEEN ? AND ? GROUP BY wk`,
        [id, rangeStart, rangeEnd]),
    ]);

    const committedBy = new Map();
    for (const r of planRows) committedBy.set(r.mon, r.user_committed_score == null ? null : Number(r.user_committed_score));

    const agg = new Map();
    const bump = (wk, t, p, o, r) => {
      let a = agg.get(wk);
      if (!a) { a = { total: 0, pending: 0, overdue: 0, revised: 0 }; agg.set(wk, a); }
      a.total += t; a.pending += p; a.overdue += o; a.revised += r;
    };
    for (const r of delWk) bump(r.wk, N(r.total), N(r.pending), N(r.overdue), N(r.revised));
    for (const r of chlWk) bump(r.wk, N(r.total), N(r.pending), N(r.overdue), 0);

    const achievedBy = new Map();
    for (const wkMon of allMons) {
      const a = agg.get(wkMon);
      achievedBy.set(wkMon, a ? deficitScoreOrNull(a.total, a.pending, a.overdue, a.revised) : null);
    }
    for (const wkMon of mondays) {
      const committed = committedBy.has(wkMon) ? committedBy.get(wkMon) : null;
      const achieved = achievedBy.get(wkMon);
      const prevAchieved = achievedBy.get(addDays(wkMon, -7));
      const wAgg = agg.get(wkMon) || { total: 0, pending: 0, revised: 0 };
      weekly.push({
        weekStart: wkMon, weekEnd: addDays(wkMon, 6),
        committed, achieved,
        prevAchieved: prevAchieved == null ? null : prevAchieved,
        gap: (committed !== null && achieved !== null && achieved !== undefined)
          ? Math.round((achieved - committed) * 10) / 10 : null,
        // Committing to less than they already achieved last week.
        regression: committed !== null && prevAchieved != null && committed < prevAchieved,
        taskTotal: wAgg.total,
        taskPending: wAgg.pending,
        taskCompleted: Math.max(0, wAgg.total - wAgg.pending - (wAgg.revised || 0)),
      });
    }
  }

  res.json({
    range: { from, to },
    user: { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department },
    delegation, checklist, clients, scores, weekly,
  });
}));

// Drill-down behind a row of the weekly table.
router.get('/compliance/employee/:id/week-tasks', requireAuth, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid employee id' });
  if (!await canViewEmployee(req, id)) throw httpError(403, 'Not allowed');
  const from = isYmd(req.query.from) ? req.query.from : null;
  const to = isYmd(req.query.to) ? req.query.to : null;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

  const [delTasks, chlTasks] = await Promise.all([
    db.rows(
      `SELECT dt.id, dt.description AS title, dt.status, DATE_FORMAT(dt.due_date,'%Y-%m-%d') AS due_date,
              COALESCE(c.name,'—') AS client_name, 'delegation' AS task_type,
              COALESCE(u2.name,'—') AS assigned_by
         FROM delegation_tasks dt
         LEFT JOIN clients c ON c.id = dt.client_id
         LEFT JOIN users u2 ON u2.id = dt.assigned_by
        WHERE dt.assigned_to=? AND dt.due_date BETWEEN ? AND ?
        ORDER BY dt.due_date, dt.id`, [id, from, to]),
    db.rows(
      `SELECT ct.id, ct.description AS title, ct.status, DATE_FORMAT(ct.due_date,'%Y-%m-%d') AS due_date,
              COALESCE(c.name,'—') AS client_name, 'checklist' AS task_type,
              COALESCE(u2.name,'—') AS assigned_by
         FROM checklist_tasks ct
         LEFT JOIN clients c ON c.id = ct.client_id
         LEFT JOIN users u2 ON u2.id = ct.assigned_by
        WHERE ct.assigned_to=? AND ct.due_date BETWEEN ? AND ?
        ORDER BY ct.due_date, ct.id`, [id, from, to]),
  ]);
  res.json([...delTasks, ...chlTasks].sort((a, b) => (a.due_date < b.due_date ? -1 : 1)));
}));

// ── Last-7-days daily-report grid (admin) ─────────────
router.get('/compliance/last7', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }

  const [users, filled, holidaysSet] = await Promise.all([
    db.rows(
      `SELECT id, name, email, role, department,
              COALESCE(week_off,'') AS week_off, COALESCE(extra_off,'') AS extra_off
         FROM users WHERE role IN ('admin','hod','pc','user') ORDER BY name ASC`),
    db.rows(
      `SELECT user_id, DATE_FORMAT(entry_date,'%Y-%m-%d') AS d
         FROM daily_tasks WHERE entry_date BETWEEN ? AND ?
        GROUP BY user_id, entry_date`, [dates[0], dates[dates.length - 1]]),
    loadHolidaysSet(),
  ]);

  // (userId → Set(dates)) so the grid below is a hash lookup, not a scan.
  const filledMap = new Map();
  for (const f of filled) {
    let set = filledMap.get(f.user_id);
    if (!set) { set = new Set(); filledMap.set(f.user_id, set); }
    set.add(f.d);
  }

  // Off-days are marked so the UI does not count them as missed.
  const grid = users.map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    department: u.department || '—',
    status: dates.map(d => ({
      date: d,
      filled: filledMap.get(u.id)?.has(d) || false,
      off: isUserOffOn(u, d, holidaysSet),
      isHoliday: holidaysSet.has(d),
    })),
  }));

  res.json({ dates, users: grid, holidays: [...holidaysSet] });
}));

module.exports = router;
