// ══════════════════════════════════════════════════════
// RECRUITMENT (/api/hrm/*)
//
// The hiring pipeline: candidates being interviewed, their outcome, and the
// letters sent to them along the way. hr.routes.js is the other half — people
// already employed. Somebody who joins moves from this table to that one.
//
// Modelled on the same pipeline in the e-marketing project, with one deliberate
// difference: that one reaches candidates over WhatsApp, this one emails them.
//
// A letter that fails is recorded and the request still succeeds. Losing the
// candidate record because an SMTP server was briefly unhappy would be the
// wrong trade, and a silent failure would be worse than either — hence the log.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const hrmEmail = require('../services/hrmEmail');

const router = express.Router();

const STATUSES = ['Scheduled', 'Rescheduled', 'Selected', 'Rejected', 'Offer Sent'];

// Which letter belongs to which status. A status with no entry simply sends
// nothing — "Offer Sent" is here as a pipeline stage, and the offer letter
// itself is not part of this portal yet.
const EMAIL_FOR_STATUS = { Rescheduled: 'rescheduled', Selected: 'selected', Rejected: 'rejected' };

const clean = (v, max = 255) => String(v ?? '').trim().slice(0, max);
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);
// Deliberately forgiving: this only stops obvious typos, and a real address
// that trips a stricter pattern would block a hire for no good reason.
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

// Records what was sent, or why it was not. Never throws — a failure to write
// the log must not take down the action it was describing.
async function logEmail(candidate, action, result) {
  try {
    await db.query(
      `INSERT INTO hrm_message_log (candidate_id, candidate_name, email, action, subject, status, error_detail)
       VALUES (?,?,?,?,?,?,?)`,
      [candidate.id || null, clean(candidate.name), clean(candidate.email), clean(action),
       clean(result?.subject, 500), result?.ok ? 'Sent' : 'Failed',
       result?.ok ? null : clean(result?.reason, 1000)]);
  } catch (e) {
    console.error('  ⚠️ could not write hrm_message_log:', e.message);
  }
}

async function mailCandidate(candidate, kind, action) {
  const result = await hrmEmail.sendToCandidate(kind, candidate).catch(e => ({ ok: false, reason: e.message }));
  await logEmail(candidate, action, result);
  return result;
}

// ── Stats ─────────────────────────────────────────────
router.get('/hrm/stats', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const rows = await db.rows('SELECT status, COUNT(*) AS n FROM hrm_candidates GROUP BY status');
  const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const r of rows) byStatus[r.status] = Number(r.n) || 0;

  const upcoming = await db.one(
    `SELECT COUNT(*) AS n FROM hrm_candidates
      WHERE status IN ('Scheduled','Rescheduled')
        AND COALESCE(reschedule_date, interview_date) >= CURDATE()`);
  const failed = await db.one("SELECT COUNT(*) AS n FROM hrm_message_log WHERE status='Failed'");

  res.json({
    total: rows.reduce((a, r) => a + (Number(r.n) || 0), 0),
    byStatus,
    upcoming: Number(upcoming?.n) || 0,
    failedEmails: Number(failed?.n) || 0,
  });
}));

// ── List ──────────────────────────────────────────────
router.get('/hrm/candidates', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const q = clean(req.query.q, 120);
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';

  const where = [];
  const args = [];
  if (q) {
    where.push('(c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.profile_position LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status) { where.push('c.status = ?'); args.push(status); }

  const rows = await db.rows(
    `SELECT c.*, u.name AS created_by_name,
            DATE_FORMAT(c.interview_date,'%Y-%m-%d')  AS interview_date,
            DATE_FORMAT(c.reschedule_date,'%Y-%m-%d') AS reschedule_date,
            DATE_FORMAT(c.joining_date,'%Y-%m-%d')    AS joining_date,
            DATE_FORMAT(c.created_at,'%Y-%m-%d %H:%i') AS created_at
       FROM hrm_candidates c
       LEFT JOIN users u ON u.id = c.created_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(c.reschedule_date, c.interview_date) DESC, c.id DESC
      LIMIT 500`, args);
  res.json(rows);
}));

// ── Create ────────────────────────────────────────────
router.post('/hrm/candidates', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name);
  const email = clean(b.email);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!looksLikeEmail(email)) return res.status(400).json({ error: 'A valid email address is required — the invitation is sent there' });

  const candidate = {
    name,
    email,
    phone: clean(b.phone, 50),
    profile_position: clean(b.profile_position),
    interviewer_email: clean(b.interviewer_email),
    interview_date: dateOrNull(b.interview_date),
    interview_time: clean(b.interview_time, 20),
    salary: clean(b.salary, 100),
    notes: clean(b.notes, 5000),
  };

  const [r] = await db.query(
    `INSERT INTO hrm_candidates
       (name,email,phone,profile_position,interviewer_email,
        interview_date,interview_time,salary,notes,status,created_by)
     VALUES (?,?,?,?,?,?,?,?,?, 'Scheduled', ?)`,
    [candidate.name, candidate.email, candidate.phone, candidate.profile_position,
     candidate.interviewer_email,
     candidate.interview_date, candidate.interview_time,
     candidate.salary, candidate.notes, req.session.userId]);
  candidate.id = r.insertId;

  // The invitation goes only when there is a time to invite them to; a record
  // created to be filled in later should not email somebody an empty date.
  let mail = null;
  if (b.sendEmail !== false && candidate.interview_date) {
    mail = await mailCandidate(candidate, 'interview', 'Interview invitation');
  }

  // The interviewer is told separately. Their letter is not the candidate's —
  // it carries the phone number and the notes, which the candidate should not
  // see, and it is worth sending even when the candidate's fails.
  let intv = null;
  if (b.sendEmail !== false && candidate.interview_date && looksLikeEmail(candidate.interviewer_email)) {
    intv = await hrmEmail.sendToInterviewer(candidate).catch(e => ({ ok: false, reason: e.message }));
    await logEmail({ ...candidate, name: 'Interviewer', email: candidate.interviewer_email },
      'Interviewer notified', intv);
  }

  res.json({
    id: candidate.id,
    emailed: !!mail?.ok, emailError: mail && !mail.ok ? mail.reason : null,
    interviewerEmailed: !!intv?.ok, interviewerError: intv && !intv.ok ? intv.reason : null,
  });
}));

// ── Update ────────────────────────────────────────────
router.put('/hrm/candidates/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await db.one('SELECT * FROM hrm_candidates WHERE id=?', [id]);
  if (!existing) throw httpError(404, 'Candidate not found');

  const b = req.body || {};
  const name = clean(b.name) || existing.name;
  const email = clean(b.email) || existing.email;
  if (!looksLikeEmail(email)) return res.status(400).json({ error: 'A valid email address is required' });

  await db.query(
    `UPDATE hrm_candidates SET name=?, email=?, phone=?, profile_position=?,
            interviewer_email=?,
            interview_date=?, interview_time=?, salary=?, notes=?, joining_date=?
      WHERE id=?`,
    [name, email, clean(b.phone, 50), clean(b.profile_position),
     clean(b.interviewer_email),
     dateOrNull(b.interview_date), clean(b.interview_time, 20),
     clean(b.salary, 100), clean(b.notes, 5000), dateOrNull(b.joining_date), id]);
  res.json({ success: true });
}));

// ── Status ────────────────────────────────────────────
// The one action that sends a letter, so it is its own endpoint rather than a
// field on the edit form: changing somebody's status is a decision, and an
// accidental keystroke should not tell a candidate they were rejected.
router.put('/hrm/candidates/:id/status', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = clean(req.body?.status, 20);
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });

  const c = await db.one('SELECT * FROM hrm_candidates WHERE id=?', [id]);
  if (!c) throw httpError(404, 'Candidate not found');

  const b = req.body || {};
  const fields = { status };
  if (status === 'Rescheduled') {
    fields.reschedule_date = dateOrNull(b.reschedule_date);
    fields.reschedule_time = clean(b.reschedule_time, 20);
    fields.reschedule_reason = clean(b.reschedule_reason, 2000);
    if (!fields.reschedule_date) return res.status(400).json({ error: 'A new interview date is required to reschedule' });
  }
  if (status === 'Selected') fields.joining_date = dateOrNull(b.joining_date);

  const sets = Object.keys(fields).map(k => `${k}=?`).join(', ');
  await db.query(`UPDATE hrm_candidates SET ${sets} WHERE id=?`, [...Object.values(fields), id]);

  const updated = { ...c, ...fields };
  let mail = null;
  const kind = EMAIL_FOR_STATUS[status];
  if (kind && b.sendEmail !== false) {
    mail = await mailCandidate(updated, kind, `Status → ${status}`);
  }
  res.json({ success: true, status, emailed: !!mail?.ok, emailError: mail && !mail.ok ? mail.reason : null });
}));

// ── Delete ────────────────────────────────────────────
router.delete('/hrm/candidates/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  await db.query('DELETE FROM hrm_candidates WHERE id=?', [parseInt(req.params.id, 10)]);
  res.json({ success: true });
}));

// ── Sent mail ─────────────────────────────────────────
router.get('/hrm/messages', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const onlyFailed = req.query.failed === '1';
  const rows = await db.rows(
    `SELECT id, candidate_id, candidate_name, email, action, subject, status, error_detail,
            retry_count, DATE_FORMAT(created_at,'%Y-%m-%d %H:%i') AS created_at
       FROM hrm_message_log
      ${onlyFailed ? "WHERE status='Failed'" : ''}
      ORDER BY id DESC LIMIT 300`);
  res.json(rows);
}));

// Re-send a letter that failed. The candidate is read fresh rather than the
// logged copy replayed, so a retry after fixing a typo'd address goes to the
// corrected one.
router.post('/hrm/messages/:id/retry', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const log = await db.one('SELECT * FROM hrm_message_log WHERE id=?', [parseInt(req.params.id, 10)]);
  if (!log) throw httpError(404, 'Log entry not found');
  const c = await db.one('SELECT * FROM hrm_candidates WHERE id=?', [log.candidate_id]);
  if (!c) return res.status(400).json({ error: 'That candidate no longer exists' });

  const kind = /reschedul/i.test(log.action) ? 'rescheduled'
    : /select/i.test(log.action) ? 'selected'
    : /reject/i.test(log.action) ? 'rejected'
    : 'interview';
  const result = await hrmEmail.sendToCandidate(kind, c).catch(e => ({ ok: false, reason: e.message }));

  await db.query(
    `UPDATE hrm_message_log SET status=?, error_detail=?, retry_count=retry_count+1, last_retry_at=NOW()
      WHERE id=?`,
    [result.ok ? 'Sent' : 'Failed', result.ok ? null : clean(result.reason, 1000), log.id]);
  res.json({ ok: !!result.ok, reason: result.ok ? null : result.reason });
}));

router.delete('/hrm/messages/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  await db.query('DELETE FROM hrm_message_log WHERE id=?', [parseInt(req.params.id, 10)]);
  res.json({ success: true });
}));

module.exports = router;
