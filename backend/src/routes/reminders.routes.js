// ══════════════════════════════════════════════════════
// DAILY REMINDER — manual trigger, preview, and the cron entry point.
// Vercel Cron calls /api/cron/checklist-reminder because setInterval cannot
// survive between serverless invocations. Auth there is a shared secret, not a
// login: cron has no session.
// ══════════════════════════════════════════════════════
const express = require('express');
const { requireAuth, requireAdmin, requireCronSecret } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errors');
const { normDate, istToday } = require('../utils/dates');
const { runChecklistDailyReminder, previewChecklistDailyReminder } = require('../services/checklistReminder');

const router = express.Router();

// Manual trigger (admin) — force=1 ignores the once-a-day lock and sends again.
router.post('/whatsapp/checklist-daily-run', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const dateStr = normDate(req.body && req.body.date) || istToday();
  const force = !!(req.body && (req.body.force === true || req.body.force === 1 || req.body.force === '1'));
  res.json(await runChecklistDailyReminder({ dateStr, force }));
}));

// Who would receive a message today — a preview, nothing is sent.
router.get('/whatsapp/checklist-daily-preview', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  res.json(await previewChecklistDailyReminder(normDate(req.query.date) || istToday()));
}));

router.get('/cron/checklist-reminder', requireCronSecret, asyncRoute(async (req, res) => {
  // The DB lock (UNIQUE log_date) still guards against a double fire.
  res.json({ ok: true, ...(await runChecklistDailyReminder({ dateStr: istToday() })) });
}));

module.exports = router;
