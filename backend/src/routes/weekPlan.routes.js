// ══════════════════════════════════════════════════════
// WEEK PLAN — the target an HOD sets for an employee for one week.
// Keyed by (employee_id, start_date): saving the same week twice updates it
// rather than inserting a second row. That upsert only works because
// migrations.js adds the UNIQUE key uq_emp_week — without it MySQL has nothing
// to detect the duplicate on.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdminOrHod } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errors');

const router = express.Router();

const UPSERT_SQL = `
  INSERT INTO week_plans (employee_id, hod_id, start_date, target_count, improvement_pct, created_at)
  VALUES (?, ?, ?, ?, ?, NOW())
  ON DUPLICATE KEY UPDATE target_count = VALUES(target_count), hod_id = VALUES(hod_id),
                          improvement_pct = VALUES(improvement_pct), created_at = NOW()`;

router.post('/week-plan', requireAuth, requireAdminOrHod, asyncRoute(async (req, res) => {
  const { employeeId, startDate, targetCount, hodId, improvementPct } = req.body;
  if (!employeeId || !startDate) return res.json({ error: 'employeeId and startDate required' });

  const impPct = (improvementPct !== undefined && improvementPct !== null && improvementPct !== '')
    ? parseInt(improvementPct, 10) : null;
  const params = [employeeId, hodId || req.session.userId, startDate, targetCount, impPct];

  try {
    await db.execute(UPSERT_SQL, params);
  } catch (e) {
    // An old database may still be missing the table or the column. Repair it
    // once and retry, rather than failing the save.
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') {
      const { runMigrations } = require('../db/migrations');
      await runMigrations({ verbose: false });
      await db.execute(UPSERT_SQL, params);
    } else {
      console.error('  ❌ /api/week-plan:', e.message);
      return res.json({ error: 'Failed to save plan' });
    }
  }
  res.json({ success: true });
}));

router.get('/week-plan', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    res.json(await db.rows(
      `SELECT wp.*, u.name AS employee_name FROM week_plans wp
         JOIN users u ON u.id = wp.employee_id
        ORDER BY wp.start_date DESC LIMIT 50`));
  } catch (e) {
    res.json([]);   // the screen degrades to "no plans" rather than an error
  }
});

module.exports = router;
