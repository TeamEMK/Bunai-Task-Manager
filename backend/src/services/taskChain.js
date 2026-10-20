// ══════════════════════════════════════════════════════
// TASK CHAINS - one task done in steps, by different people, in order.
//
// "Build the wall" needs bricks (A), then cement (B), then sand (C). Each step
// is an ordinary delegation task in its doer's own list, so it is done,
// approved, revised and reminded about exactly like any other. What the chain
// adds is the order:
//
//   - only the first step is open when the chain is made; the rest are locked
//     (chain_locked = 1) and have no due date, so nothing chases them and no
//     report counts them as late;
//   - when a step is completed - by its doer, or by its approver - the next one
//     opens: its due date is its own number of days from that day, and its doer
//     is told it is their turn;
//   - when the last step is completed the chain is done, and whoever made it is
//     told.
//
// A step's days count from when the step before it finished, not from when the
// chain was made, so one late step moves the rest along rather than leaving
// them all overdue at once.
// ══════════════════════════════════════════════════════
const { db } = require('../db/pool');
const { istToday, addDays, formatHumanDate } = require('../utils/dates');
const { loadHolidaysSet, isUserOffOn, nextWorkingDay } = require('./holidays');
const wa = require('./whatsapp');
const mail = require('./email');

// Today plus a step's days, moved off a holiday as any delegated task is.
async function dueAfter(days) {
  let d = addDays(istToday(), Math.max(0, Number(days) || 0));
  try {
    const holidays = await loadHolidaysSet();
    if (isUserOffOn(null, d, holidays)) d = nextWorkingDay(null, d, holidays);
  } catch (_) { /* no holiday list: the plain date stands */ }
  return d;
}

// What a step is called wherever it is shown: the chain, its place, its words.
const stepTitle = (chainTitle, step, total, desc) => `${chainTitle} - Step ${step} of ${total}: ${desc}`;

// Tell a step's doer it is now theirs. Fire-and-forget, like every task notice.
function notifyStepOpen(taskId, note) {
  (async () => {
    try {
      const t = await db.one(
        `SELECT t.id, t.description, t.priority, t.chain_step,
                DATE_FORMAT(t.due_date, '%Y-%m-%d') due_date,
                ch.title, (SELECT COUNT(*) FROM delegation_tasks x WHERE x.chain_id = t.chain_id) total,
                u.name doer_name, u.phone, u.email, u.notification_email,
                b.name by_name, c.name client_name
           FROM delegation_tasks t
           JOIN task_chains ch ON ch.id = t.chain_id
           JOIN users u ON u.id = t.assigned_to
           LEFT JOIN users b ON b.id = ch.created_by
           LEFT JOIN clients c ON c.id = t.client_id
          WHERE t.id = ?`, [taskId]);
      if (!t) return;
      const facts = {
        doerName: t.doer_name, assignedByName: t.by_name || '', dueDate: t.due_date,
        priority: t.priority || 'low', clientName: t.client_name,
        description: stepTitle(t.title, t.chain_step, Number(t.total), t.description),
        remarks: note || '',
      };
      const jobs = [];
      if (t.phone) jobs.push(wa.sendDelegationMessage(t.phone, facts));
      const to = mail.recipientFor(t);
      if (to) jobs.push(mail.sendDelegationEmail(to, facts));
      await Promise.allSettled(jobs);
    } catch (e) { console.error('Chain step notice failed:', e.message); }
  })();
}

// Tell whoever made the chain that every step is done.
function notifyChainDone(chainId) {
  (async () => {
    try {
      const ch = await db.one(
        `SELECT ch.title, u.name, u.phone, u.email, u.notification_email
           FROM task_chains ch JOIN users u ON u.id = ch.created_by WHERE ch.id = ?`, [chainId]);
      if (!ch) return;
      const steps = await db.rows(
        `SELECT t.chain_step, t.description, u.name FROM delegation_tasks t
           JOIN users u ON u.id = t.assigned_to WHERE t.chain_id = ? ORDER BY t.chain_step`, [chainId]);
      const list = steps.map(s => `${s.chain_step}. ${s.description} - ${s.name}`).join('\n');
      const text = `✅ *Task complete*\n\nHello ${ch.name || ''} 👋\n\n*${ch.title}* is done: all ${steps.length} steps are finished.\n\n${list}\n\n— Bunai Task Manager`;
      const jobs = [];
      if (ch.phone) jobs.push(wa.queueMessage(ch.phone, text, { label: 'chain-done' }));
      const to = mail.recipientFor(ch);
      if (to) jobs.push(mail.sendMail(to, `Done: ${ch.title}`, { text: text.replace(/\*/g, '') }));
      await Promise.allSettled(jobs);
    } catch (e) { console.error('Chain done notice failed:', e.message); }
  })();
}

// After a step of the chain is completed: open the next one, or close the chain.
async function advance(chainId) {
  if (!chainId) return;
  const steps = await db.rows(
    `SELECT t.id, t.chain_step, t.chain_days, t.status, t.chain_locked, t.description, u.name doer
       FROM delegation_tasks t JOIN users u ON u.id = t.assigned_to
      WHERE t.chain_id = ? ORDER BY t.chain_step`, [chainId]);
  if (!steps.length) return;
  const next = steps.find(s => s.status !== 'completed');
  if (!next) {
    const [r] = await db.query(
      `UPDATE task_chains SET status = 'done', done_at = UTC_TIMESTAMP() WHERE id = ? AND status <> 'done'`, [chainId]);
    if (r.affectedRows) notifyChainDone(chainId);
    return;
  }
  if (!Number(next.chain_locked)) return;           // already open
  const due = await dueAfter(next.chain_days);
  const [r] = await db.query(
    `UPDATE delegation_tasks SET chain_locked = 0, due_date = ? WHERE id = ? AND chain_locked = 1`, [due, next.id]);
  if (!r.affectedRows) return;                      // someone else opened it a moment ago
  const prev = steps.filter(s => s.chain_step < next.chain_step).pop();
  notifyStepOpen(next.id, prev
    ? `Step ${prev.chain_step} (${prev.description}) is done by ${prev.doer} - it is your turn now.`
    : 'It is your turn now.');
}

module.exports = { advance, dueAfter, notifyStepOpen, stepTitle, formatHumanDate };
