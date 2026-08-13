// ══════════════════════════════════════════════════════
// LEAVE TRACKER
// Routing: user → HOD of the same department; hod/pc → admin; admin → another
// admin (or self). The hierarchy uses `user_role` (where a person sits in the
// org), NOT `role` (what they may do in the app) — an IT employee can hold
// role='admin' for access while their leave still goes to their HOD.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const { placeholders } = require('../utils/collections');

const router = express.Router();

// COALESCE(user_role, role) appears in every hierarchy query; naming it once
// keeps the intent visible.
const ORG_ROLE = 'COALESCE(user_role, role)';

async function resolveLeaveApprover(userId) {
  const me = await db.one(
    `SELECT id, ${ORG_ROLE} AS user_role, department FROM users WHERE id=?`, [userId]);
  if (!me) return null;

  if (me.user_role === 'admin') {
    // Admin's leave → another admin if there is one, else themselves.
    const other = await db.one(
      `SELECT id FROM users WHERE ${ORG_ROLE}='admin' AND id<>? ORDER BY id ASC LIMIT 1`, [me.id]);
    return other ? other.id : me.id;
  }
  if (me.user_role === 'hod' || me.user_role === 'pc') {
    const adm = await db.one(`SELECT id FROM users WHERE ${ORG_ROLE}='admin' ORDER BY id ASC LIMIT 1`);
    return adm?.id || null;
  }
  if (me.department) {
    const hod = await db.one(
      `SELECT id FROM users WHERE ${ORG_ROLE}='hod' AND department=? ORDER BY id ASC LIMIT 1`, [me.department]);
    if (hod) return hod.id;
  }
  const adm = await db.one(`SELECT id FROM users WHERE ${ORG_ROLE}='admin' ORDER BY id ASC LIMIT 1`);
  return adm?.id || null;
}

// scope=mine      → my own requests (default)
// scope=approvals → requests waiting on me (an HOD also sees their dept peers')
// scope=team      → everything in my visibility (hod = dept, admin = all)
router.get('/leaves', requireAuth, asyncRoute(async (req, res) => {
  const uid = req.session.userId;
  const role = req.session.role;
  const scope = req.query.scope || 'mine';
  const status = req.query.status || '';

  let where = '1=1';
  const params = [];

  if (scope === 'mine') {
    where += ' AND lr.user_id=?'; params.push(uid);
  } else if (scope === 'approvals') {
    const me = await db.one(`SELECT department, ${ORG_ROLE} AS user_role FROM users WHERE id=?`, [uid]);
    if (me?.user_role === 'hod' && me?.department) {
      // An HOD covers for the other HODs of their department.
      const hods = await db.rows(
        `SELECT id FROM users WHERE ${ORG_ROLE}='hod' AND department=?`, [me.department]);
      // Guard the empty case: "IN ()" is a syntax error, not an empty result.
      const hodIds = hods.map(h => h.id);
      if (!hodIds.length) hodIds.push(uid);
      where += ` AND lr.approver_id IN (${placeholders(hodIds)}) AND lr.user_id<>?`;
      params.push(...hodIds, uid);
    } else {
      where += ' AND lr.approver_id=? AND lr.user_id<>?'; params.push(uid, uid);
    }
  } else if (scope === 'team') {
    if (role === 'admin') {
      // no filter — everything
    } else if (role === 'hod') {
      const me = await db.one('SELECT department FROM users WHERE id=?', [uid]);
      if (me?.department) { where += ' AND u.department=?'; params.push(me.department); }
      else { where += ' AND lr.user_id=?'; params.push(uid); }
    } else {
      where += ' AND lr.user_id=?'; params.push(uid);
    }
  }
  if (status) { where += ' AND lr.status=?'; params.push(status); }

  const rows = await db.rows(`
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
    LIMIT 500`, params);

  // dates_json → a structured array the client can render.
  for (const r of rows) {
    if (r.dates_json) {
      try { r.dates = JSON.parse(r.dates_json); } catch { r.dates = null; }
    } else {
      // Legacy rows (pre dates_json): fall back to the from/to range.
      r.dates = [{ date: r.from_date }];
    }
    delete r.dates_json;
  }
  res.json(rows);
}));

// Names of everyone who could approve the caller's leave — shown on the form.
router.get('/leaves/my-approvers', requireAuth, asyncRoute(async (req, res) => {
  const me = await db.one(
    `SELECT department, ${ORG_ROLE} AS user_role FROM users WHERE id=?`, [req.session.userId]);
  if (!me) return res.json({ names: '' });
  if (me.user_role === 'admin') return res.json({ names: 'Another Admin' });
  if (me.user_role === 'hod' || me.user_role === 'pc') return res.json({ names: 'Admin' });
  if (me.department) {
    const hods = await db.rows(
      `SELECT name FROM users WHERE ${ORG_ROLE}='hod' AND department=? ORDER BY name`, [me.department]);
    return res.json({ names: hods.map(h => h.name).join(', ') || 'HOD' });
  }
  res.json({ names: 'HOD' });
}));

router.get('/leaves/pending-count', requireAuth, asyncRoute(async (req, res) => {
  const uid = req.session.userId;
  const me = await db.one(`SELECT department, ${ORG_ROLE} AS user_role FROM users WHERE id=?`, [uid]);

  if (me?.user_role === 'hod' && me?.department) {
    const hods = await db.rows(`SELECT id FROM users WHERE ${ORG_ROLE}='hod' AND department=?`, [me.department]);
    const hodIds = hods.map(h => h.id);
    if (!hodIds.length) hodIds.push(uid);
    const r = await db.one(
      `SELECT COUNT(*) AS cnt FROM leave_requests
        WHERE approver_id IN (${placeholders(hodIds)}) AND status='pending' AND user_id<>?`,
      [...hodIds, uid]);
    return res.json({ count: r.cnt || 0 });
  }
  const r = await db.one(
    "SELECT COUNT(*) AS cnt FROM leave_requests WHERE approver_id=? AND status='pending' AND user_id<>?",
    [uid, uid]);
  res.json({ count: r.cnt || 0 });
}));

const LEAVE_TYPES = ['full_day', 'half_day', 'work_from_home', 'extra_working'];

router.post('/leaves', requireAuth, asyncRoute(async (req, res) => {
  const { leave_type, dates, reason } = req.body;
  if (!LEAVE_TYPES.includes(leave_type)) return res.status(400).json({ error: 'Invalid leave type' });
  if (!Array.isArray(dates) || !dates.length) return res.status(400).json({ error: 'Select at least one date' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason required' });

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
  cleanDates.sort((a, b) => a.date.localeCompare(b.date));

  const uid = req.session.userId;
  const approverId = await resolveLeaveApprover(uid);
  const [r] = await db.query(
    `INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, dates_json, reason, status, approver_id)
     VALUES (?,?,?,?,?,?,'pending',?)`,
    [uid, leave_type, cleanDates[0].date, cleanDates[cleanDates.length - 1].date,
     JSON.stringify(cleanDates), reason.trim(), approverId]);

  res.json({ id: r.insertId, status: 'pending', approver_id: approverId });
}));

// Approve / reject — the assigned approver, an admin, or an HOD of the same
// department as the assigned approver.
router.put('/leaves/:id', requireAuth, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note } = req.body;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

  const lr = await db.one('SELECT id, approver_id, status FROM leave_requests WHERE id=?', [id]);
  if (!lr) throw httpError(404, 'Leave not found');
  if (lr.status !== 'pending') throw httpError(400, 'Already decided');

  const uid = req.session.userId;
  if (lr.approver_id !== uid && req.session.role !== 'admin') {
    const [me, approver] = await Promise.all([
      db.one(`SELECT department, ${ORG_ROLE} AS user_role FROM users WHERE id=?`, [uid]),
      db.one('SELECT department FROM users WHERE id=?', [lr.approver_id]),
    ]);
    const sameDept = me?.user_role === 'hod' && me?.department && approver?.department === me.department;
    if (!sameDept) throw httpError(403, 'Not authorized to act on this request');
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  await db.query(
    `UPDATE leave_requests SET status=?, approver_id=?, approver_note=?, decided_at=NOW() WHERE id=?`,
    [newStatus, uid, (note || '').trim() || null, id]);
  res.json({ success: true, status: newStatus });
}));

// Delete own pending request (admins may force-delete any)
router.delete('/leaves/:id', requireAuth, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const lr = await db.one('SELECT id, user_id, status FROM leave_requests WHERE id=?', [id]);
  if (!lr) throw httpError(404, 'Not found');
  if (req.session.role !== 'admin' && (lr.user_id !== req.session.userId || lr.status !== 'pending')) {
    throw httpError(403, 'Cannot delete this request');
  }
  await db.query('DELETE FROM leave_requests WHERE id=?', [id]);
  res.json({ success: true });
}));

module.exports = router;
