// ══════════════════════════════════════════════════════
// ONBOARDING FORM (/api/joining/*, and the admin half under /api/hrm/*)
//
// Once a candidate is selected they are emailed a link to a form asking for
// the details the office needs before their first day: how to reach them, who
// to call if something happens, where they live, and their documents.
//
// The person filling it in has no account here, so the link is the credential:
// a long random token, one per candidate, that opens their form and nothing
// else. It is checked on every request — reading the form, and submitting it.
//
// The uploads land outside frontend/ and are streamed back only to a logged-in
// admin. Somebody's Aadhaar must not sit at a guessable public URL.
// ══════════════════════════════════════════════════════
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const hrmEmail = require('../services/hrmEmail');

const router = express.Router();

// Held in memory and written out only once the whole submission has passed
// validation, so a rejected form leaves no half-uploaded documents behind.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 5 } });

const FILE_FIELDS = ['resume_file', 'aadhaar_file', 'aadhaar_file_2', 'pan_file', 'pan_file_2'];

// A CV is a document; an ID card is usually a photo of one. Anything else is
// refused rather than stored — this folder is read back by people, not by a
// sandbox.
const ALLOWED = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/webp': '.webp',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

const clean = (v, max = 255) => String(v ?? '').trim().slice(0, max);
const digits = (v, max = 20) => String(v ?? '').replace(/\D/g, '').slice(0, max);
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);

// The link a candidate is sent. Built from APP_URL so the address works from
// wherever they open their mail, not just from inside the office.
function formUrl(token) {
  const base = (config.email.appUrl || '').replace(/\/+$/, '');
  return `${base}/join.html?t=${token}`;
}

// One token per candidate, made the first time it is needed and kept, so a
// form that is emailed twice is the same form and not two of them.
async function ensureToken(candidate) {
  if (candidate.joining_form_token) return candidate.joining_form_token;
  const token = crypto.randomBytes(24).toString('hex');
  await db.query('UPDATE hrm_candidates SET joining_form_token=? WHERE id=?', [token, candidate.id]);
  candidate.joining_form_token = token;
  return token;
}

// Sends the letter and records it beside the interview letters, so one screen
// answers "what has this candidate been sent".
async function mailForm(candidate) {
  const token = await ensureToken(candidate);
  const result = await hrmEmail.sendOnboardingForm(candidate, formUrl(token))
    .catch(e => ({ ok: false, reason: e.message }));
  await db.query(
    `INSERT INTO hrm_message_log (candidate_id, candidate_name, email, action, subject, status, error_detail)
     VALUES (?,?,?,?,?,?,?)`,
    [candidate.id, clean(candidate.name), clean(candidate.email), 'Onboarding form',
     clean(result?.subject, 500), result?.ok ? 'Sent' : 'Failed',
     result?.ok ? null : clean(result?.reason, 1000)]).catch(() => {});
  if (result?.ok) await db.query('UPDATE hrm_candidates SET joining_form_sent_at=NOW() WHERE id=?', [candidate.id]);
  return result;
}

// ══════════════════════════════════════════════════════
// THE PUBLIC HALF — no login, the token is the key
// ══════════════════════════════════════════════════════

async function byToken(token) {
  const t = String(token || '').trim();
  if (!/^[a-f0-9]{16,64}$/i.test(t)) return null;
  return db.one('SELECT * FROM hrm_candidates WHERE joining_form_token=? LIMIT 1', [t]);
}

// What the form needs to greet somebody by name and pre-fill what is already
// known. Nothing sensitive: their own name, role and contact details.
router.get('/joining/:token', asyncRoute(async (req, res) => {
  const c = await byToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'This link is not valid. Ask us to send the form again.' });
  const done = await db.one('SELECT submitted_at FROM hrm_joining_details WHERE candidate_id=?', [c.id]);
  res.json({
    name: c.name,
    position: c.profile_position || '',
    email: c.email || '',
    phone: c.phone || '',
    joining_date: c.joining_date || null,
    submitted: !!done,
  });
}));

router.post('/joining/:token',
  upload.fields(FILE_FIELDS.map(name => ({ name, maxCount: 1 }))),
  asyncRoute(async (req, res) => {
    const c = await byToken(req.params.token);
    if (!c) return res.status(404).json({ error: 'This link is not valid. Ask us to send the form again.' });

    const b = req.body || {};
    const files = req.files || {};
    const existing = await db.one('SELECT * FROM hrm_joining_details WHERE candidate_id=?', [c.id]);

    const d = {
      full_name: clean(b.full_name),
      emp_mobile: digits(b.emp_mobile),
      email: clean(b.email).toLowerCase(),
      dob: dateOrNull(b.dob),
      guardian1_name: clean(b.guardian1_name),
      guardian1_relation: clean(b.guardian1_relation, 100),
      guardian1_mobile: digits(b.guardian1_mobile),
      guardian2_name: clean(b.guardian2_name),
      guardian2_relation: clean(b.guardian2_relation, 100),
      guardian2_mobile: digits(b.guardian2_mobile),
      street: clean(b.street, 500),
      city: clean(b.city),
      state: clean(b.state),
      pincode: digits(b.pincode, 10),
      aadhaar_no: digits(b.aadhaar_no, 12),
      pan_no: clean(b.pan_no, 20).toUpperCase().replace(/\s/g, ''),
    };

    // Checked here as well as in the page. This is the record an employee file
    // is built from, and a submission bounced back while they are still on the
    // form is far cheaper than a wrong record discovered on their first day.
    const missing = [];
    if (!d.full_name) missing.push('Name');
    if (!looksLikeEmail(d.email)) missing.push('Email');
    if (d.emp_mobile.length !== 10) missing.push('Mobile number (10 digits)');
    if (!d.dob) missing.push('Date of birth');
    if (!d.guardian1_name) missing.push('First contact name');
    if (!d.guardian1_relation) missing.push('First contact relation');
    if (d.guardian1_mobile.length !== 10) missing.push('First contact mobile (10 digits)');
    if (!d.guardian2_name) missing.push('Second contact name');
    if (!d.guardian2_relation) missing.push('Second contact relation');
    if (d.guardian2_mobile.length !== 10) missing.push('Second contact mobile (10 digits)');
    if (!d.street) missing.push('Address');
    if (!d.city) missing.push('City');
    if (d.pincode.length !== 6) missing.push('Pincode (6 digits)');
    if (!files.aadhaar_file && !existing?.aadhaar_file) missing.push('Aadhaar (front side)');
    if (!files.resume_file && !existing?.resume_file) missing.push('CV');
    if (missing.length) return res.status(400).json({ error: 'Still needed: ' + missing.join(', ') });

    // Three different people, three different numbers — the whole point of an
    // emergency contact is that it rings somewhere else.
    const mobiles = [d.emp_mobile, d.guardian1_mobile, d.guardian2_mobile];
    if (new Set(mobiles).size !== mobiles.length) {
      return res.status(400).json({ error: 'Your number and both contact numbers must be different' });
    }
    if (d.aadhaar_no && d.aadhaar_no.length !== 12) return res.status(400).json({ error: 'An Aadhaar number is 12 digits' });
    if (d.pan_no && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(d.pan_no)) {
      return res.status(400).json({ error: 'That PAN does not look right — it reads like ABCDE1234F' });
    }

    for (const field of FILE_FIELDS) {
      const f = files[field]?.[0];
      if (f && !ALLOWED[f.mimetype]) {
        return res.status(400).json({ error: `${f.originalname}: only PDF, Word or a photo (JPG, PNG, HEIC)` });
      }
    }

    // Everything has passed, so the documents can go to disk. Named after the
    // field rather than whatever the phone called it, and the old one is
    // replaced when a form is filled in a second time.
    const dir = path.join(config.uploadsDir, 'joining', String(c.id));
    fs.mkdirSync(dir, { recursive: true });
    const saved = {};
    for (const field of FILE_FIELDS) {
      const f = files[field]?.[0];
      if (!f) { saved[field] = existing?.[field] || ''; continue; }
      const name = `${field}-${crypto.randomBytes(4).toString('hex')}${ALLOWED[f.mimetype]}`;
      fs.writeFileSync(path.join(dir, name), f.buffer);
      if (existing?.[field] && existing[field] !== name) {
        fs.unlink(path.join(dir, existing[field]), () => {});
      }
      saved[field] = name;
    }

    // One row per candidate: filling the form a second time replaces the first
    // answer rather than adding a second record nobody knows which to believe.
    const cols = ['candidate_id', ...Object.keys(d), ...FILE_FIELDS];
    const values = [c.id, ...Object.values(d), ...FILE_FIELDS.map(f => saved[f])];
    const overwrite = cols.filter(k => k !== 'candidate_id').map(k => `${k}=VALUES(${k})`);
    await db.query(
      `INSERT INTO hrm_joining_details (${cols.join(',')})
       VALUES (${cols.map(() => '?').join(',')})
       ON DUPLICATE KEY UPDATE ${overwrite.join(', ')}, submitted_at=NOW()`,
      values);

    res.json({ ok: true, name: c.name });
  }));

// ══════════════════════════════════════════════════════
// THE ADMIN HALF — behind the usual login
// ══════════════════════════════════════════════════════

// Send it, or send it again. Kept separate from the status change so a form
// can be re-sent to somebody who lost the email without touching their status.
router.post('/hrm/candidates/:id/joining-form', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const c = await db.one('SELECT * FROM hrm_candidates WHERE id=?', [parseInt(req.params.id, 10)]);
  if (!c) throw httpError(404, 'Candidate not found');
  if (!looksLikeEmail(c.email)) return res.status(400).json({ error: 'That candidate has no valid email address' });
  const r = await mailForm(c);
  res.json({ ok: !!r?.ok, reason: r?.ok ? null : r?.reason });
}));

router.get('/hrm/candidates/:id/joining-details', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = await db.one(
    `SELECT id, name, email, joining_form_token,
            DATE_FORMAT(joining_form_sent_at,'%Y-%m-%d %H:%i') AS joining_form_sent_at
       FROM hrm_candidates WHERE id=?`, [id]);
  if (!c) throw httpError(404, 'Candidate not found');
  // The dates are formatted in SQL rather than handed over as Date objects:
  // JSON turns those into UTC, and a birthday at midnight IST comes out as the
  // day before. The same reason the candidate list does it.
  const row = await db.one(
    `SELECT *, DATE_FORMAT(dob,'%Y-%m-%d') AS dob,
            DATE_FORMAT(submitted_at,'%Y-%m-%d %H:%i') AS submitted_at
       FROM hrm_joining_details WHERE candidate_id=?`, [id]);
  res.json({
    candidate: { id: c.id, name: c.name, email: c.email },
    sent_at: c.joining_form_sent_at,
    link: c.joining_form_token ? formUrl(c.joining_form_token) : null,
    details: row || null,
    // Which documents actually exist, so the page shows five buttons or two.
    files: row ? FILE_FIELDS.filter(f => row[f]) : [],
  });
}));

// The documents themselves. Streamed rather than served statically, because
// that is the only way the login still applies to them.
router.get('/hrm/joining-file/:id/:field', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const field = String(req.params.field);
  if (!FILE_FIELDS.includes(field)) throw httpError(400, 'Unknown document');
  const row = await db.one('SELECT * FROM hrm_joining_details WHERE candidate_id=?', [id]);
  const name = row?.[field];
  if (!name) throw httpError(404, 'Not uploaded');
  // The name came out of our own INSERT, but it ends up in a filesystem path,
  // so it is checked rather than trusted.
  if (!/^[a-z0-9_]+-[a-f0-9]{8}\.[a-z]{3,4}$/i.test(name)) throw httpError(400, 'Bad file name');
  const file = path.join(config.uploadsDir, 'joining', String(id), name);
  if (!fs.existsSync(file)) throw httpError(404, 'The file is recorded but missing from disk');
  res.sendFile(file);
}));

module.exports = { router, mailForm, formUrl, ensureToken };
