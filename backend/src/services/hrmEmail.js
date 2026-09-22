// ══════════════════════════════════════════════════════
// RECRUITMENT EMAIL
//
// The letters a candidate receives: the interview invitation, a new time when
// it moves, and the outcome either way. These go to people outside the company
// — often the first thing they see of it — so they say what is happening, when,
// and what to do next, and nothing else.
//
// The same house style as the rest of the app's mail, reusing email.js's shell
// so a candidate's letter and a colleague's notification look like one company
// wrote them.
// ══════════════════════════════════════════════════════
const email = require('./email');

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// The shell's own label and footer belong to the task manager. A candidate
// has never heard of it, and the standing footer tells them not to reply to a
// letter that asks them to, so every letter here replaces both.
const TAG = 'RECRUITMENT';
const FOOTER = 'Sent by the Bunai recruitment team. You can reply to this email.';
const FOOTER_INTERNAL = 'Sent by Bunai Recruitment.';

// "2026-09-22" → "22 September 2026". A candidate should not have to read a
// date backwards, and an ISO string in a letter looks like a machine wrote it.
function longDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(String(d).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
}

// "14:30" → "2:30 PM", and anything it cannot read comes back untouched rather
// than becoming "Invalid Date" in somebody's inbox.
function niceTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  if (!m) return String(t || '');
  let h = Number(m[1]);
  const ampm = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}

const para = (html) =>
  `<p style="margin:0 0 14px;font-family:${FONT};font-size:14.5px;line-height:1.65;color:#334155">${html}</p>`;

// Everything below builds HTML out of what somebody typed into a form. A stray
// < or & in a name or a note would otherwise swallow the rest of the letter.
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The note the office typed, shown to the candidate and to nobody else. It is
// the part of the letter that is actually about them - which floor, what to
// bring - so it is set apart from the template text a machine wrote.
function note(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px">
    <tr><td style="background:#f8fafc;border-left:3px solid #f8b0b2;border-radius:0 6px 6px 0;padding:13px 16px;
      font-family:${FONT};font-size:14.5px;line-height:1.6;color:#334155">${esc(t).replace(/\r?\n/g, '<br>')}</td></tr></table>`;
}

// A plain-text twin of every letter. Some clients never render the HTML, and a
// candidate reading the fallback should still get the date and the link.
//
// Blocks have to become line breaks before the tags go, or every paragraph runs
// into the next one — "Dear Asha,Thank you for your interest" — and the detail
// table collapses into a ribbon of stray spaces.
function stripTags(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d)>/gi, '\n\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>\s*<td[^>]*>/gi, ': ')   // label cell, value cell → "Label: value"
    .replace(/<\/table>/gi, '\n\n')          // the note block, off on its own
    .replace(/<[^>]+>/g, '')
    // Undo the escaping the HTML needed, or a note with an & in it reaches the
    // candidate reading the fallback as "&amp;".
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function detail(rows) {
  const cells = rows
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `
      <tr>
        <td style="padding:7px 14px 7px 0;font-family:${FONT};font-size:13px;color:#64748b;white-space:nowrap">${k}</td>
        <td style="padding:7px 0;font-family:${FONT};font-size:14px;color:#0f172a;font-weight:600">${v}</td>
      </tr>`).join('');
  if (!cells) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"
    style="margin:4px 0 18px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:6px 16px">${cells}</table>`;
}

// ── The four letters ──────────────────────────────────

// The company is telling the candidate what has been arranged, not asking them
// for a favour. "We would like to invite you" read like a request that still
// needed their agreement, when in fact the slot is already booked and the
// interviewer has been told. So: the interview has been scheduled, here is
// when, tell us if you cannot make it.
function buildInterviewEmail(c) {
  const when = [longDate(c.interview_date), niceTime(c.interview_time)].filter(Boolean).join(', ');
  const body = para(`Dear ${esc(c.name)},`)
    + para(`Thank you for your interest in Bunai. Your interview${c.profile_position ? ` for the role of <b>${esc(c.profile_position)}</b>` : ''} has been scheduled. The details are below.`)
    + detail([['Date & time', when], ['Position', esc(c.profile_position)]])
    + note(c.notes)
    + para('The interview is held at our office. Please arrive a few minutes early.')
    + para('If you cannot make this time, reply to this email and we will arrange another.')
    + para('We look forward to meeting you.');
  const html = email.shell({
    preheader: `Interview scheduled${when ? ' — ' + when : ''}`,
    eyebrow: 'INTERVIEW SCHEDULED', eyebrowColor: '#1a56db',
    headline: 'Your interview has been scheduled', body,
    tag: TAG, footer: FOOTER,
  });
  return { subject: `Interview scheduled${c.profile_position ? ` — ${c.profile_position}` : ''}`, html, text: stripTags(body) };
}

function buildRescheduleEmail(c) {
  const when = [longDate(c.reschedule_date || c.interview_date), niceTime(c.reschedule_time || c.interview_time)]
    .filter(Boolean).join(', ');
  const body = para(`Dear ${esc(c.name)},`)
    + para('Your interview has been moved. The new time is below; everything else is unchanged.')
    + detail([['New date & time', when], ['Position', esc(c.profile_position)],
              ['Reason', esc(c.reschedule_reason)]])
    + note(c.notes)
    + para('Apologies for the change, and thank you for your patience.');
  const html = email.shell({
    preheader: `Interview moved${when ? ' to ' + when : ''}`,
    eyebrow: 'INTERVIEW RESCHEDULED', eyebrowColor: '#d97706',
    headline: 'Your interview has been moved', body,
    tag: TAG, footer: FOOTER,
  });
  return { subject: 'Your interview has been rescheduled', html, text: stripTags(body) };
}

function buildSelectedEmail(c) {
  const body = para(`Dear ${esc(c.name)},`)
    + para(`We are glad to tell you that you have been selected${c.profile_position ? ` for the role of <b>${esc(c.profile_position)}</b>` : ''} at Bunai.`)
    + detail([['Position', esc(c.profile_position)], ['Expected joining', longDate(c.joining_date)]])
    + para('We will follow up shortly with the next steps. If you have any questions in the meantime, simply reply to this email.')
    + para('Congratulations, and welcome.');
  const html = email.shell({
    preheader: 'You have been selected', eyebrow: 'SELECTED', eyebrowColor: '#059669',
    headline: 'Congratulations — you have been selected', body,
    tag: TAG, footer: FOOTER,
  });
  return { subject: `Congratulations — you have been selected${c.profile_position ? ` for ${c.profile_position}` : ''}`, html, text: stripTags(body) };
}

function buildRejectedEmail(c) {
  // Short, and without false comfort. The one thing it must do is close the
  // loop, because the worst outcome for a candidate is never being told.
  const body = para(`Dear ${esc(c.name)},`)
    + para(`Thank you for taking the time to speak with us${c.profile_position ? ` about the ${esc(c.profile_position)} role` : ''}.`)
    + para('After careful consideration we have decided not to proceed on this occasion. This is not a reflection of your ability, and we would be glad to hear from you about future openings.')
    + para('We wish you the very best.');
  const html = email.shell({
    preheader: 'Update on your application', eyebrow: 'APPLICATION UPDATE', eyebrowColor: '#64748b',
    headline: 'Update on your application', body,
    tag: TAG, footer: FOOTER,
  });
  return { subject: 'Update on your application', html, text: stripTags(body) };
}

// The interviewer's own letter. Not the candidate's: it carries the phone
// number and the address, which is how the person taking the interview reaches
// them if something changes on the day.
//
// The Notes box is deliberately absent. What gets typed there is written for
// the candidate - which floor, what to bring - so it belongs in their letter,
// and repeating it here only pads a page somebody is skimming for a number.
function buildInterviewerEmail(c) {
  const when = [longDate(c.reschedule_date || c.interview_date),
                niceTime(c.reschedule_time || c.interview_time)].filter(Boolean).join(', ');
  const body = para('Hello,')
    + para(`An interview has been scheduled with <b>${esc(c.name)}</b>${c.profile_position ? ` for the ${esc(c.profile_position)} role` : ''}.`)
    + detail([
        ['Candidate', esc(c.name)],
        ['Position', esc(c.profile_position)],
        ['Date & time', when],
        ['Candidate phone', esc(c.phone)],
        ['Candidate email', esc(c.email)],
      ])
    + para('The candidate has been sent the date and time separately.');
  const html = email.shell({
    preheader: `Interview with ${c.name}${when ? ' — ' + when : ''}`,
    eyebrow: 'INTERVIEW SCHEDULED', eyebrowColor: '#1a56db',
    headline: `Interview scheduled with ${c.name}`, body,
    tag: TAG, footer: FOOTER_INTERNAL,
  });
  return {
    subject: `Interview scheduled — ${c.name}${c.profile_position ? ` (${c.profile_position})` : ''}`,
    html, text: stripTags(body),
  };
}

// Sent to the interviewer, not the candidate, so it has its own path rather
// than a `kind` in sendToCandidate — the address it goes to is different.
async function sendToInterviewer(candidate) {
  const { subject, html, text } = buildInterviewerEmail(candidate);
  if (!candidate.interviewer_email) return { ok: false, reason: 'no interviewer email', subject };
  const r = await email.sendMail(candidate.interviewer_email, subject, { text, html });
  return { ...r, subject };
}

const BUILDERS = {
  interview: buildInterviewEmail,
  rescheduled: buildRescheduleEmail,
  selected: buildSelectedEmail,
  rejected: buildRejectedEmail,
};

// Builds and sends in one step, returning what happened rather than throwing,
// so the caller can record a failure against the candidate instead of losing
// the whole request to it.
async function sendToCandidate(kind, candidate) {
  const build = BUILDERS[kind];
  if (!build) return { ok: false, reason: 'unknown email kind: ' + kind, subject: '' };
  const { subject, html, text } = build(candidate);
  if (!candidate.email) return { ok: false, reason: 'candidate has no email address', subject };
  const r = await email.sendMail(candidate.email, subject, { text, html });
  return { ...r, subject };
}

module.exports = { BUILDERS, sendToCandidate, sendToInterviewer, buildInterviewerEmail, longDate, niceTime };
