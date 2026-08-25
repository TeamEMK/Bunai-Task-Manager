// ══════════════════════════════════════════════════════
// TASKS — delegation + checklist. Both live in near-identical tables, so
// `getTable()` picks the table and the column lists below cover the difference.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const { normDate, normFreq, serverToday } = require('../utils/dates');
const { placeholders, indexBy } = require('../utils/collections');
const { loadHolidaysSet, isUserOffOn, nextWorkingDay } = require('../services/holidays');
const wa = require('../services/whatsapp');

const router = express.Router();

const getTable = (type) => (type === 'delegation' ? 'delegation_tasks' : 'checklist_tasks');

// Whole-number id or nothing — every :id/:userId param goes through this so a
// stray string can never reach the query.
const intParam = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

// ── GET /api/tasks — the All Tasks / My Tasks list ────
router.get('/tasks', requireAuth, asyncRoute(async (req, res) => {
  const uid = req.session.userId;
  const role = req.session.role;
  const isAdmin = role === 'admin';
  const isHod = role === 'hod';
  const { type, mine, full } = req.query;
  const isMine = (mine === '1' || mine === 'true');
  const isFull = (full === '1' || full === 'true');
  const taskType = type || 'delegation';
  const table = getTable(taskType);
  const isDeleg = taskType === 'delegation';

  let where = 'WHERE 1=1';
  const params = [];

  if (isMine) {
    // "Delegated by me" — role scoping is skipped on purpose: any role may see
    // the tasks they themselves assigned.
    where += ' AND t.assigned_by = ?';
    params.push(uid);
  } else if (isAdmin || role === 'pc') {
    // Admin/PC — everything is visible
  } else if (isHod) {
    // HOD — tasks of users in their own department
    const me = await db.one('SELECT department FROM users WHERE id=?', [uid]);
    const deptUsers = await db.rows('SELECT id FROM users WHERE department=?', [me?.department || '']);
    if (!deptUsers.length) return res.json({ grouped: [] });
    const ids = deptUsers.map(u => u.id);
    where += ` AND t.assigned_to IN (${placeholders(ids)})`;
    params.push(...ids);
  } else {
    where += ' AND t.assigned_to = ?';
    params.push(uid);
  }

  // Delegation shows all future tasks (they have to be transferable).
  // Checklist is recurring, so only today-or-earlier rows count as pending —
  // except in the Admin/HOD "All Checklist" view (full=1), which is the history.
  if (!isDeleg && !(isFull && (isAdmin || isHod))) where += ' AND t.due_date <= CURDATE()';

  const typeSpecific = isDeleg
    ? `COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,
       t.approver_id,u3.name AS approverName,t.remarks,t.revise_reason,t.url,`
    : `'no' AS approval,0 AS waiting_approval,NULL AS approver_id,NULL AS approverName,
       t.remarks,NULL AS url,`;
  const seriesCols = isDeleg
    ? `NULL AS end_date,NULL AS frequency,`
    : `DATE_FORMAT(t.end_date,'%Y-%m-%d') AS end_date,t.frequency,`;

  const tasks = await db.rows(
    `SELECT t.id,'${taskType}' AS type,t.description,t.status,t.assigned_to,t.assigned_by,
            COALESCE(t.priority,'low') AS priority,${typeSpecific}
            t.client_id,c.name AS client_name,
            DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,${seriesCols}
            u1.name AS assignedToName,u2.name AS assignedByName
       FROM ${table} t
       JOIN users u1 ON t.assigned_to=u1.id
       JOIN users u2 ON t.assigned_by=u2.id
       ${isDeleg ? 'LEFT JOIN users u3 ON t.approver_id=u3.id' : ''}
       LEFT JOIN clients c ON t.client_id=c.id
       ${where} ORDER BY t.due_date ASC`, params);

  // mine=1 always returns a flat list (never grouped)
  if (isMine) return res.json({ tasks });

  if (isAdmin || isHod || role === 'pc') {
    const grouped = new Map();
    for (const t of tasks) {
      let g = grouped.get(t.assigned_to);
      if (!g) { g = { userId: t.assigned_to, name: t.assignedToName, tasks: [] }; grouped.set(t.assigned_to, g); }
      g.tasks.push(t);
    }
    return res.json({ grouped: [...grouped.values()] });
  }
  res.json({ tasks });
}));

// Looks up the doer, the assigner and (optionally) the client in ONE users
// query instead of three sequential ones, then sends the WhatsApp notice.
// Fire-and-forget: a failure here never affects the task-creation response.
function notifyTaskCreated({ doerId, byId, clientId, build }) {
  (async () => {
    try {
      const ids = [...new Set([doerId, byId].filter(Boolean))];
      const [users, client] = await Promise.all([
        db.rows(`SELECT id, name, phone FROM users WHERE id IN (${placeholders(ids)})`, ids),
        clientId ? db.one('SELECT name FROM clients WHERE id=? LIMIT 1', [clientId]) : null,
      ]);
      const usersById = indexBy(users, 'id');
      const doer = usersById.get(doerId);
      if (!doer || !doer.phone) return;
      await build({ doer, byUser: usersById.get(byId) || null, clientName: client ? client.name : null });
    } catch (e) { console.error('WhatsApp notify error:', e.message); }
  })();
}

// ── POST /api/tasks — create one task ─────────────────
router.post('/tasks', requireAuth, asyncRoute(async (req, res) => {
  const { type, desc, assignedTo, approverEmail, approver, date, priority, approval, remarks,
          client_id, clientId, url } = req.body;
  const endDateVal = normDate(req.body.endDate != null ? req.body.endDate : req.body.end_date);
  const frequencyVal = normFreq(req.body.frequency);
  const clientIdInt = (() => {
    const n = parseInt(client_id != null ? client_id : clientId, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  const role = req.session.role;
  // Admin, HOD and regular users can all assign to others; fall back to self.
  const canAssignOthers = role === 'admin' || role === 'hod' || role === 'user';
  const targetUser = (canAssignOthers && assignedTo) ? parseInt(assignedTo, 10) : req.session.userId;
  if (!desc || !date) return res.status(400).json({ error: 'Description and date required' });

  const isDelegation = (type || 'checklist') === 'delegation';

  // Holiday / week-off check — auto-adjust the due date if needed.
  let effectiveDate = date;
  let adjusted = false, adjustedReason = '';
  try {
    const [holidaysSet, doerUser] = await Promise.all([
      loadHolidaysSet(),
      db.one('SELECT week_off, extra_off FROM users WHERE id=? LIMIT 1', [targetUser]),
    ]);
    if (doerUser && isUserOffOn(doerUser, date, holidaysSet)) {
      if (isDelegation) {
        effectiveDate = nextWorkingDay(doerUser, date, holidaysSet);
        adjusted = true;
        adjustedReason = `Original date was a holiday/week-off — moved to ${effectiveDate}`;
      } else {
        // Checklist: a series simply has no entry on an off day.
        return res.json({ success: true, skipped: true, reason: 'Skipped — selected date is a holiday or doer\'s week-off' });
      }
    }
  } catch (e) { console.error('holiday check error:', e.message); }

  if (isDelegation) {
    // assigned_by is always the real delegator. The chosen approver is stored
    // separately in approver_id so the doer can never approve their own work.
    const assignedBy = req.session.userId;
    let approverId = null;
    if ((approval || 'no') === 'yes') {
      if (approverEmail) {
        const row = await db.one('SELECT id FROM users WHERE email=? LIMIT 1', [approverEmail]);
        if (row) approverId = row.id;
      } else if (approver) {
        const apId = parseInt(approver, 10);
        if (apId) {
          const row = await db.one('SELECT id FROM users WHERE id=? LIMIT 1', [apId]);
          if (row) approverId = row.id;
        }
      }
      if (!approverId) return res.status(400).json({ error: 'Please select a valid approver for this task.' });
      if (approverId === targetUser) return res.status(400).json({ error: 'The approver cannot be the same person as the doer.' });
    }

    await db.query(
      `INSERT INTO delegation_tasks
         (description,assigned_to,assigned_by,due_date,status,priority,approval,waiting_approval,approver_id,remarks,client_id,url)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [desc, targetUser, assignedBy, effectiveDate, 'pending', priority || 'low',
       approval || 'no', 0, approverId, remarks || '', clientIdInt, url || null]);

    notifyTaskCreated({
      doerId: targetUser, byId: assignedBy, clientId: clientIdInt,
      build: ({ doer, byUser, clientName }) => wa.sendDelegationMessage(doer.phone, {
        doerName: doer.name,
        assignedByName: byUser ? byUser.name : '',
        dueDate: effectiveDate,
        priority: priority || 'low',
        description: desc,
        clientName,
        remarks: remarks || '',
      }),
    });
  } else {
    await db.query(
      `INSERT INTO checklist_tasks
         (description,assigned_to,assigned_by,due_date,end_date,frequency,status,priority,remarks,client_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [desc, targetUser, req.session.userId, effectiveDate, endDateVal, frequencyVal,
       'pending', priority || 'low', remarks || '', clientIdInt]);

    notifyTaskCreated({
      doerId: targetUser, byId: req.session.userId, clientId: clientIdInt,
      build: ({ doer, byUser, clientName }) => wa.queueMessage(doer.phone,
        wa.buildChecklistCreatedMessage({
          doerName: doer.name,
          assignedByName: byUser ? byUser.name : '',
          description: desc,
          frequency: frequencyVal,
          startDate: effectiveDate,
          endDate: endDateVal,
          totalTasks: 1,
          clientName,
          remarks: remarks || '',
        }), { delayMs: wa.checklistCreatedDelayMs, label: 'checklist-created' }),
    });
  }
  res.json({ success: true, adjusted, effectiveDate, adjustedReason });
}));

// ── POST /api/tasks/bulk-checklist — a whole recurring series ──
router.post('/tasks/bulk-checklist', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { desc, assignedTo, priority, remarks, client_id, clientId } = req.body;
  let { dates } = req.body;
  if (!desc || !assignedTo || !dates || !dates.length) return res.status(400).json({ error: 'Missing fields' });
  const cid = (() => {
    const n = parseInt(client_id != null ? client_id : clientId, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  const frequencyVal = normFreq(req.body.frequency);
  // If the client sent no end date, the last generated date is the end date.
  const endDateVal = normDate(req.body.endDate != null ? req.body.endDate : req.body.end_date)
    || normDate([...dates].sort().pop());

  // Drop holiday + week-off dates for this user.
  let skippedCount = 0;
  try {
    const [holidaysSet, doerUser] = await Promise.all([
      loadHolidaysSet(),
      db.one('SELECT week_off, extra_off FROM users WHERE id=? LIMIT 1', [parseInt(assignedTo, 10)]),
    ]);
    if (doerUser) {
      const filtered = dates.filter(d => !isUserOffOn(doerUser, d, holidaysSet));
      skippedCount = dates.length - filtered.length;
      if (!filtered.length) {
        return res.json({ success: true, count: 0, skipped: skippedCount, message: 'All dates were holidays / week-offs — nothing inserted' });
      }
      dates = filtered;
    }
  } catch (e) { console.error('bulk-checklist holiday filter err:', e.message); }

  const values = dates.map(date => [desc, parseInt(assignedTo, 10), req.session.userId, date,
    endDateVal, frequencyVal, 'pending', priority || 'low', remarks || '', cid]);
  await db.query(
    `INSERT INTO checklist_tasks
       (description,assigned_to,assigned_by,due_date,end_date,frequency,status,priority,remarks,client_id)
     VALUES ?`, [values]);

  // ONE summary message for the whole series, not one per row.
  const sortedDates = [...dates].sort();
  notifyTaskCreated({
    doerId: parseInt(assignedTo, 10), byId: req.session.userId, clientId: cid,
    build: ({ doer, byUser, clientName }) => wa.queueMessage(doer.phone,
      wa.buildChecklistCreatedMessage({
        doerName: doer.name,
        assignedByName: byUser ? byUser.name : '',
        description: desc,
        frequency: frequencyVal,
        startDate: sortedDates[0],
        endDate: endDateVal,
        totalTasks: dates.length,
        clientName,
        remarks: remarks || '',
      }), { delayMs: wa.checklistCreatedDelayMs, label: 'checklist-created' }),
  });

  res.json({ success: true, count: dates.length, skipped: skippedCount, endDate: endDateVal, frequency: frequencyVal });
}));

// ── PUT /api/tasks/:id/status — done / revised ────────
router.put('/tasks/:id/status', requireAuth, asyncRoute(async (req, res) => {
  const { status, type, newDate, reason } = req.body;
  const tType = type || 'delegation';
  const table = getTable(tType);
  const id = intParam(req.params.id);
  if (!id) throw httpError(400, 'Invalid task id');

  const isAdmin = req.session.role === 'admin';
  const isPC = req.session.role === 'pc';
  const uid = req.session.userId;

  const task = await db.one(
    `SELECT id, assigned_to, assigned_by${tType === 'delegation' ? ', approval, approver_id' : ''}
       FROM ${table} WHERE id=?`, [id]);
  if (!task) throw httpError(404, 'Task not found');

  const isDoer = task.assigned_to === uid;
  if (!isAdmin && !isPC && !isDoer) throw httpError(403, 'Not allowed');

  const needsApproval = tType === 'delegation' && task.approval === 'yes';
  // Admin/PC may act directly ONLY when they are not the task's own doer.
  // The doer can NEVER self-complete or self-approve an approval-required task.
  const canOverride = (isAdmin || isPC) && !isDoer;

  if (needsApproval && !canOverride) {
    // Route through the chosen approver — nothing is finalised here.
    const approverId = task.approver_id || task.assigned_by;
    if (!approverId || approverId === task.assigned_to) {
      throw httpError(400, 'No valid approver is set for this task. Please ask an admin to set an approver.');
    }
    const existing = await db.one(
      `SELECT id FROM task_approvals WHERE task_id=? AND task_type=? AND status='pending'`, [id, tType]);
    if (existing) throw httpError(400, 'An approval request is already pending for this task.');

    const pendingNewDate = (status === 'revised' && newDate) ? newDate : null;
    await db.query(
      `INSERT INTO task_approvals (task_id,task_type,requested_by,requested_to,action_type,status,note,new_date)
       VALUES (?,?,?,?,?,'pending',?,?)`,
      [id, tType, uid, approverId, status, reason || '', pendingNewDate]);
    // Keep the ORIGINAL status and due date until the approver decides.
    await db.query(`UPDATE ${table} SET waiting_approval=1 WHERE id=?`, [id]);
    return res.json({ success: true, needsApproval: true });
  }

  // No approval needed, or an admin/PC override → apply immediately.
  // One UPDATE, not three: status, the revised date and the revision reason all
  // belong to the same row. The reason used to be written only into
  // task_approvals, so a revision that needed no approval lost it.
  const sets = ['status=?'];
  const values = [status];
  if (tType === 'delegation') sets.push('waiting_approval=0');
  if (status === 'revised' && newDate) { sets.push('due_date=?'); values.push(newDate); }
  if (status === 'revised') { sets.push('revise_reason=?'); values.push(reason || null); }
  await db.query(`UPDATE ${table} SET ${sets.join(',')} WHERE id=?`, [...values, id]);

  // Clear any leftover pending approval (e.g. after an admin override).
  await db.query(`DELETE FROM task_approvals WHERE task_id=? AND task_type=? AND status='pending'`, [id, tType]);
  res.json({ success: true, needsApproval: false });
}));

router.get('/tasks/:id/detail', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const table = getTable(req.query.type || 'delegation');
  const task = await db.one(
    `SELECT t.*,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date FROM ${table} t WHERE t.id=?`,
    [req.params.id]);
  if (!task) throw httpError(404, 'Task not found');
  res.json({ task });
}));

router.put('/tasks/:id/edit', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { type, desc, date, priority, approval, remarks, url } = req.body;
  const table = getTable(type || 'delegation');
  if (type === 'delegation') {
    await db.query(
      `UPDATE ${table} SET description=?,due_date=?,priority=?,approval=?,remarks=?,url=? WHERE id=?`,
      [desc, date, priority || 'low', approval || 'no', remarks || '', url || null, req.params.id]);
  } else {
    await db.query(`UPDATE ${table} SET description=?,due_date=?,remarks=? WHERE id=?`,
      [desc, date, remarks || '', req.params.id]);
  }
  res.json({ success: true });
}));

router.delete('/tasks/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  await db.query(`DELETE FROM ${getTable(req.query.type || 'delegation')} WHERE id=?`, [req.params.id]);
  res.json({ success: true });
}));

// Bulk delete by user
router.delete('/tasks/user/:userId', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const table = getTable(req.query.type || 'delegation');
  await db.query(`DELETE FROM ${table} WHERE assigned_to = ?`, [req.params.userId]);
  res.json({ success: true });
}));

// Move every still-pending task of a user to today
router.put('/tasks/user/:userId/transfer-today', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const table = getTable(req.query.type || 'delegation');
  await db.query(`UPDATE ${table} SET due_date=? WHERE assigned_to=? AND status='pending'`,
    [serverToday(), req.params.userId]);
  res.json({ success: true });
}));

// ⚠️ Reachability note: DELETE /api/tasks/:id above matches "delete-by-date"
// first, so this handler never runs — exactly as in the original file. Moving
// it above /tasks/:id would switch on a bulk delete that has been inert for the
// whole life of the app, so the order is left as it was, deliberately.
router.delete('/tasks/delete-by-date', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Date required' });
  const [result] = await db.query('DELETE FROM checklist_tasks WHERE due_date=?', [date]);
  res.json({ success: true, deleted: result.affectedRows });
}));

// Count a user's checklist rows (all time, or one year)
router.get('/tasks/checklist-year-count', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { userId, year } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const row = (!year || year === 'all')
    ? await db.one(`SELECT COUNT(*) AS count FROM checklist_tasks WHERE assigned_to=?`, [userId])
    : await db.one(`SELECT COUNT(*) AS count FROM checklist_tasks WHERE assigned_to=? AND YEAR(due_date)=?`, [userId, year]);
  res.json({ count: row.count });
}));

// POST (not DELETE) so the body always survives proxies
router.post('/tasks/checklist-year-delete', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const [result] = await db.query(`DELETE FROM checklist_tasks WHERE assigned_to=?`, [userId]);
  res.json({ success: true, deleted: result.affectedRows });
}));

// ── Checklist SERIES (groups) ─────────────────────────
// One "checklist" is an entire recurring series sharing a description (can be
// 365 rows). This groups a user's checklists so an admin can delete a chosen
// series rather than all of them.
router.get('/tasks/checklist-groups', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const userId = parseInt(req.query.userId, 10);
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const groups = await db.rows(
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
  res.json({ groups });
}));

// body: { userId, groups: [{ description, frequency }], scope: 'all' | 'future' }
//   scope 'all'    → every row of that checklist (history included)
//   scope 'future' → only pending rows from today onward (history preserved)
router.post('/tasks/checklist-group-delete', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
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
    // frequency '' means rows saved before frequency existed — match NULL and ''
    if (freq) { sql += ` AND frequency=?`; params.push(freq); }
    else { sql += ` AND (frequency IS NULL OR frequency='')`; }
    if (scope === 'future') sql += ` AND status='pending' AND due_date >= CURDATE()`;
    const [r] = await db.query(sql, params);
    deleted += r.affectedRows || 0;
    details.push({ description: desc, frequency: freq, deleted: r.affectedRows || 0 });
  }
  res.json({ success: true, deleted, scope, details });
}));

// Change a series' end date: pending rows past it are removed, and the rows
// that remain carry the new end_date.
router.post('/tasks/checklist-set-end-date', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const userId = parseInt(req.body.userId, 10);
  const desc = String(req.body.description || '');
  const freq = String(req.body.frequency || '');
  const endDate = normDate(req.body.endDate != null ? req.body.endDate : req.body.end_date);
  if (!userId || !desc) return res.status(400).json({ error: 'userId and description required' });
  if (!endDate) return res.status(400).json({ error: 'Valid end date (YYYY-MM-DD) required' });

  const freqClause = freq ? ` AND frequency=?` : ` AND (frequency IS NULL OR frequency='')`;
  const freqParam = freq ? [freq] : [];

  const [del] = await db.query(
    `DELETE FROM checklist_tasks WHERE assigned_to=? AND description=?${freqClause} AND status='pending' AND due_date > ?`,
    [userId, desc, ...freqParam, endDate]);
  const [upd] = await db.query(
    `UPDATE checklist_tasks SET end_date=? WHERE assigned_to=? AND description=?${freqClause}`,
    [endDate, userId, desc, ...freqParam]);

  res.json({ success: true, removed: del.affectedRows || 0, updated: upd.affectedRows || 0, endDate });
}));

module.exports = { router, getTable };
