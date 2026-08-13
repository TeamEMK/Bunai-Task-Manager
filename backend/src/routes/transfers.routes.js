// ══════════════════════════════════════════════════════
// TASK TRANSFERS — hand a task to someone else, subject to approval.
//
// Every endpoint here used to run one query per task row. Transferring 20 tasks
// cost ~80 round trips and listing the approval queue cost one query per row on
// top of the list query itself. All of that is batched now: the ids are
// collected, fetched in a single IN (…) query, and joined in memory by Map.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdminOrHod } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const { placeholders, indexBy, groupBy } = require('../utils/collections');
const { getTable } = require('./tasks.routes');

const router = express.Router();

const TASK_TYPES = ['delegation', 'checklist'];

// Loads the given (taskId, taskType) pairs — one query per table, not per task.
// Returns Map("<type>:<id>" → row).
async function loadTasks(pairs, columns) {
  const byType = groupBy(pairs, p => (p.taskType === 'delegation' ? 'delegation' : 'checklist'));
  const out = new Map();
  await Promise.all([...byType.entries()].map(async ([type, items]) => {
    const ids = [...new Set(items.map(i => i.taskId))];
    if (!ids.length) return;
    const rows = await db.rows(
      `SELECT ${columns} FROM ${getTable(type)} WHERE id IN (${placeholders(ids)})`, ids);
    for (const r of rows) out.set(`${type}:${r.id}`, r);
  }));
  return out;
}

// POST — create transfer requests (user / hod / admin)
router.post('/transfers', requireAuth, asyncRoute(async (req, res) => {
  const { tasks, toUserId } = req.body;   // tasks = [{ taskId, taskType }]
  if (!tasks || !tasks.length || !toUserId) throw httpError(400, 'Tasks and target user required');

  const uid = req.session.userId;
  const role = req.session.role;

  const taskMap = await loadTasks(tasks, 'id, assigned_to');
  const keyOf = t => `${t.taskType === 'delegation' ? 'delegation' : 'checklist'}:${t.taskId}`;

  // ── Validate: a user may move only their own work, a HOD only their
  // department's, an admin anything.
  for (const t of tasks) {
    const task = taskMap.get(keyOf(t));
    if (!task) throw httpError(404, `Task ${t.taskId} not found`);
    if (role === 'user' && task.assigned_to !== uid) throw httpError(403, 'You can only transfer your own tasks');
  }

  if (role === 'hod') {
    // One query for every doer's department plus the HOD's own, instead of two
    // per task.
    const ids = [...new Set([uid, ...tasks.map(t => taskMap.get(keyOf(t)).assigned_to)])];
    const users = indexBy(
      await db.rows(`SELECT id, department FROM users WHERE id IN (${placeholders(ids)})`, ids), 'id');
    const myDept = users.get(uid)?.department;
    for (const t of tasks) {
      const doerId = taskMap.get(keyOf(t)).assigned_to;
      if (users.get(doerId)?.department !== myDept) {
        throw httpError(403, 'HOD can only transfer tasks of their department');
      }
    }
  }

  // ── Skip anything that already has a pending request, then insert the rest
  // in one statement.
  const pendingKeys = new Set();
  await Promise.all(TASK_TYPES.map(async (type) => {
    const ids = tasks.filter(t => (t.taskType === 'delegation' ? 'delegation' : 'checklist') === type)
      .map(t => t.taskId);
    if (!ids.length) return;
    const rows = await db.rows(
      `SELECT task_id FROM task_transfers
        WHERE task_type=? AND status='pending' AND task_id IN (${placeholders(ids)})`, [type, ...ids]);
    for (const r of rows) pendingKeys.add(`${type}:${r.task_id}`);
  }));

  const values = [];
  let skipped = 0;
  const seen = new Set();
  for (const t of tasks) {
    const key = keyOf(t);
    if (pendingKeys.has(key) || seen.has(key)) { skipped++; continue; }
    seen.add(key);
    const type = key.split(':')[0];
    values.push([t.taskId, type, taskMap.get(key).assigned_to, toUserId, uid, 'pending']);
  }
  if (values.length) {
    await db.query(
      `INSERT INTO task_transfers (task_id, task_type, from_user, to_user, requested_by, status) VALUES ?`,
      [values]);
  }

  res.json({ success: true, count: values.length, skipped });
}));

// GET — task ids that already have a pending transfer, so the UI can grey them out
router.get('/transfers/pending-tasks', requireAuth, asyncRoute(async (req, res) => {
  res.json(await db.rows(
    `SELECT task_id, task_type FROM task_transfers WHERE status='pending' AND requested_by=?`,
    [req.session.userId]));
}));

// Attaches description/due_date to transfer rows in two queries total.
async function attachTaskDetails(rows, { withDueDate = true } = {}) {
  if (!rows.length) return rows;
  const details = await loadTasks(
    rows.map(r => ({ taskId: r.task_id, taskType: r.task_type })),
    withDueDate ? `id, description, DATE_FORMAT(due_date,'%Y-%m-%d') AS due_date` : 'id, description');
  for (const r of rows) {
    const t = details.get(`${r.task_type === 'delegation' ? 'delegation' : 'checklist'}:${r.task_id}`);
    r.description = t?.description || '—';
    if (withDueDate) r.due_date = t?.due_date || '—';
  }
  return rows;
}

// GET — pending transfers awaiting approval (admin sees all, HOD sees their dept)
router.get('/transfers', requireAuth, requireAdminOrHod, asyncRoute(async (req, res) => {
  let deptFilter = '';
  let params = [];

  if (req.session.role === 'hod') {
    const me = await db.one('SELECT department FROM users WHERE id=?', [req.session.userId]);
    const deptUsers = await db.rows('SELECT id FROM users WHERE department=?', [me?.department || '']);
    if (!deptUsers.length) return res.json([]);
    const ids = deptUsers.map(u => u.id);
    deptFilter = `AND (tt.from_user IN (${placeholders(ids)}) OR tt.to_user IN (${placeholders(ids)}))`;
    params = [...ids, ...ids];
  }

  const rows = await db.rows(`
    SELECT tt.*,
      uf.name AS fromUserName, ut.name AS toUserName,
      ur.name AS requestedByName,
      uf.department AS fromDept
    FROM task_transfers tt
    JOIN users uf ON tt.from_user = uf.id
    JOIN users ut ON tt.to_user = ut.id
    JOIN users ur ON tt.requested_by = ur.id
    WHERE tt.status = 'pending' ${deptFilter}
    ORDER BY tt.created_at DESC`, params);

  res.json(await attachTaskDetails(rows));
}));

// GET — badge count
router.get('/transfers/count', requireAuth, requireAdminOrHod, asyncRoute(async (req, res) => {
  if (req.session.role === 'admin') {
    const r = await db.one(`SELECT COUNT(*) AS c FROM task_transfers WHERE status='pending'`);
    return res.json({ count: r.c });
  }
  const me = await db.one('SELECT department FROM users WHERE id=?', [req.session.userId]);
  const deptUsers = await db.rows('SELECT id FROM users WHERE department=?', [me?.department || '']);
  if (!deptUsers.length) return res.json({ count: 0 });
  const ids = deptUsers.map(u => u.id);
  const r = await db.one(
    `SELECT COUNT(*) AS c FROM task_transfers
      WHERE status='pending' AND (from_user IN (${placeholders(ids)}) OR to_user IN (${placeholders(ids)}))`,
    [...ids, ...ids]);
  res.json({ count: r.c });
}));

// PUT — approve or reject
router.put('/transfers/:id', requireAuth, requireAdminOrHod, asyncRoute(async (req, res) => {
  const { action, note } = req.body;   // 'approved' | 'rejected'
  const tr = await db.one('SELECT * FROM task_transfers WHERE id=?', [req.params.id]);
  if (!tr) throw httpError(404, 'Transfer not found');

  await db.query('UPDATE task_transfers SET status=?, note=? WHERE id=?', [action, note || '', req.params.id]);
  if (action === 'approved') {
    await db.query(`UPDATE ${getTable(tr.task_type)} SET assigned_to=? WHERE id=?`, [tr.to_user, tr.task_id]);
  }
  res.json({ success: true });
}));

// GET — my own sent requests, so a user can track them
router.get('/transfers/my', requireAuth, asyncRoute(async (req, res) => {
  const rows = await db.rows(`
    SELECT tt.*, uf.name AS fromUserName, ut.name AS toUserName
    FROM task_transfers tt
    JOIN users uf ON tt.from_user = uf.id
    JOIN users ut ON tt.to_user = ut.id
    WHERE tt.requested_by=?
    ORDER BY tt.created_at DESC LIMIT 20`, [req.session.userId]);
  res.json(await attachTaskDetails(rows, { withDueDate: false }));
}));

module.exports = router;
