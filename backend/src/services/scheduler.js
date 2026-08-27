// ══════════════════════════════════════════════════════
// SCHEDULERS
// Plain setInterval, checked once a minute against the IST clock — no extra
// dependency. On a serverless runtime a function does not live between
// requests, so nothing is scheduled there: vercel.json's crons call
// /api/cron/* instead.
// ══════════════════════════════════════════════════════
const config = require('../config');
const { istParts } = require('../utils/dates');
const { runChecklistDailyReminder } = require('./checklistReminder');
const { runTaskReminders } = require('./taskReminder');

// Runs `job` the first minute of each day that matches hour:minute in IST.
// `lastRun` guards against the interval firing twice inside the same minute.
function dailyAt(hour, minute, job, label) {
  let lastRun = '';
  setInterval(async () => {
    try {
      const { date, hour: h, minute: m } = istParts();
      if (h !== hour || m !== minute) return;
      if (lastRun === date) return;
      lastRun = date;
      await job(date);
    } catch (e) { console.error(`${label} scheduler:`, e.message); }
  }, 60 * 1000);
}

// Runs `job` once at the top of every hour IST. Unlike dailyAt this needs no
// date guard — the hour itself changing is what stops a second run.
function everyHour(job, label) {
  let lastRun = '';
  setInterval(async () => {
    try {
      const { date, hour: h, minute: m } = istParts();
      if (m !== 0) return;
      const slot = `${date} ${h}`;
      if (lastRun === slot) return;
      lastRun = slot;
      await job();
    } catch (e) { console.error(`${label} scheduler:`, e.message); }
  }, 60 * 1000);
}

const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

async function runVinculumSync() {
  // Required lazily: the sync module opens its own MySQL pool, and a deployment
  // with no Vinculum configured should not pay for that or fail to boot.
  const vinculum = require('../../vinculum');
  if (!vinculum.isConfigured()) {
    return { skipped: 'Vinculum not configured — set VIN_BASE_URL, VIN_API_KEY, VIN_API_OWNER' };
  }
  const sync = require('../../vinculum-sync');
  await sync.ensureTables();

  const result = await sync.syncInventory({ log: m => console.log('  [vin]' + m) });
  console.log(`✅ Vinculum stock sync — ${result.rows} rows across ${result.skus} SKUs`);

  // Tasks are opt-in. Without an assignee there is nobody to give the work to,
  // and silently inventing one would be worse than doing nothing.
  const assignTo = config.vinculum.lowStockAssignTo;
  if (assignTo) {
    const alerts = await sync.raiseLowStockTasks({ assignTo, log: m => console.log('  [vin]' + m) });
    return { ...result, ...alerts };
  }
  return result;
}

function startSchedulers() {
  if (config.isServerless) {
    console.log('⏰ Serverless runtime — daily jobs run via Vercel Cron, not setInterval');
    return;
  }

  if (config.reminder.enabled) {
    dailyAt(config.reminder.hour, config.reminder.minute,
      (date) => runChecklistDailyReminder({ dateStr: date }), 'reminder');
    console.log(`⏰ Checklist WhatsApp reminder scheduled daily at ${hhmm(config.reminder.hour, config.reminder.minute)} IST`);
  } else {
    console.log('⏸ Checklist WhatsApp reminder disabled (CHECKLIST_REMINDER_ENABLED=0)');
  }

  // Hourly, not 8-hourly: the service decides what is actually due, so checking
  // often just means a task is chased close to its 8-hour mark instead of up to
  // 8 hours late. A pass with nothing due is one indexed query.
  if (config.taskReminder.enabled) {
    everyHour(() => runTaskReminders(), 'task-reminder');
    console.log('⏰ Overdue task reminders checked hourly (12h after due, then every 8h)');
  } else {
    console.log('⏸ Overdue task reminders disabled (TASK_REMINDER_ENABLED=0)');
  }

  if (config.vinculum.syncEnabled) {
    dailyAt(config.vinculum.syncHour, config.vinculum.syncMinute, () => runVinculumSync(), 'vinculum');
    console.log(`⏰ Vinculum stock sync scheduled daily at ${hhmm(config.vinculum.syncHour, config.vinculum.syncMinute)} IST`);
  } else {
    console.log('⏸ Vinculum stock sync disabled (VIN_SYNC_ENABLED=0)');
  }
}

module.exports = { startSchedulers, runVinculumSync };
