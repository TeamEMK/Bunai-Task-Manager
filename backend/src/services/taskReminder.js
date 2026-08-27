// ══════════════════════════════════════════════════════
// OVERDUE TASK REMINDERS
//
// A delegated task that is past its due date and still open gets chased: once
// at 12 hours overdue, then every 8 hours until it is closed.
//
// Two timing details decide everything here:
//
//   1. due_date is a DATE with no time, so the deadline is taken as the END of
//      the due day (23:59:59 IST). "12 hours overdue" is therefore due_date
//      + 36 hours — noon IST the day after. A task due today is never chased
//      today, which is the point: the doer gets the whole due day to work.
//
//   2. Every comparison is done against a string this process builds, never
//      against the database's NOW(). The app and MySQL can sit in different
//      timezones, and a reminder schedule that quietly shifts by 5.5 hours
//      depending on where it runs is not worth debugging later.
// ══════════════════════════════════════════════════════
const { db } = require('../db/pool');
const { toDateStr } = require('../utils/dates');
const wa = require('./whatsapp');
const mail = require('./email');

const HOUR_MS = 60 * 60 * 1000;
const FIRST_REMINDER_AFTER_H = 36;   // end of due day (24h) + 12h
const REPEAT_EVERY_H = 8;

// MySQL DATETIME literal in UTC. Paired with writes that use the same helper,
// so the stored value and every comparison agree regardless of DB timezone.
const utcStamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// The IST calendar date an absolute instant falls on.
const istDateOf = (ms) => new Date(ms + 5.5 * HOUR_MS).toISOString().slice(0, 10);

// Midnight IST at the start of a due date, as an absolute instant.
const dueStartMs = (dueDate) => Date.parse(`${toDateStr(dueDate)}T00:00:00+05:30`);

// Hours past the deadline, where the deadline is the END of the due day.
// At the first reminder this reads 12, which is the rule as stated.
const hoursOverdue = (dueDate, now) =>
  Math.max(0, Math.floor((now - (dueStartMs(dueDate) + 24 * HOUR_MS)) / HOUR_MS));

// Tasks that are overdue, still open, and due for their next nudge.
//
// status <> 'completed' rather than = 'pending': a 'revised' task has simply had
// its due date pushed, and it should start being chased again once that new date
// passes. waiting_approval is excluded because the doer has already finished —
// the task is sitting with the approver, and nagging the doer about something
// they cannot act on only teaches them to ignore the reminders.
async function findDue(now = Date.now()) {
  const dueOnOrBefore = istDateOf(now - FIRST_REMINDER_AFTER_H * HOUR_MS);
  const notRemindedSince = utcStamp(now - REPEAT_EVERY_H * HOUR_MS);

  const rows = await db.rows(
    `SELECT t.id, t.description, t.due_date, t.priority, t.remarks,
            t.last_reminder_at, t.reminder_count,
            u.id AS doer_id, u.name AS doer_name, u.phone,
            u.email, u.notification_email,
            b.name AS assigned_by_name,
            c.name AS client_name
       FROM delegation_tasks t
       JOIN users u ON u.id = t.assigned_to
       LEFT JOIN users b ON b.id = t.assigned_by
       LEFT JOIN clients c ON c.id = t.client_id
      WHERE t.status <> 'completed'
        AND t.waiting_approval = 0
        AND t.due_date <= ?
        AND (t.last_reminder_at IS NULL OR t.last_reminder_at <= ?)
      ORDER BY t.due_date, t.id`,
    [dueOnOrBefore, notRemindedSince]);

  return rows.map(r => ({ ...r, hoursOverdue: hoursOverdue(r.due_date, now) }));
}

const factsFor = (t) => ({
  doerName: t.doer_name,
  assignedByName: t.assigned_by_name || '',
  dueDate: toDateStr(t.due_date),
  priority: t.priority,
  description: t.description,
  clientName: t.client_name || null,
  remarks: t.remarks || '',
  hoursOverdue: t.hoursOverdue,
});

// Sends one task's reminder on every channel the doer can be reached on.
//
// WhatsApp goes out through sendRaw, NOT the shared queue: that queue holds each
// message for 4-5 minutes to look human, which is right for a burst triggered by
// one person clicking "assign" but fatal for a cron run that has to finish
// inside one request. Waumfy paces its own outbound queue anyway, so handing it
// everything at once loses nothing.
async function remindOne(task) {
  const facts = factsFor(task);
  const channels = [];

  if (task.phone) {
    channels.push(['whatsapp', wa.sendRaw(task.phone, wa.buildReminderMessage(facts))]);
  }
  const to = mail.recipientFor(task);
  if (to) {
    channels.push(['email', mail.sendReminderEmail(to, facts)]);
  }

  const settled = await Promise.allSettled(channels.map(([, p]) => p));
  const results = {};
  let anyOk = false;
  settled.forEach((r, i) => {
    const name = channels[i][0];
    if (r.status === 'fulfilled' && r.value && r.value.ok) { results[name] = 'ok'; anyOk = true; }
    else {
      const why = r.status === 'rejected'
        ? (r.reason && r.reason.message) || 'threw'
        : (r.value && (r.value.reason || `status ${r.value.status}`)) || 'failed';
      results[name] = why;
    }
  });
  return { anyOk, results };
}

// One pass. Only a task that actually reached somebody has its clock reset —
// otherwise a transient SMTP or Waumfy failure would silently buy the task
// another 8 hours of quiet, which is the opposite of what a chaser is for.
async function runTaskReminders({ now = Date.now(), dryRun = false } = {}) {
  const tasks = await findDue(now);
  if (!tasks.length) return { checked: 0, sent: 0, failed: 0, tasks: [] };
  if (dryRun) {
    return { checked: tasks.length, sent: 0, failed: 0, dryRun: true,
             tasks: tasks.map(t => ({ id: t.id, doer: t.doer_name, hoursOverdue: t.hoursOverdue })) };
  }

  const stamp = utcStamp(now);
  let sent = 0, failed = 0;
  const detail = [];

  for (const t of tasks) {
    const { anyOk, results } = await remindOne(t);
    if (anyOk) {
      await db.query(
        `UPDATE delegation_tasks
            SET last_reminder_at = ?, reminder_count = reminder_count + 1
          WHERE id = ?`, [stamp, t.id]);
      sent++;
    } else {
      failed++;
      console.error(`⚠️ Task reminder ${t.id} reached nobody:`, JSON.stringify(results));
    }
    detail.push({ id: t.id, doer: t.doer_name, hoursOverdue: t.hoursOverdue, ...results });
  }

  console.log(`⏰ Task reminders — ${sent} sent, ${failed} failed, ${tasks.length} due`);
  return { checked: tasks.length, sent, failed, tasks: detail };
}

module.exports = { runTaskReminders, findDue, hoursOverdue };
