// ══════════════════════════════════════════════════════
// LEAVE TRACKER
// Routing: user → HOD of the same department; hod/pc → admin; admin → another
// admin (or self). The hierarchy uses `user_role` (where a person sits in the
// org), NOT `role` (what they may do in the app) — an IT employee can hold
// role='admin' for access while their leave still goes to their HOD.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const { placeholders } = require('../utils/collections');

const router = express.Router();

// COALESCE(user_role, role) appears in every hierarchy query; naming it once
// keeps the intent visible.
const ORG_ROLE = 'COALESCE(user_role, role)';

// The people explicitly marked as leave approvers, if anybody is. When this
// list is not empty it decides everything: the department-HOD chain below is
// skipped, because "send every leave to these two" is the whole point of
// setting it. Empty list → the original chain, so nothing changes until
// somebody is actually flagged.
const leaveApproverIds = () =>
  db.rows('SELECT id FROM users WHERE is_leave_approver=1 ORDER BY id').then(r => r.map(x => x.id));

async function resolveLeaveApprover(userId) {
  const designated = await leaveApproverIds().catch(() => []);
  if (designated.length) {
    // An approver applying for their own leave goes to one of the others; only
    // when they are the sole approver does it come back to them.
    return designated.find(id => id !== userId) ?? designated[0];
  }

  const me = await db.one(
    `SELECT id, ${ORG_ROLE} AS user_role, department FROM users WHERE id=?`, [userId]);
  if (!me) return null;

  if (me.user_role === 'admin') {
    // Admin's leave → another admin if there is one, else themselves.
    const other = await db.one(
      `SELECT id FROM users WHERE ${ORG_ROLE}='admin' AND id<>? ORDER BY id ASC LIMIT 1`, [me.id]);
    return other ? other.id : me.id;
  }
  // Nobody approves their own leave. Every lookup below excludes the applicant,
  // because each of them can otherwise land on them: an HOD is the HOD of their
  // own department, and the last admin standing is the admin applying. Sona
  // Nazwani ended up listed as her own approver this way.
  const notMe = ' AND id<>?';

  if (me.user_role === 'hod' || me.user_role === 'pc') {
    const adm = await db.one(
      `SELECT id FROM users WHERE ${ORG_ROLE}='admin'${notMe} ORDER BY id ASC LIMIT 1`, [me.id]);
    if (adm) return adm.id;
  }
  if (me.department) {
    const hod = await db.one(
      `SELECT id FROM users WHERE ${ORG_ROLE}='hod' AND department=?${notMe} ORDER BY id ASC LIMIT 1`,
      [me.department, me.id]);
    if (hod) return hod.id;
  }
  const adm = await db.one(
    `SELECT id FROM users WHERE ${ORG_ROLE}='admin'${notMe} ORDER BY id ASC LIMIT 1`, [me.id]);
  if (adm) return adm.id;

  // Only now, with genuinely nobody else in the system, does it come back to
  // them — and the approvals list makes that one case visible so it is not
  // stranded.
  return me.id;
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
    const designated = await leaveApproverIds().catch(() => []);
    if (designated.includes(uid)) {
      // The designated approvers cover for each other, the same way the HODs of
      // one department do below: either can clear the queue, whoever gets there
      // first. Still not your own — unless you are the only approver, in which
      // case nobody else could ever decide it.
      where += ` AND lr.approver_id IN (${placeholders(designated)})`
             + ' AND (lr.user_id<>? OR lr.approver_id=lr.user_id)';
      params.push(...designated, uid);
    } else if (me?.user_role === 'hod' && me?.department) {
      // An HOD covers for the other HODs of their department.
      const hods = await db.rows(
        `SELECT id FROM users WHERE ${ORG_ROLE}='hod' AND department=?`, [me.department]);
      // Guard the empty case: "IN ()" is a syntax error, not an empty result.
      const hodIds = hods.map(h => h.id);
      if (!hodIds.length) hodIds.push(uid);
      where += ` AND lr.approver_id IN (${placeholders(hodIds)}) AND lr.user_id<>?`;
      params.push(...hodIds, uid);
    } else {
      // You do not approve your own leave — except in the one case where the
      // system had nobody else to give it to. A sole admin was assigned their
      // own request and then filtered out of seeing it, so it sat pending with
      // no one on earth able to decide it. They are the top of the chain; let
      // them act on that one rather than strand it.
      where += ' AND lr.approver_id=? AND (lr.user_id<>? OR lr.approver_id=lr.user_id)';
      params.push(uid, uid);
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

  // A request is assigned to one person, but where approvers share a queue any
  // of them can decide it. Printing only the assigned name made the list say
  // "Approver: Ajay Gupta" while the form above it said "Ajay Gupta or Amita
  // Gupta" — both true, and together confusing. Rows sitting with one of the
  // shared approvers now carry the whole set; anything assigned outside it
  // keeps its own single name.
  try {
    const pool = await db.rows(
      'SELECT id, name FROM users WHERE is_leave_approver=1 ORDER BY id');
    if (pool.length > 1) {
      const ids = new Set(pool.map(p => p.id));
      const label = pool.map(p => p.name).join(' or ');
      for (const r of rows) if (ids.has(r.approver_id)) r.approver_names = label;
    }
  } catch (_) { /* the column may not exist yet on an old database */ }

  res.json(rows);
}));

// Names of everyone who could approve the caller's leave — shown on the form.
router.get('/leaves/my-approvers', requireAuth, asyncRoute(async (req, res) => {
  const me = await db.one(
    `SELECT department, ${ORG_ROLE} AS user_role FROM users WHERE id=?`, [req.session.userId]);
  if (!me) return res.json({ names: '' });

  // Once approvers are named, they are the answer for everybody — including
  // themselves, who are sent to whichever of the others is not them.
  const designated = await db.rows(
    'SELECT id, name FROM users WHERE is_leave_approver=1 ORDER BY id').catch(() => []);
  if (designated.length) {
    const others = designated.filter(a => a.id !== req.session.userId);
    const shown = others.length ? others : designated;
    return res.json({
      names: shown.map(a => a.name).join(' or '),
      selfApproves: !others.length,
    });
  }

  if (me.user_role === 'admin') {
    // Naming the actual person beats the phrase "Another Admin", which was
    // printed whether or not another admin existed — so a sole admin was told
    // their request was going to somebody else when it was going to them.
    const others = await db.rows(
      `SELECT name FROM users WHERE ${ORG_ROLE}='admin' AND id<>? ORDER BY name`, [req.session.userId]);
    return res.json({
      names: others.length ? others.map(a => a.name).join(', ') : 'you — there is no other admin',
      selfApproves: others.length === 0,
    });
  }
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

  const designated = await leaveApproverIds().catch(() => []);
  if (designated.includes(uid)) {
    const r = await db.one(
      `SELECT COUNT(*) AS cnt FROM leave_requests
        WHERE approver_id IN (${placeholders(designated)}) AND status='pending'
          AND (user_id<>? OR approver_id=user_id)`, [...designated, uid]);
    return res.json({ count: r.cnt || 0 });
  }

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
  // Same rule as the list above, or the badge and the page disagree.
  const r = await db.one(
    "SELECT COUNT(*) AS cnt FROM leave_requests WHERE approver_id=? AND status='pending' AND (user_id<>? OR approver_id=user_id)",
    [uid, uid]);
  res.json({ count: r.cnt || 0 });
}));

const LEAVE_TYPES = ['full_day', 'half_day', 'work_from_home', 'extra_working', 'early_leaving'];

// Two types carry a figure per date rather than just the date: extra_working
// says how many hours were put in, early_leaving says what time the person is
// leaving at. Both ride along in dates_json.
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
    if (leave_type === 'early_leaving') {
      // The time they will leave at, not how early — that is what the approver
      // needs to know, and it does not depend on knowing anyone's shift.
      const t = String((d && d.time) || '').trim();
      if (!HH_MM.test(t)) return res.status(400).json({ error: `Leaving time required (HH:MM) for ${date}` });
      item.time = t;
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

// Hand every still-pending request to whoever approves leave now.
//
// Changing the approvers only steers NEW requests; anything already waiting
// keeps the person it was created with, which is right in general — you do not
// want a decision quietly moving under someone mid-review — but wrong the day
// you deliberately hand the job over. This moves them, on purpose, when an
// admin asks.
//
// Only pending ones, and only those whose current approver is no longer one of
// the approvers: a request already sitting with the right person is left alone.
// How many are still with an old approver. The screen only offers to move them
// when there is something to move, so the button is never a mystery.
router.get('/leaves/stale-approvals', requireAuth, asyncRoute(async (req, res) => {
  const designated = await leaveApproverIds().catch(() => []);
  if (!designated.length) return res.json({ count: 0, approvers: [] });
  const r = await db.one(
    `SELECT COUNT(*) AS cnt FROM leave_requests
      WHERE status='pending' AND approver_id NOT IN (${placeholders(designated)})`, designated);
  const names = await db.rows(
    `SELECT name FROM users WHERE id IN (${placeholders(designated)}) ORDER BY id`, designated);
  res.json({ count: Number(r?.cnt) || 0, approvers: names.map(n => n.name) });
}));

router.post('/leaves/reassign-pending', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const designated = await leaveApproverIds().catch(() => []);
  if (!designated.length) {
    return res.status(400).json({ error: 'Nobody is marked as a leave approver yet. Tick someone on the Users screen first.' });
  }

  const stale = await db.rows(
    `SELECT lr.id, lr.user_id FROM leave_requests lr
      WHERE lr.status='pending' AND lr.approver_id NOT IN (${placeholders(designated)})`,
    designated);
  if (!stale.length) return res.json({ moved: 0, approvers: designated.length });

  // Each one is routed the same way a fresh request would be, so an approver's
  // own pending leave still lands on somebody else rather than on themselves.
  let moved = 0;
  for (const r of stale) {
    const to = designated.find(id => id !== r.user_id) ?? designated[0];
    await db.query('UPDATE leave_requests SET approver_id=? WHERE id=? AND status=\'pending\'', [to, r.id]);
    moved++;
  }
  res.json({ moved, approvers: designated.length });
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
