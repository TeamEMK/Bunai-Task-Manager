// ══════════════════════════════════════════════════════
// MIS — per-employee and per-FMS performance over a date range.
// The score is a deficit scale in [-100, 0]: 0 means nothing slipped.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdminOrHodOnly } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errors');
const { placeholders, N } = require('../utils/collections');
const { deficitScore, fmsScore } = require('../utils/scores');
const fmsRepo = require('../services/fmsRepo');

const router = express.Router();

// An HOD only ever sees their own department.
async function deptScope(req, baseParams) {
  if (req.session.role !== 'hod') return { filter: '', params: baseParams };
  const me = await db.one('SELECT department FROM users WHERE id=?', [req.session.userId]);
  return { filter: 'AND u.department=?', params: [...baseParams, me?.department || ''] };
}

const perUserStatsSql = (table, withRevised, deptFilter, extraCols = '') => `
  SELECT u.id AS userId, u.name${extraCols},
    COUNT(*) AS total,
    SUM(CASE WHEN t.status='pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed,
    ${withRevised ? `SUM(CASE WHEN t.status='revised' THEN 1 ELSE 0 END)` : '0'} AS revised,
    SUM(CASE WHEN t.status='pending' AND t.due_date<CURDATE() THEN 1 ELSE 0 END) AS overdue
  FROM ${table} t JOIN users u ON t.assigned_to=u.id
  WHERE t.due_date BETWEEN ? AND ? ${deptFilter}
  GROUP BY u.id, u.name${extraCols} ORDER BY u.name`;

router.get('/mis', requireAuth, requireAdminOrHodOnly, asyncRoute(async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'Dates required' });
  const { filter, params } = await deptScope(req, [start, end]);

  const decorate = rows => rows.map(r => ({
    ...r,
    delayed: N(r.overdue),
    score: deficitScore(r.total, r.pending, r.overdue, r.revised),
  }));

  const [delRows, chlRows] = await Promise.all([
    db.rows(perUserStatsSql('delegation_tasks', true, filter), params),
    db.rows(perUserStatsSql('checklist_tasks', false, filter), params),
  ]);
  res.json({ delegation: decorate(delRows), checklist: decorate(chlRows) });
}));

router.get('/mis/detail', requireAuth, requireAdminOrHodOnly, asyncRoute(async (req, res) => {
  const { userId, type, start, end } = req.query;
  if (!userId || !start || !end) return res.status(400).json({ error: 'Missing params' });
  const table = type === 'delegation' ? 'delegation_tasks' : 'checklist_tasks';
  const tasks = await db.rows(
    `SELECT t.id,t.description,t.status,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,
            u2.name AS assigned_by_name
       FROM ${table} t JOIN users u2 ON t.assigned_by=u2.id
      WHERE t.assigned_to=? AND t.due_date BETWEEN ? AND ?
      ORDER BY t.due_date ASC`, [userId, start, end]);
  res.json({ tasks });
}));

// Reads every FMS sheet once and returns userId → { total, pending, done,
// delayed }. Each step's counts are attributed in full to every one of its
// doers, because the work is shared rather than split.
async function fmsStatsPerUser(start, end) {
  const perUser = new Map();
  const sheets = await db.rows(`SELECT ${fmsRepo.SHEET_COLUMNS} FROM fms_sheets`);
  if (!sheets.length) return perUser;

  const stepsBySheet = await fmsRepo.stepsForSheets(sheets.map(s => s.id));
  const allSteps = sheets.flatMap(s => stepsBySheet.get(s.id) || []);
  if (!allSteps.length) return perUser;
  await fmsRepo.decorateSteps(allSteps);

  // Sheets are fetched concurrently and shared with the /api/mis/fms request
  // that the same page fires alongside this one.
  await Promise.all(sheets.map(async (sheet) => {
    const steps = stepsBySheet.get(sheet.id) || [];
    if (!steps.length) return;
    let grid;
    try { grid = await fmsRepo.readSheetGrid(sheet, steps); }
    catch (_) { return; }          // skip this sheet on error
    if (!grid) return;

    for (const step of steps) {
      if (!step.doerIds.length) continue;
      const stats = fmsRepo.stepStats(grid.dataRows, step, { start, end });
      if (!stats) continue;
      for (const uid of step.doerIds) {
        let agg = perUser.get(uid);
        if (!agg) { agg = { total: 0, pending: 0, done: 0, delayed: 0 }; perUser.set(uid, agg); }
        agg.pending += stats.pending;
        agg.done += stats.done;
        agg.total += stats.total;
        agg.delayed += stats.delayed;
      }
    }
  }));
  return perUser;
}

// ── All MIS — one combined score per employee ─────────
router.get('/mis/all', requireAuth, requireAdminOrHodOnly, asyncRoute(async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'Dates required' });
  const isHod = req.session.role === 'hod';
  const { filter, params } = await deptScope(req, [start, end]);
  const hodDept = isHod ? params[params.length - 1] : null;

  const calc = (total, pending, overdue, revised) => ({
    total: N(total), pending: N(pending), overdue: N(overdue), revised: N(revised),
    score: deficitScore(total, pending, overdue, revised),
  });

  // The task stats, the week plans and every FMS sheet are gathered together —
  // they do not depend on each other.
  const [delRows, chlRows, plans, fmsUserMap] = await Promise.all([
    db.rows(perUserStatsSql('delegation_tasks', true, filter, ', u.department'), params),
    db.rows(perUserStatsSql('checklist_tasks', false, filter, ', u.department'), params),
    db.rows(
      `SELECT employee_id, target_count, DATE_FORMAT(start_date,'%Y-%m-%d') AS start_date, improvement_pct
         FROM week_plans WHERE start_date BETWEEN ? AND ? ORDER BY start_date DESC`, [start, end])
      .catch(() => []),   // week_plans may not exist on an old database
    fmsStatsPerUser(start, end).catch(() => new Map()),
  ]);

  const blank = () => ({ ...calc(0, 0, 0, 0), completed: 0 });
  const userMap = new Map();
  const ensure = (userId, name, department) => {
    let u = userMap.get(userId);
    if (!u) {
      u = { userId, name, department: department || '',
            delegation: blank(), delegationCompleted: 0, checklist: blank(), checklistCompleted: 0 };
      userMap.set(userId, u);
    }
    return u;
  };

  for (const r of delRows) {
    const u = ensure(r.userId, r.name, r.department);
    u.delegation = { ...calc(r.total, r.pending, r.overdue, r.revised), completed: N(r.completed) };
    u.delegationCompleted = N(r.completed);
  }
  for (const r of chlRows) {
    const u = ensure(r.userId, r.name, r.department);
    u.checklist = { ...calc(r.total, r.pending, r.overdue, 0), completed: N(r.completed) };
    u.checklistCompleted = N(r.completed);
  }

  // The most recent plan per employee inside the window wins.
  const planMap = new Map();
  for (const p of plans) if (!planMap.has(p.employee_id)) planMap.set(p.employee_id, p);

  // Somebody whose work is ONLY in FMS has no task rows, so they are added here
  // — otherwise their contribution would not appear at all.
  const fmsOnlyIds = [...fmsUserMap.keys()].filter(id => !userMap.has(id));
  if (fmsOnlyIds.length) {
    let sql = `SELECT id, name, department FROM users WHERE id IN (${placeholders(fmsOnlyIds)})`;
    const qParams = [...fmsOnlyIds];
    if (isHod) { sql += ' AND department=?'; qParams.push(hodDept); }
    for (const u of await db.rows(sql, qParams)) ensure(u.id, u.name, u.department);
  }

  const result = [...userMap.values()].map(u => {
    const d = u.delegation, c = u.checklist;
    const fms = fmsUserMap.get(u.userId) || { total: 0, pending: 0, done: 0, delayed: 0 };
    const totalAll = d.total + c.total + fms.total;
    const pendingAll = d.pending + c.pending + fms.pending;
    const overdueAll = d.overdue + c.overdue + fms.delayed;
    const revisedAll = d.revised;
    const completedAll = d.completed + c.completed + fms.done;
    return {
      ...u,
      fms: { ...fms, score: fms.total > 0 ? fmsScore(fms.total, fms.pending, fms.delayed) : null },
      totalAll, pendingAll, overdueAll, revisedAll, completedAll,
      overallScore: totalAll > 0 ? deficitScore(totalAll, pendingAll, overdueAll, revisedAll) : null,
      plan: planMap.get(u.userId) || null,
    };
  }).filter(u => u.totalAll > 0).sort((a, b) => a.name.localeCompare(b.name));

  res.json(result);
}));

// ── FMS MIS — per sheet, per step ─────────────────────
router.get('/mis/fms', requireAuth, requireAdminOrHodOnly, asyncRoute(async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'Dates required' });
  const isHod = req.session.role === 'hod';

  const sheets = await db.rows(`SELECT ${fmsRepo.SHEET_COLUMNS} FROM fms_sheets ORDER BY fms_name ASC`);
  if (!sheets.length) return res.json([]);

  const [stepsBySheet, me] = await Promise.all([
    fmsRepo.stepsForSheets(sheets.map(s => s.id)),
    isHod ? db.one('SELECT department FROM users WHERE id=?', [req.session.userId]) : null,
  ]);
  const hodDept = me?.department || '';
  await fmsRepo.decorateSteps(sheets.flatMap(s => stepsBySheet.get(s.id) || []));

  // Each sheet is read once, concurrently, and the reads are shared with
  // /api/mis/all through the values cache.
  const results = await Promise.all(sheets.map(async (sheet) => {
    const steps = stepsBySheet.get(sheet.id) || [];
    // HOD: only steps whose doers belong to their department.
    const filteredSteps = isHod ? steps.filter(s => s.doers.some(d => d.department === hodDept)) : steps;
    if (isHod && !filteredSteps.length) return null;

    try {
      const grid = await fmsRepo.readSheetGrid(sheet, filteredSteps);
      if (!grid) return null;

      let fmsPending = 0, fmsDone = 0, fmsTotal = 0, fmsDelayed = 0;
      const perStepStats = [];
      for (const step of filteredSteps) {
        const s = fmsRepo.stepStats(grid.dataRows, step, { start, end });
        if (!s) continue;
        fmsPending += s.pending; fmsDone += s.done; fmsTotal += s.total; fmsDelayed += s.delayed;
        perStepStats.push({
          stepName: step.step_name,
          stepOrder: step.step_order,
          doers: step.doerNames || '—',
          pending: s.pending,
          done: s.done,
          total: s.total,
          delayed: s.delayed,
          score: fmsScore(s.total, s.pending, s.delayed),
        });
      }

      if (!perStepStats.length && isHod) return null;
      return {
        fmsId: sheet.id,
        fmsName: sheet.fms_name || sheet.sheet_name,
        pending: fmsPending, done: fmsDone, total: fmsTotal, delayed: fmsDelayed,
        score: fmsScore(fmsTotal, fmsPending, fmsDelayed),
        steps: perStepStats,
      };
    } catch (e) {
      return {
        fmsId: sheet.id,
        fmsName: sheet.fms_name || sheet.sheet_name,
        pending: 0, done: 0, total: 0, delayed: 0, score: 0,
        steps: [], error: e.message,
      };
    }
  }));

  res.json(results.filter(Boolean));
}));

module.exports = router;
