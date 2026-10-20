// ══════════════════════════════════════════════════════
// TASK CHAINS (/api/task-chains) - one task, done in steps by different
// people, in a fixed order. See services/taskChain.js for how the steps open.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const chain = require('../services/taskChain');

const router = express.Router();
const MAX_STEPS = 20;
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// Anyone may make one. Every step is its own delegation task for its doer;
// only the first is open.
router.post('/task-chains', requireAuth, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const title = clip(b.title, 500);
  if (!title) throw httpError(400, 'Write what the main task is.');
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'low';
  const clientId = parseInt(b.client_id, 10) > 0 ? parseInt(b.client_id, 10) : null;
  const remarks = clip(b.remarks, 2000);
  const raw = Array.isArray(b.steps) ? b.steps : [];
  const steps = raw.map((s, i) => ({
    desc: clip(s && s.desc, 1000),
    doer: parseInt(s && s.assignedTo, 10),
    days: Math.min(365, Math.max(0, parseInt(s && s.days, 10) || 0)),
    n: i + 1,
  }));
  if (steps.length < 2) throw httpError(400, 'A step-by-step task needs at least two steps.');
  if (steps.length > MAX_STEPS) throw httpError(400, `At most ${MAX_STEPS} steps.`);
  const bad = steps.find(s => !s.desc || !(s.doer > 0));
  if (bad) throw httpError(400, `Step ${bad.n} needs both what to do and who does it.`);
  const ids = [...new Set(steps.map(s => s.doer))];
  const known = await db.rows(`SELECT id FROM users WHERE id IN (?)`, [ids]);
  if (known.length !== ids.length) throw httpError(400, 'One of the doers is not a user any more.');

  const firstDue = await chain.dueAfter(steps[0].days);
  const [ins] = await db.query(
    `INSERT INTO task_chains (title, created_by, client_id, priority, status, steps, created_at)
     VALUES (?,?,?,?, 'running', ?, UTC_TIMESTAMP())`, [title, req.session.userId, clientId, priority, steps.length]);
  const chainId = ins.insertId;
  let firstId = null;
  for (const s of steps) {
    const open = s.n === 1;
    const [t] = await db.query(
      `INSERT INTO delegation_tasks
         (description, assigned_to, assigned_by, due_date, status, priority, approval, waiting_approval,
          remarks, client_id, chain_id, chain_step, chain_days, chain_locked)
       VALUES (?,?,?,?, 'pending', ?, 'no', 0, ?,?,?,?,?,?)`,
      [s.desc, s.doer, req.session.userId, open ? firstDue : null, priority, remarks, clientId,
       chainId, s.n, s.days, open ? 0 : 1]);
    if (open) firstId = t.insertId;
  }
  chain.notifyStepOpen(firstId, 'This is step 1 - the next step opens when you mark it Done.');
  res.json({ id: chainId, steps: steps.length, firstDue });
}));

// One chain with every step, for anyone taking part in it (and the admins).
router.get('/task-chains/:id', requireAuth, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ch = await db.one(
    `SELECT ch.id, ch.title, ch.status, ch.priority, ch.created_by, u.name created_by_name, c.name client_name,
            DATE_FORMAT(ch.created_at + INTERVAL 330 MINUTE, '%e %b %Y') created,
            DATE_FORMAT(ch.done_at + INTERVAL 330 MINUTE, '%e %b %Y') done
       FROM task_chains ch JOIN users u ON u.id = ch.created_by
       LEFT JOIN clients c ON c.id = ch.client_id WHERE ch.id = ?`, [id]);
  if (!ch) throw httpError(404, 'That task no longer exists.');
  const steps = await db.rows(
    `SELECT t.id, t.chain_step step, t.description, t.status, t.chain_locked locked, t.chain_days days,
            t.waiting_approval, t.assigned_to, u.name doer, DATE_FORMAT(t.due_date, '%Y-%m-%d') due_date
       FROM delegation_tasks t JOIN users u ON u.id = t.assigned_to
      WHERE t.chain_id = ? ORDER BY t.chain_step`, [id]);
  const uid = req.session.userId;
  const allowed = ['admin', 'pc', 'hod'].includes(req.session.role) || ch.created_by === uid
    || steps.some(s => s.assigned_to === uid);
  if (!allowed) throw httpError(403, 'You are not part of this task.');
  res.json({
    ...ch,
    canEdit: ch.created_by === uid || req.session.role === 'admin',
    done: steps.filter(s => s.status === 'completed').length,
    steps: steps.map(s => ({ ...s, locked: !!Number(s.locked), waiting_approval: !!Number(s.waiting_approval) })),
  });
}));

// Remove a chain and its steps - whoever made it, or an admin.
router.delete('/task-chains/:id', requireAuth, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ch = await db.one('SELECT created_by FROM task_chains WHERE id = ?', [id]);
  if (!ch) throw httpError(404, 'That task no longer exists.');
  if (ch.created_by !== req.session.userId && req.session.role !== 'admin') throw httpError(403, 'Only whoever made it can delete it.');
  await db.query('DELETE FROM delegation_tasks WHERE chain_id = ?', [id]);
  await db.query('DELETE FROM task_chains WHERE id = ?', [id]);
  res.json({ success: true });
}));

module.exports = router;
