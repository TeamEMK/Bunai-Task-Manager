// ══════════════════════════════════════════════════════
// DASHBOARD
//
// Two changes worth knowing about:
//  1. The PC date range used to be pasted straight into the SQL string
//     (`BETWEEN '${dateFrom}' AND '${dateTo}'`). It is a bound parameter now —
//     an injection hole closed, and MySQL can reuse the plan.
//  2. It ran up to twelve queries strictly one after another. The six count
//     queries collapsed into two conditional-aggregate queries, and every
//     remaining query is issued together, so the page waits for the slowest
//     rather than for the sum of all of them.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errors');
const { placeholders, N } = require('../utils/collections');

const router = express.Router();

// Columns the task cards render. Kept as constants because the delegation and
// checklist shapes must stay union-compatible for the client.
const DELEGATION_COLUMNS = `t.id,'delegation' AS type,t.description,t.status,t.assigned_to,
  COALESCE(t.priority,'low') AS priority,COALESCE(t.approval,'no') AS approval,
  COALESCE(t.waiting_approval,0) AS waiting_approval,t.approver_id,u3.name AS approverName,
  t.remarks,t.revise_reason,t.url,t.client_id,c.name AS client_name,
  DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,u1.name AS assignedToName,u2.name AS assignedByName`;

const DELEGATION_JOINS = `FROM delegation_tasks t
  JOIN users u1 ON t.assigned_to=u1.id
  JOIN users u2 ON t.assigned_by=u2.id
  LEFT JOIN users u3 ON t.approver_id=u3.id
  LEFT JOIN clients c ON t.client_id=c.id`;

const CHECKLIST_COLUMNS = `t.id,'checklist' AS type,t.description,t.status,t.assigned_to,
  COALESCE(t.priority,'low') AS priority,'no' AS approval,0 AS waiting_approval,
  t.remarks,t.revise_reason,t.client_id,c.name AS client_name,
  DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,u1.name AS assignedToName,u2.name AS assignedByName`;

const CHECKLIST_JOINS = `FROM checklist_tasks t
  JOIN users u1 ON t.assigned_to=u1.id
  JOIN users u2 ON t.assigned_by=u2.id
  LEFT JOIN clients c ON t.client_id=c.id`;

const COMPLETED_ROW_LIMIT = 300;
const UPCOMING_ROW_LIMIT = 300;
const PENDING_ROW_LIMIT = 500;

// Which users' tasks this caller may see. Returns a WHERE fragment + params.
async function resolveScope(req) {
  const uid = req.session.userId;
  const role = req.session.role;
  const isAdmin = role === 'admin' || role === 'pc';
  const isHod = role === 'hod';
  const filterEmployee = req.query.employee;

  if (isAdmin && filterEmployee && filterEmployee !== 'all') return { filter: 'AND t.assigned_to = ?', params: [filterEmployee] };
  if (isAdmin) return { filter: '', params: [] };
  if (!isHod) return { filter: 'AND t.assigned_to = ?', params: [uid] };

  if (filterEmployee && filterEmployee !== 'all') return { filter: 'AND t.assigned_to = ?', params: [filterEmployee] };

  // Fetch the HOD's department from the DB — do not trust the query param.
  let dept = req.query.hodDept || '';
  if (!dept) {
    const me = await db.one('SELECT department FROM users WHERE id=?', [uid]);
    dept = me?.department || '';
  }
  if (!dept) return { filter: 'AND t.assigned_to = ?', params: [uid] };

  const deptUsers = await db.rows(
    'SELECT id FROM users WHERE department=? AND role NOT IN (?,?)', [dept, 'admin', 'hod']);
  if (!deptUsers.length) return { filter: 'AND t.assigned_to = ?', params: [uid] };

  const ids = deptUsers.map(u => u.id);
  if (!ids.includes(uid)) ids.push(uid);   // include the HOD themselves
  return { filter: `AND t.assigned_to IN (${placeholders(ids)})`, params: ids };
}

router.get('/dashboard', requireAuth, asyncRoute(async (req, res) => {
  const isPC = req.session.role === 'pc';
  const dateFrom = req.query.dateFrom || '';
  const dateTo = req.query.dateTo || '';
  const taskType = req.query.taskType || 'both';
  const wantDelegation = taskType === 'delegation' || taskType === 'both';
  const wantChecklist = taskType === 'checklist' || taskType === 'both';

  const { filter: userFilter, params: userParams } = await resolveScope(req);

  // PC may narrow to an explicit range; everyone else sees "today or earlier".
  const usingPCRange = !!(isPC && dateFrom && dateTo);
  const dateCond = usingPCRange ? 't.due_date BETWEEN ? AND ?' : 't.due_date <= CURDATE()';
  const dp = usingPCRange ? [dateFrom, dateTo] : [];   // params for one dateCond

  // ── Counts. One conditional-aggregate query per table.
  // `total` counts EVERY task — completed included, and with no "today or
  // earlier" cap, so next week's work is in there too. It is deliberately a
  // headline figure, not a row count: clicking Total lists only work still
  // open, so the number exceeds the table by exactly `completed`.
  const totalExpr = usingPCRange ? `SUM(CASE WHEN ${dateCond} THEN 1 ELSE 0 END)` : 'COUNT(*)';
  // Upcoming is only meaningful without an explicit range.
  const upcomingExpr = usingPCRange ? '0' : `SUM(CASE WHEN t.due_date > CURDATE() AND t.status <> 'completed' THEN 1 ELSE 0 END)`;
  // Revised carries a future due date, so it is counted across all dates unless
  // the PC pinned a range.
  const revisedCond = usingPCRange ? ` AND ${dateCond}` : '';
  // Completed is counted across all dates too — a done task is done whatever
  // its due date. Restricting it to "today or earlier" dropped tasks completed
  // with a future due date: they stayed in Total (COUNT(*)) but landed in no
  // card (Completed excluded them by date, Upcoming by status), so the tiles
  // stopped summing to Total. Counting all completed restores that.
  const completedCond = usingPCRange ? ` AND ${dateCond}` : '';

  const countsSql = (table, withRevised) => `
    SELECT ${totalExpr} AS total,
           SUM(CASE WHEN t.status='pending' AND ${dateCond} THEN 1 ELSE 0 END) AS pending,
           ${withRevised ? `SUM(CASE WHEN t.status='revised'${revisedCond} THEN 1 ELSE 0 END)` : `SUM(CASE WHEN t.status='revised' AND ${dateCond} THEN 1 ELSE 0 END)`} AS revised,
           SUM(CASE WHEN t.status='completed'${completedCond} THEN 1 ELSE 0 END) AS completed,
           ${upcomingExpr} AS upcoming
      FROM ${table} t WHERE 1=1 ${userFilter}`;

  // Parameter order follows the SQL text: total, pending, revised, completed,
  // then the scope filter.
  const delCountParams = usingPCRange ? [...dp, ...dp, ...dp, ...dp, ...userParams] : [...userParams];
  const chlCountParams = usingPCRange ? [...dp, ...dp, ...dp, ...dp, ...userParams] : [...userParams];

  const noRows = Promise.resolve([]);
  const noCounts = Promise.resolve(null);

  // Everything below is issued at once; the pool serialises what it must.
  const [
    delCounts, chlCounts,
    delegationPending, checklistPending,
    delegationCompleted, checklistCompleted,
    delegationUpcoming, checklistUpcoming,
  ] = await Promise.all([
    wantDelegation ? db.one(countsSql('delegation_tasks', true), delCountParams) : noCounts,
    wantChecklist ? db.one(countsSql('checklist_tasks', false), chlCountParams) : noCounts,

    // Pending list: overdue + due today (or the PC range). A revised task keeps
    // its place here at any date unless a range was pinned.
    wantDelegation ? db.rows(
      `SELECT ${DELEGATION_COLUMNS} ${DELEGATION_JOINS}
        WHERE ((t.status='pending' AND ${dateCond}) OR (t.status='revised'${revisedCond})) ${userFilter}
        ORDER BY t.due_date ASC LIMIT ${PENDING_ROW_LIMIT}`,
      usingPCRange ? [...dp, ...dp, ...userParams] : [...dp, ...userParams]) : noRows,
    wantChecklist ? db.rows(
      `SELECT ${CHECKLIST_COLUMNS} ${CHECKLIST_JOINS}
        WHERE t.status='pending' AND ${dateCond} ${userFilter}
        ORDER BY t.due_date ASC LIMIT ${PENDING_ROW_LIMIT}`,
      [...dp, ...userParams]) : noRows,

    // Rows behind the "Completed" card. Same date window as the count so the
    // number and the list agree. Newest first and capped — completed history
    // grows without bound and this card is a quick look, not the archive.
    wantDelegation ? db.rows(
      `SELECT ${DELEGATION_COLUMNS} ${DELEGATION_JOINS}
        WHERE t.status='completed'${completedCond} ${userFilter}
        ORDER BY t.due_date DESC LIMIT ${COMPLETED_ROW_LIMIT}`,
      [...dp, ...userParams]) : noRows,
    wantChecklist ? db.rows(
      `SELECT ${CHECKLIST_COLUMNS} ${CHECKLIST_JOINS}
        WHERE t.status='completed'${completedCond} ${userFilter}
        ORDER BY t.due_date DESC LIMIT ${COMPLETED_ROW_LIMIT}`,
      [...dp, ...userParams]) : noRows,

    // Future-dated OPEN rows. Every other list stops at today, so without these
    // the Total card would count work the Total view could not display.
    // Upcoming is a date bucket, not a status, so a task revised to a future
    // date belongs here too — it also arrives via the pending query, and the
    // client de-duplicates.
    (!usingPCRange && wantDelegation) ? db.rows(
      `SELECT ${DELEGATION_COLUMNS} ${DELEGATION_JOINS}
        WHERE t.due_date > CURDATE() AND t.status <> 'completed' ${userFilter}
        ORDER BY t.due_date ASC LIMIT ${UPCOMING_ROW_LIMIT}`, [...userParams]) : noRows,
    (!usingPCRange && wantChecklist) ? db.rows(
      `SELECT ${CHECKLIST_COLUMNS} ${CHECKLIST_JOINS}
        WHERE t.due_date > CURDATE() AND t.status <> 'completed' ${userFilter}
        ORDER BY t.due_date ASC LIMIT ${UPCOMING_ROW_LIMIT}`, [...userParams]) : noRows,
  ]);

  const sum = (key) => N(delCounts?.[key]) + N(chlCounts?.[key]);

  // Counts first, then the row lists they map to. `upcoming` is the count, so
  // the rows go out as `upcomingTasks` — two keys of the same name would have
  // silently dropped one of them.
  res.json({
    pending: sum('pending'),
    revised: sum('revised'),
    completed: sum('completed'),
    total: sum('total'),
    upcoming: sum('upcoming'),
    todayPending: [...delegationPending, ...checklistPending],
    todayCompleted: [...delegationCompleted, ...checklistCompleted],
    upcomingTasks: [...delegationUpcoming, ...checklistUpcoming],
  });
}));

module.exports = router;
