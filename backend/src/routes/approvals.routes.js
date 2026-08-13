// ══════════════════════════════════════════════════════
// APPROVALS — the queue a delegation task enters when it is marked
// done/revised and the task was created with approval='yes'.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const { getTable } = require('./tasks.routes');

const router = express.Router();

const isAdminOrPC = (role) => role === 'admin' || role === 'pc';

router.get('/approvals', requireAuth, asyncRoute(async (req, res) => {
  // Admin/PC see every pending request; everyone else sees only their own.
  const all = isAdminOrPC(req.session.role);
  const where = all ? `WHERE ta.status='pending'` : `WHERE ta.requested_to=? AND ta.status='pending'`;
  const params = all ? [] : [req.session.userId];
  const rows = await db.rows(
    `SELECT ta.*,DATE_FORMAT(ta.new_date,'%Y-%m-%d') AS new_date_fmt,
            u1.name AS requestedByName,u2.name AS requestedToName,
            dt.description,dt.approval AS taskApproval,
            DATE_FORMAT(dt.due_date,'%Y-%m-%d') AS currentDueDate
       FROM task_approvals ta
       JOIN users u1 ON ta.requested_by=u1.id
       JOIN users u2 ON ta.requested_to=u2.id
       LEFT JOIN delegation_tasks dt ON ta.task_id=dt.id AND ta.task_type='delegation'
       ${where} ORDER BY ta.created_at DESC`, params);
  res.json(rows);
}));

router.get('/approvals/count', requireAuth, asyncRoute(async (req, res) => {
  const all = isAdminOrPC(req.session.role);
  const row = all
    ? await db.one(`SELECT COUNT(*) AS count FROM task_approvals WHERE status='pending'`)
    : await db.one(`SELECT COUNT(*) AS count FROM task_approvals WHERE requested_to=? AND status='pending'`, [req.session.userId]);
  res.json({ count: row.count });
}));

router.put('/approvals/:id', requireAuth, asyncRoute(async (req, res) => {
  const { action, note } = req.body;
  const role = req.session.role;
  const uid = req.session.userId;

  const appr = await db.one('SELECT * FROM task_approvals WHERE id=?', [req.params.id]);
  if (!appr) throw httpError(404, 'Approval not found');
  if (appr.status !== 'pending') throw httpError(400, 'This request has already been decided.');

  const table = getTable(appr.task_type);
  const isChecklist = appr.task_type === 'checklist';

  const taskRow = await db.one(`SELECT assigned_to FROM ${table} WHERE id=?`, [appr.task_id]);
  const doerId = taskRow ? taskRow.assigned_to : null;

  const isAdmin = role === 'admin';
  const isPC = role === 'pc';
  const isDoer = doerId !== null && doerId === uid;

  // Admin has full authority — can approve/reject ANY pending request.
  if (!isAdmin) {
    // Regular users (and PC) can never approve a task they are the doer of.
    if (isDoer) throw httpError(403, 'You cannot approve your own task. Only the chosen approver (or an admin) can approve it.');
    const isChosenApprover = appr.requested_to === uid;
    // PC may act as a fallback approver for other people's tasks.
    if (!isChosenApprover && !isPC) throw httpError(403, 'Only the chosen approver can approve or reject this task.');
  }

  // The decision note overwrites the request note, so capture the requester's
  // original reason first — otherwise approving a revision erases the very
  // explanation the approver just read.
  const requestReason = appr.note || null;
  await db.query('UPDATE task_approvals SET status=?,note=? WHERE id=?', [action, note || '', req.params.id]);

  if (action === 'approved') {
    if (appr.action_type === 'revised' && appr.new_date) {
      // Apply the revised date now that it is approved — status, date and the
      // reason in a single UPDATE.
      const sets = isChecklist
        ? `status='revised',due_date=?,revise_reason=?`
        : `status='revised',waiting_approval=0,due_date=?,revise_reason=?`;
      await db.query(`UPDATE ${table} SET ${sets} WHERE id=?`, [appr.new_date, requestReason, appr.task_id]);
    } else if (isChecklist) {
      await db.query(`UPDATE ${table} SET status=? WHERE id=?`, [appr.action_type, appr.task_id]);
    } else {
      await db.query(`UPDATE ${table} SET status=?,waiting_approval=0 WHERE id=?`, [appr.action_type, appr.task_id]);
    }
  } else if (!isChecklist) {
    // Rejected — keep the original status & due date, just clear the flag.
    await db.query(`UPDATE ${table} SET waiting_approval=0 WHERE id=?`, [appr.task_id]);
  }
  res.json({ success: true });
}));

module.exports = router;
