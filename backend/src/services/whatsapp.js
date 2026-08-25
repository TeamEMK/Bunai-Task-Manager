// ══════════════════════════════════════════════════════
// WHATSAPP (Waumfy) — one FIFO queue for the whole process.
//
// Every message (delegation, checklist created, daily reminder) leaves through
// the same queue with a 4-5 minute random gap, so WhatsApp does not read the
// traffic as a blast and message order is preserved. Leaving WAUMFY_API_KEY
// blank disables all of it silently.
// ══════════════════════════════════════════════════════
const config = require('../config');
const { formatHumanDate } = require('../utils/dates');

const cfg = config.whatsapp;

// Normalises Indian mobile numbers to "91XXXXXXXXXX" (no +, no leading 0).
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (digits.length === 10) digits = '91' + digits;
  else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
  return digits;
}

async function sendRaw(phone, message) {
  if (!cfg.apiKey) return { ok: false, reason: 'disabled — WAUMFY_API_KEY not set' };
  const to = normalizePhone(phone);
  if (!to) return { ok: false, reason: 'no valid phone number' };
  try {
    const resp = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey },
      body: JSON.stringify({ phone: to, message }),
    });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!resp.ok) {
      console.error('⚠️ Waumfy WhatsApp send failed:', resp.status, data);
      return { ok: false, status: resp.status, data };
    }
    return { ok: true, status: resp.status, data };
  } catch (err) {
    console.error('⚠️ Waumfy WhatsApp send error:', err.message);
    return { ok: false, reason: err.message };
  }
}

// ── Queue ─────────────────────────────────────────────
const nextGapMs = () => {
  if (cfg.gapFixedMs != null && cfg.gapFixedMs >= 0) return cfg.gapFixedMs;
  const lo = Math.min(cfg.gapMinMs, cfg.gapMaxMs);
  const hi = Math.max(cfg.gapMinMs, cfg.gapMaxMs);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
};
// For estimates/labels only.
const avgGapMs = () => (cfg.gapFixedMs != null && cfg.gapFixedMs >= 0)
  ? cfg.gapFixedMs : Math.round((cfg.gapMinMs + cfg.gapMaxMs) / 2);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const queue = [];
let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      let result;
      try { result = await sendRaw(job.phone, job.message); }
      catch (e) { result = { ok: false, reason: e.message }; }
      try { job.resolve(result); } catch {}
      if (queue.length) await sleep(nextGapMs());   // no pointless wait after the last one
    }
  } finally { draining = false; }
}

function enqueue(phone, message, label) {
  return new Promise((resolve) => {
    queue.push({ phone, message, label: label || 'msg', resolve });
    drain();
  });
}

// Queues after delayMs; the queue then applies its own gap.
function queueMessage(phone, message, { delayMs = 0, label = 'msg' } = {}) {
  if (delayMs > 0) {
    return new Promise((resolve) => {
      setTimeout(() => { enqueue(phone, message, label).then(resolve); }, delayMs);
    });
  }
  return enqueue(phone, message, label);
}

// ── Message templates ─────────────────────────────────
const FREQ_LABEL = {
  daily: 'Daily', weekly: 'Weekly', alternative_week: 'Alternative Week',
  monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly',
};
const PRIORITY_EMOJI = { high: '🔴', medium: '🟠', low: '🟢' };
const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const numBullet = (i) => (i < 10 ? NUM_EMOJI[i] : `🔹 ${i + 1}.`);

// Sent to the doer when a delegation task is assigned (after the configured delay).
function buildDelegationMessage({ doerName, assignedByName, dueDate, priority, description, clientName, remarks }) {
  const pr = String(priority || 'low').toLowerCase();
  const lines = [];
  lines.push(`🔔 *New Task Delegated*`);
  lines.push('');
  lines.push(`Hello ${doerName || ''} 👋`);
  lines.push('');
  lines.push(`📋 *Task:* ${description || ''}`);
  if (clientName) lines.push(`🏢 *Client:* ${clientName}`);
  lines.push(`${PRIORITY_EMOJI[pr] || '🟢'} *Priority:* ${pr.toUpperCase()}`);
  lines.push(`📅 *Due:* ${formatHumanDate(dueDate)}`);
  if (assignedByName) lines.push(`👤 *Assign by:* ${assignedByName}`);
  if (remarks) lines.push(`📝 *Remarks:* ${remarks}`);
  lines.push('');
  lines.push(`✅ Mark it as *Done* in the app as soon as the work is finished.`);
  lines.push(`— Bunai Task Manager`);
  return lines.join('\n');
}

function sendDelegationMessage(phone, opts) {
  return queueMessage(phone, buildDelegationMessage(opts),
    { delayMs: cfg.delegationDelayMs, label: 'delegation' });
}

// Summary sent to the doer as soon as a checklist series is created.
function buildChecklistCreatedMessage({ doerName, assignedByName, description, frequency, startDate, endDate, totalTasks, clientName, remarks }) {
  const lines = [];
  lines.push(`🔔 *New Checklist Assigned*`);
  lines.push('');
  lines.push(`Hello ${doerName || ''} 👋`);
  lines.push('');
  lines.push(`📋 *Task:* ${description || ''}`);
  if (clientName) lines.push(`🏢 *Client:* ${clientName}`);
  lines.push(`🔁 *Frequency:* ${FREQ_LABEL[frequency] || 'Recurring'}`);
  lines.push(`📅 *Start:* ${formatHumanDate(startDate)}`);
  if (endDate) lines.push(`🏁 *End:* ${formatHumanDate(endDate)}`);
  if (totalTasks) lines.push(`🗂 *Total:* ${totalTasks} task`);
  if (assignedByName) lines.push(`👤 *Assign by:* ${assignedByName}`);
  if (remarks) lines.push(`📝 *Remarks:* ${remarks}`);
  lines.push('');
  lines.push(`⏰ You will get a reminder for that day’s checklist every morning at 10 AM.`);
  lines.push(`— Bunai Task Manager`);
  return lines.join('\n');
}

// ALL of one user's checklist tasks for that day — in a single message.
function buildChecklistDailyMessage(doerName, dateStr, tasks) {
  const lines = [];
  lines.push(`🌅 *Good Morning ${doerName || ''}!*`);
  lines.push('');
  lines.push(`📋 *Today’s Checklist* — ${formatHumanDate(dateStr)}`);
  lines.push(tasks.length === 1 ? `You have *1 task* today:` : `You have *${tasks.length} tasks* today:`);
  lines.push('');
  tasks.forEach((t, i) => {
    lines.push(`${numBullet(i)} ${t.description || ''}`);
    const meta = [];
    const pr = String(t.priority || 'low').toLowerCase();
    meta.push(`${PRIORITY_EMOJI[pr] || '🟢'} ${pr.toUpperCase()}`);
    if (t.client_name) meta.push(`🏢 ${t.client_name}`);
    lines.push(`     ${meta.join('  •  ')}`);
    if (t.remarks) lines.push(`     📝 ${t.remarks}`);
    lines.push('');
  });
  lines.push(`✅ Mark it as *Done* in the app as soon as the work is finished.`);
  lines.push(`— Bunai Task Manager`);
  return lines.join('\n');
}

module.exports = {
  normalizePhone, sendRaw, queueMessage, avgGapMs,
  sendDelegationMessage, buildDelegationMessage,
  buildChecklistCreatedMessage, buildChecklistDailyMessage,
  checklistCreatedDelayMs: cfg.delegationDelayMs,
};
