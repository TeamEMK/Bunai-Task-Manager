// ══════════════════════════════════════════════════════
// CLIENTS ("units") — admin manages, everyone reads.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();

router.get('/clients', requireAuth, asyncRoute(async (req, res) => {
  res.json(await db.rows('SELECT id, name FROM clients ORDER BY name ASC'));
}));

router.post('/clients', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Client name required' });
  try {
    await db.query('INSERT INTO clients (name) VALUES (?)', [name]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw httpError(400, 'Client already exists');
    throw err;
  }
  res.json({ success: true });
}));

router.delete('/clients/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  await db.query('DELETE FROM clients WHERE id=?', [req.params.id]);
  res.json({ success: true });
}));

// Bulk add via CSV. Was one INSERT per name with the duplicate error used as
// control flow; now it is one SELECT to find what already exists and one
// multi-row INSERT for the rest.
router.post('/clients/bulk', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { names } = req.body;
  if (!Array.isArray(names) || !names.length) return res.status(400).json({ error: 'No clients to add' });

  // Clean + dedupe within the request. The comparison is case-insensitive
  // because the UNIQUE key on name is too (utf8mb4_unicode_ci).
  const seen = new Map();     // lowercase → original spelling
  for (const raw of names) {
    const n = String(raw || '').trim();
    if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  }
  if (!seen.size) return res.status(400).json({ error: 'No valid client names' });

  const wanted = [...seen.values()];
  const existing = new Set((await db.rows(
    `SELECT name FROM clients WHERE name IN (${wanted.map(() => '?').join(',')})`, wanted))
    .map(r => String(r.name).toLowerCase()));

  const skippedNames = wanted.filter(n => existing.has(n.toLowerCase()));
  const fresh = wanted.filter(n => !existing.has(n.toLowerCase()));

  let added = 0;
  if (fresh.length) {
    // INSERT IGNORE, so a name created by someone else between the SELECT and
    // here is skipped rather than failing the whole batch.
    const [r] = await db.query('INSERT IGNORE INTO clients (name) VALUES ?', [fresh.map(n => [n])]);
    added = r.affectedRows || 0;
  }
  res.json({ success: true, added, skipped: skippedNames.length + (fresh.length - added), skippedNames });
}));

// Client stats — total hours + top 3 workers (all-time)
router.get('/clients/:id/stats', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const client = await db.one('SELECT name FROM clients WHERE id=?', [req.params.id]);
  if (!client) throw httpError(404, 'Client not found');

  const [totals, topWorkers] = await Promise.all([
    db.one('SELECT COALESCE(SUM(duration_min),0) AS total_minutes FROM daily_tasks WHERE client_name=?',
      [client.name]),
    db.rows(
      `SELECT u.name, COALESCE(u.department,'') AS department,
              SUM(dt.duration_min) AS total_minutes, COUNT(*) AS task_count
         FROM daily_tasks dt
         JOIN users u ON dt.user_id = u.id
        WHERE dt.client_name = ?
        GROUP BY dt.user_id, u.name, u.department
        ORDER BY total_minutes DESC
        LIMIT 3`, [client.name]),
  ]);

  res.json({ client_name: client.name, total_minutes: totals.total_minutes, top_workers: topWorkers });
}));

module.exports = router;
