// ══════════════════════════════════════════════════════
// DAILY 10 AM CHECKLIST REMINDER
// Collects every pending checklist row for the day, groups it per user and
// sends each person ONE message. The whatsapp_reminder_log row doubles as a
// multi-instance lock: its UNIQUE (log_date, kind) key means only the first
// instance to insert gets to run.
// ══════════════════════════════════════════════════════
const { db } = require('../db/pool');
const { istToday } = require('../utils/dates');
const { groupBy } = require('../utils/collections');
const wa = require('./whatsapp');

const KIND = 'checklist_daily';

async function acquireLock(dateStr, kind) {
  const insert = () => db.query(
    `INSERT INTO whatsapp_reminder_log (log_date, kind, status) VALUES (?,?,'running')`, [dateStr, kind]);
  try {
    await insert();
    return true;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return false;   // another instance already took it
    if (e.code === 'ER_NO_SUCH_TABLE') {
      // Migration did not run — create the table and retry once.
      try {
        await db.query(`CREATE TABLE IF NOT EXISTS whatsapp_reminder_log (
          id INT AUTO_INCREMENT PRIMARY KEY, log_date DATE NOT NULL, kind VARCHAR(40) NOT NULL,
          status VARCHAR(20) DEFAULT 'running', sent INT DEFAULT 0, failed INT DEFAULT 0,
          note VARCHAR(500) DEFAULT NULL,
          started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMP NULL DEFAULT NULL,
          UNIQUE KEY uniq_day_kind (log_date, kind)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        await insert();
        return true;
      } catch (e2) {
        if (e2.code === 'ER_DUP_ENTRY') return false;
        console.error('reminder lock retry failed:', e2.message);
        return false;
      }
    }
    console.error('reminder lock error:', e.message);
    return false;
  }
}

async function releaseLock(dateStr, kind, status, sent, failed, note) {
  try {
    await db.query(
      `UPDATE whatsapp_reminder_log SET status=?, sent=?, failed=?, note=?, finished_at=NOW()
        WHERE log_date=? AND kind=?`,
      [status, sent || 0, failed || 0, (note || '').slice(0, 480), dateStr, kind]);
  } catch (e) { console.error('reminder lock release:', e.message); }
}

// The one query behind both the run and the preview.
function loadDayTasks(day) {
  return db.rows(
    `SELECT t.id, t.description, COALESCE(t.priority,'low') AS priority, t.remarks,
            u.id AS userId, u.name AS userName, u.phone,
            c.name AS client_name
       FROM checklist_tasks t
       JOIN users u ON t.assigned_to = u.id
       LEFT JOIN clients c ON t.client_id = c.id
      WHERE t.status = 'pending'
        AND t.due_date = ?
        AND COALESCE(u.exclude_from_reminder, 0) = 0
      ORDER BY u.name ASC, t.id ASC`, [day]);
}

async function runChecklistDailyReminder({ dateStr, force = false } = {}) {
  const day = dateStr || istToday();

  if (!force) {
    const got = await acquireLock(day, KIND);
    if (!got) return { skipped: true, reason: 'already run/locked for ' + day };
  }

  try {
    const rows = await loadDayTasks(day);
    // Group per user — two tasks for one person go in one message.
    const byUser = groupBy(rows.filter(r => r.phone), 'userId');
    const users = byUser.size;

    // There is a 4-5 min gap between messages, so 15-20 people can take over an
    // hour. Nothing is awaited here: everything is queued and we return at once
    // while the queue keeps sending in the background. The HTTP request neither
    // stalls nor times out.
    const sendPromises = [];
    for (const tasks of byUser.values()) {
      const msg = wa.buildChecklistDailyMessage(tasks[0].userName, day, tasks);
      sendPromises.push(wa.queueMessage(tasks[0].phone, msg, { label: 'checklist-daily' }));
    }

    if (sendPromises.length) {
      // Background: close the log once every message has actually gone out.
      Promise.allSettled(sendPromises).then(async (results) => {
        let sent = 0, failed = 0;
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value && r.value.ok) sent++; else failed++;
        }
        await releaseLock(day, KIND, 'done', sent, failed, `${users} users, ${rows.length} tasks`);
        console.log(`📲 Checklist daily reminder (${day}) COMPLETE: ${sent} sent, ${failed} failed, ${users} users`);
      });
    } else {
      await releaseLock(day, KIND, 'done', 0, 0, `no recipients (${rows.length} tasks)`);
    }

    const estimateMinutes = users > 1 ? Math.ceil((users - 1) * (wa.avgGapMs() / 60000)) : 0;
    console.log(`📲 Checklist daily reminder (${day}) QUEUED: ${users} messages, ~${estimateMinutes} min for all of them to go out`);

    return { success: true, started: true, date: day, users, tasks: rows.length, queued: users, estimateMinutes };
  } catch (err) {
    if (!force) await releaseLock(day, KIND, 'error', 0, 0, err.message);
    console.error('❌ Checklist daily reminder error:', err.message);
    return { success: false, error: err.message };
  }
}

// Who WOULD receive a message today, without sending anything.
async function previewChecklistDailyReminder(day) {
  const rows = await loadDayTasks(day);
  const byUser = groupBy(rows, 'userId');
  const preview = [...byUser.values()].map(tasks => ({
    name: tasks[0].userName,
    phone: tasks[0].phone || null,
    hasPhone: !!tasks[0].phone,
    taskCount: tasks.length,
    message: wa.buildChecklistDailyMessage(tasks[0].userName, day, tasks),
  }));
  return { date: day, users: preview.length, willSend: preview.filter(p => p.hasPhone).length, preview };
}

module.exports = { runChecklistDailyReminder, previewChecklistDailyReminder };
