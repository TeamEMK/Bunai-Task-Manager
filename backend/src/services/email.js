// ══════════════════════════════════════════════════════
// EMAIL (Gmail SMTP) — the notification channel that runs beside WhatsApp.
//
// No queue and no delay here. The 4-5 minute pacing in whatsapp.js exists so
// WhatsApp does not read a burst as spam; SMTP has no such problem, so an email
// goes out the moment the task is saved. Leaving SMTP_PASS blank disables all
// of it silently, exactly like a blank WAUMFY_API_KEY does for WhatsApp.
//
// The markup below is deliberately old-fashioned — nested tables, inline styles,
// no flexbox, no <style> block. Outlook renders HTML through Word, which drops
// most modern CSS, and Gmail strips <style> on forwards. Tables and inline
// attributes are the only things every client agrees on.
// ══════════════════════════════════════════════════════
const nodemailer = require('nodemailer');
const config = require('../config');
const { formatHumanDate } = require('../utils/dates');

const cfg = config.email;

// Built on first use, then reused: nodemailer pools connections per transport,
// so making a new one per email would open a fresh TLS handshake every time.
let _transport = null;
function transport() {
  if (!cfg.pass || !cfg.user) return null;
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,   // 465 is implicit TLS; 587 upgrades via STARTTLS
      auth: { user: cfg.user, pass: cfg.pass },
    });
  }
  return _transport;
}

// Picks where a user's mail should go. notification_email wins when it is set —
// that is the whole reason the column exists — otherwise the login address.
function recipientFor(user) {
  if (!user) return null;
  const preferred = String(user.notification_email || '').trim();
  const fallback = String(user.email || '').trim();
  return preferred || fallback || null;
}

async function sendMail(to, subject, { text, html }) {
  const t = transport();
  if (!t) return { ok: false, reason: 'disabled — SMTP_USER/SMTP_PASS not set' };
  if (!to) return { ok: false, reason: 'no recipient address' };
  try {
    const info = await t.sendMail({ from: cfg.from, to, subject, text, html });
    return { ok: true, messageId: info.messageId, accepted: info.accepted };
  } catch (err) {
    console.error('⚠️ Email send failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

// Verifies the SMTP credentials without sending anything — used by the
// diagnostics route so a wrong app password is visible before a task depends
// on it.
async function verify() {
  const t = transport();
  if (!t) return { ok: false, reason: 'disabled — SMTP_USER/SMTP_PASS not set' };
  try { await t.verify(); return { ok: true }; }
  catch (err) { return { ok: false, reason: err.message }; }
}

// ── Presentation ──────────────────────────────────────
const FONT = `-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;

const INK = '#0f172a';      // headings
const BODY = '#475569';     // paragraphs
const MUTED = '#94a3b8';    // footer, labels
const LINE = '#e2e8f0';     // hairlines
const CANVAS = '#eef1f5';   // area around the card

// Background / text / border per priority, so the badge stays readable instead
// of being coloured text on white.
const PRIORITY = {
  high:   { bg: '#fef2f2', fg: '#b91c1c', br: '#fecaca' },
  medium: { bg: '#fff7ed', fg: '#c2410c', br: '#fed7aa' },
  low:    { bg: '#f0fdf4', fg: '#15803d', br: '#bbf7d0' },
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// The grey line a mail client shows after the subject. Without it clients grab
// the first words of the body, which here would be "Hello <name>," on every
// single mail and tell the reader nothing.
const preheaderHtml = (text) =>
  `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">` +
  `${esc(text)}${'&#847;&zwnj;&nbsp;'.repeat(60)}</div>`;

const priorityBadge = (pr) => {
  const c = PRIORITY[pr] || PRIORITY.low;
  return `<span style="display:inline-block;padding:3px 10px;border-radius:11px;background:${c.bg};` +
         `border:1px solid ${c.br};color:${c.fg};font-size:11px;font-weight:700;letter-spacing:.6px">${esc(pr.toUpperCase())}</span>`;
};

// [label, value] pairs. Empty values drop out entirely, so a task with no client
// shows no "Client" line rather than an empty one.
function detailTable(pairs) {
  const rows = pairs.filter(([, v]) => v != null && v !== '');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">` +
    rows.map(([label, value], i) => {
      const border = i === rows.length - 1 ? '' : `border-bottom:1px solid ${LINE};`;
      return `<tr>` +
        `<td style="${border}padding:11px 16px 11px 0;color:${MUTED};font-size:13px;font-family:${FONT};white-space:nowrap;vertical-align:top">${esc(label)}</td>` +
        `<td style="${border}padding:11px 0;color:${INK};font-size:14px;font-family:${FONT};vertical-align:top">${value}</td>` +
      `</tr>`;
    }).join('') + `</table>`;
}

// Padded anchor inside a table cell — the one button shape that survives Outlook
// without dropping into VML. Omitted entirely when APP_URL is not configured.
function ctaButton(label) {
  if (!cfg.appUrl) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 4px">` +
    `<tr><td bgcolor="${INK}" style="border-radius:6px">` +
    `<a href="${esc(cfg.appUrl)}" target="_blank" style="display:inline-block;padding:12px 26px;` +
    `font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">${esc(label)}</a>` +
    `</td></tr></table>`;
}

// Shared chrome: branded bar, white card, footer. Only `body` changes per mail.
function shell({ preheader, eyebrow, eyebrowColor, headline, body }) {
  return `<!--[if mso]><style>body,table,td{font-family:Arial,sans-serif !important}</style><![endif]-->
${preheaderHtml(preheader)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CANVAS};margin:0;padding:32px 12px">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;background:#ffffff;border:1px solid ${LINE};border-radius:10px;overflow:hidden">

      <tr><td style="background:${INK};padding:18px 32px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;letter-spacing:2.5px">BUNAI</td>
            <td align="right" style="font-family:${FONT};font-size:11px;color:#94a3b8;letter-spacing:.8px">TASK MANAGER</td>
          </tr>
        </table>
      </td></tr>

      <tr><td style="padding:30px 32px 8px">
        <div style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:1.4px;color:${eyebrowColor};text-transform:uppercase">${esc(eyebrow)}</div>
        <div style="font-family:${FONT};font-size:21px;font-weight:600;color:${INK};margin-top:7px;line-height:1.35">${esc(headline)}</div>
      </td></tr>

      <tr><td style="padding:14px 32px 30px">${body}</td></tr>

      <tr><td style="background:#f8fafc;border-top:1px solid ${LINE};padding:18px 32px">
        <div style="font-family:${FONT};font-size:12px;color:${MUTED};line-height:1.6">
          This is an automated message from Bunai Task Manager. Please do not reply to this email.
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>`.trim();
}

const paragraph = (t) =>
  `<p style="margin:0 0 18px;font-family:${FONT};font-size:15px;color:${BODY};line-height:1.6">${t}</p>`;

// The task itself, set apart from the metadata table beneath it.
const taskBlock = (description, accent) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 22px">` +
  `<tr><td style="background:#f8fafc;border-left:3px solid ${accent};border-radius:0 6px 6px 0;padding:15px 18px;` +
  `font-family:${FONT};font-size:16px;font-weight:600;color:${INK};line-height:1.45">${esc(description)}</td></tr></table>`;

// ── Templates ─────────────────────────────────────────
// Mirrors buildDelegationMessage() in whatsapp.js — same facts, same order, so
// a doer who gets both does not have to reconcile two different stories.
function buildDelegationEmail({ doerName, assignedByName, dueDate, priority, description, clientName, remarks }) {
  const pr = String(priority || 'low').toLowerCase();
  const due = formatHumanDate(dueDate);
  const subject = `New task assigned: ${description || ''}`.slice(0, 180);

  const text = [
    `Hello ${doerName || ''},`,
    '',
    `A new task has been assigned to you.`,
    '',
    `Task: ${description || ''}`,
    clientName ? `Client: ${clientName}` : null,
    `Priority: ${pr.toUpperCase()}`,
    `Due: ${due}`,
    assignedByName ? `Assigned by: ${assignedByName}` : null,
    remarks ? `Remarks: ${remarks}` : null,
    '',
    `Mark it as Done in the app as soon as the work is finished.`,
    cfg.appUrl ? cfg.appUrl : null,
    `— Bunai Task Manager`,
  ].filter(l => l !== null).join('\n');

  const html = shell({
    preheader: `${description || 'New task'} · due ${due} · ${pr.toUpperCase()} priority`,
    eyebrow: 'New Task Assigned',
    eyebrowColor: '#2563eb',
    headline: `Hello ${doerName || ''}, you have a new task`,
    body:
      paragraph('A new task has been delegated to you. The details are below.') +
      taskBlock(description || '', (PRIORITY[pr] || PRIORITY.low).fg) +
      detailTable([
        ['Client', clientName ? esc(clientName) : ''],
        ['Priority', priorityBadge(pr)],
        ['Due date', `<strong style="color:${INK}">${esc(due)}</strong>`],
        ['Assigned by', assignedByName ? esc(assignedByName) : ''],
        ['Remarks', remarks ? esc(remarks) : ''],
      ]) +
      ctaButton('Open Task Manager') +
      paragraph(`<span style="font-size:13px;color:${MUTED}">Mark the task as <strong style="color:${BODY}">Done</strong> in the app once the work is finished.</span>`),
  });

  return { subject, text, html };
}

// Sent when a delegated task is past its due date and still not done: once at
// 12 hours overdue, then every 8 hours until it is closed. Deliberately louder
// than the delegation mail — same facts, but led by how late the task is, since
// that is the only new information a repeat reminder carries.
function buildReminderEmail({ doerName, assignedByName, dueDate, priority, description, clientName, remarks, hoursOverdue }) {
  const pr = String(priority || 'low').toLowerCase();
  const due = formatHumanDate(dueDate);
  const late = Number(hoursOverdue) || 0;
  // "13 hours" reads wrong once it runs into days, and these repeat for as long
  // as the task stays open, so switch units rather than printing "76 hours".
  const lateText = late >= 48
    ? `${Math.floor(late / 24)} days overdue`
    : `${late} hour${late === 1 ? '' : 's'} overdue`;
  const subject = `Overdue (${lateText}): ${description || ''}`.slice(0, 180);

  const text = [
    `Hello ${doerName || ''},`,
    '',
    `This task is still open and is now ${lateText}.`,
    '',
    `Task: ${description || ''}`,
    clientName ? `Client: ${clientName}` : null,
    `Priority: ${pr.toUpperCase()}`,
    `Due was: ${due}`,
    assignedByName ? `Assigned by: ${assignedByName}` : null,
    remarks ? `Remarks: ${remarks}` : null,
    '',
    `Mark it as Done in the app to stop these reminders.`,
    `Until then this reminder repeats every 8 hours.`,
    cfg.appUrl ? cfg.appUrl : null,
    `— Bunai Task Manager`,
  ].filter(l => l !== null).join('\n');

  const html = shell({
    preheader: `${lateText} · ${description || 'Task'} · was due ${due}`,
    eyebrow: `Overdue · ${lateText}`,
    eyebrowColor: '#dc2626',
    headline: `Hello ${doerName || ''}, this task is still open`,
    body:
      paragraph(`It passed its due date and has not been marked done. It is now <strong style="color:#b91c1c">${esc(lateText)}</strong>.`) +
      taskBlock(description || '', '#dc2626') +
      detailTable([
        ['Client', clientName ? esc(clientName) : ''],
        ['Priority', priorityBadge(pr)],
        ['Due date', `<strong style="color:#b91c1c">${esc(due)}</strong>`],
        ['Assigned by', assignedByName ? esc(assignedByName) : ''],
        ['Remarks', remarks ? esc(remarks) : ''],
      ]) +
      ctaButton('Complete This Task') +
      paragraph(`<span style="font-size:13px;color:${MUTED}">Mark it as <strong style="color:${BODY}">Done</strong> to stop these reminders. Until then this repeats every 8 hours.</span>`),
  });

  return { subject, text, html };
}

function sendDelegationEmail(to, opts) {
  const { subject, text, html } = buildDelegationEmail(opts);
  return sendMail(to, subject, { text, html });
}

function sendReminderEmail(to, opts) {
  const { subject, text, html } = buildReminderEmail(opts);
  return sendMail(to, subject, { text, html });
}

module.exports = {
  enabled: () => !!(cfg.user && cfg.pass),
  recipientFor, sendMail, verify,
  buildDelegationEmail, sendDelegationEmail,
  buildReminderEmail, sendReminderEmail,
};
