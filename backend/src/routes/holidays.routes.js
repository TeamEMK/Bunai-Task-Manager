// ══════════════════════════════════════════════════════
// HOLIDAYS — global list; everyone reads, admin writes.
// Declaring one cascades: pending checklist rows on that date are removed and
// pending delegation tasks move to the next working day.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errors');
const { isYmd } = require('../utils/dates');
const { cascadeHolidayDate, invalidateHolidays } = require('../services/holidays');

const router = express.Router();

router.get('/holidays', requireAuth, asyncRoute(async (req, res) => {
  res.json(await db.rows(
    `SELECT id, name, DATE_FORMAT(holiday_date,'%Y-%m-%d') AS holiday_date
       FROM holidays ORDER BY holiday_date ASC`));
}));

router.post('/holidays', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { date, name } = req.body;
  if (!date || !name) return res.status(400).json({ error: 'date and name required' });
  if (!isYmd(date)) return res.status(400).json({ error: 'Invalid date format' });

  await db.query(
    'INSERT INTO holidays (holiday_date, name, created_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)',
    [date, name.trim(), req.session.userId]);
  invalidateHolidays();

  const cascade = await cascadeHolidayDate(date);
  res.json({ success: true, ...cascade });
}));

// Bulk — accepts [{ date, name }]. The rows are inserted in one statement and
// only then cascaded, instead of a round trip per holiday.
router.post('/holidays/bulk', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { holidays } = req.body;
  if (!Array.isArray(holidays) || !holidays.length) return res.status(400).json({ error: 'No holidays provided' });

  const errors = [];
  const valid = [];
  const seen = new Set();
  for (const h of holidays) {
    const date = (h.date || '').trim();
    const name = (h.name || '').trim();
    if (!isYmd(date) || !name) { errors.push({ row: h, reason: 'invalid date or empty name' }); continue; }
    if (seen.has(date)) continue;            // the last spelling of a repeated date would just overwrite
    seen.add(date);
    valid.push([date, name, req.session.userId]);
  }

  let added = 0, cascadeDeleted = 0, cascadePushed = 0;
  if (valid.length) {
    await db.query(
      'INSERT INTO holidays (holiday_date, name, created_by) VALUES ? ON DUPLICATE KEY UPDATE name=VALUES(name)',
      [valid]);
    invalidateHolidays();
    added = valid.length;

    for (const [date] of valid) {
      const c = await cascadeHolidayDate(date);
      cascadeDeleted += c.deletedChecklist || 0;
      cascadePushed += c.pushedDelegation || 0;
    }
  }

  res.json({
    success: true, added, skipped: holidays.length - added,
    cascadeDeleted, cascadePushed, errors,
  });
}));

router.delete('/holidays/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  await db.query('DELETE FROM holidays WHERE id=?', [parseInt(req.params.id, 10)]);
  invalidateHolidays();
  res.json({ success: true });
}));

module.exports = router;
