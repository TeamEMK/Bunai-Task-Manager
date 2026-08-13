// ══════════════════════════════════════════════════════
// TASK COMMENTS
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();

router.get('/comments/:type/:taskId', requireAuth, asyncRoute(async (req, res) => {
  res.json(await db.rows(
    `SELECT tc.id,tc.comment,tc.created_at,u.name AS userName
       FROM task_comments tc JOIN users u ON tc.user_id=u.id
      WHERE tc.task_id=? AND tc.task_type=? ORDER BY tc.created_at ASC`,
    [req.params.taskId, req.params.type]));
}));

router.post('/comments', requireAuth, asyncRoute(async (req, res) => {
  const { taskId, taskType, comment } = req.body;
  if (!comment || !taskId || !taskType) return res.status(400).json({ error: 'All fields required' });
  await db.query('INSERT INTO task_comments (task_id,task_type,user_id,comment) VALUES (?,?,?,?)',
    [taskId, taskType, req.session.userId, comment]);
  res.json({ success: true });
}));

router.delete('/comments/:id', requireAuth, asyncRoute(async (req, res) => {
  const row = await db.one('SELECT id, user_id FROM task_comments WHERE id=?', [req.params.id]);
  if (!row) throw httpError(404, 'Not found');
  if (row.user_id !== req.session.userId && req.session.role !== 'admin') throw httpError(403, 'Not allowed');
  await db.query('DELETE FROM task_comments WHERE id=?', [req.params.id]);
  res.json({ success: true });
}));

module.exports = router;
