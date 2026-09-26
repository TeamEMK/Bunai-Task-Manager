// ══════════════════════════════════════════════════════
// OFFER LETTER (/api/hrm/candidates/:id/offer*)
//
// The last step of the pipeline: a selected candidate is sent the company's
// offer letter as a PDF, and their status moves to Offer Sent.
//
// The letter is built from what is on this screen, not from a stored document,
// so a re-send after a corrected date produces a corrected letter. What IS
// stored is the answers - department, location, the dates, who signed - both
// so a re-send reproduces the same letter and so the next candidate's form
// opens already filled in.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const hrmEmail = require('../services/hrmEmail');
const offerLetter = require('../services/offerLetter');
const COMPANY = offerLetter.COMPANY;

const router = express.Router();

const clean = (v, max = 255) => String(v ?? '').trim().slice(0, max);
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const today = () => new Date().toISOString().slice(0, 10);

// Dates as SQL formats them, or JSON turns a DATE into the day before in UTC.
const OFFER_SELECT = `
  SELECT o.*,
         DATE_FORMAT(o.offer_date,'%Y-%m-%d')   AS offer_date,
         DATE_FORMAT(o.joining_date,'%Y-%m-%d') AS joining_date,
         DATE_FORMAT(o.valid_till,'%Y-%m-%d')   AS valid_till,
         DATE_FORMAT(o.sent_at,'%Y-%m-%d %H:%i') AS sent_at
    FROM hrm_offers o`;

// What the form should open with. Three sources, in order of how specific they
// are to this candidate: an offer already drafted for them, then their own
// record and the details they sent on joining, then whatever was on the last
// offer anybody sent - which is where the signatory comes from, so it is typed
// once and never again.
async function prefill(id) {
  const c = await db.one(
    `SELECT id, name, email, phone, profile_position, status,
            DATE_FORMAT(joining_date,'%Y-%m-%d') AS joining_date
       FROM hrm_candidates WHERE id=?`, [id]);
  if (!c) return null;

  const mine = await db.one(`${OFFER_SELECT} WHERE o.candidate_id=?`, [id]);
  const last = await db.one(`${OFFER_SELECT} WHERE o.sent_at IS NOT NULL ORDER BY o.sent_at DESC LIMIT 1`);
  const joining = await db.one('SELECT * FROM hrm_joining_details WHERE candidate_id=?', [id]);

  // The address on the letter is the one they gave on the joining form. Split
  // the way the template asks for it: the street on one line, the town on the
  // next.
  const address1 = mine?.address1 || clean(joining?.street, 500);
  const address2 = mine?.address2
    || [joining?.city, joining?.state, joining?.pincode].filter(Boolean).join(', ');

  return {
    candidate: {
      id: c.id, name: c.name, email: c.email, phone: c.phone,
      position: c.profile_position, status: c.status,
    },
    offer: {
      department: mine?.department || last?.department || '',
      location: mine?.location || last?.location || '',
      offerDate: mine?.offer_date || today(),
      joiningDate: mine?.joining_date || c.joining_date || '',
      validTill: mine?.valid_till || '',
      address1, address2,
      signatoryName: mine?.signatory_name || last?.signatory_name || '',
      signatoryDesignation: mine?.signatory_designation || last?.signatory_designation || '',
      signatoryEmail: mine?.signatory_email || last?.signatory_email || '',
      signatoryPhone: mine?.signatory_phone || last?.signatory_phone || '',
      cc: mine?.cc_emails || '',
      // Carried over like the signatory: one office, typed once.
      company: mine?.company_name || last?.company_name || COMPANY,
      companyAddress1: mine?.company_address1 || last?.company_address1 || '',
      companyAddress2: mine?.company_address2 || last?.company_address2 || '',
    },
    sentAt: mine?.sent_at || null,
    // Whether the signatory came from this candidate's own draft or was
    // inherited, so the screen can say where it got it.
    signatoryFrom: mine?.signatory_name ? 'this offer' : (last?.signatory_name ? 'the last offer sent' : null),
  };
}

// The fields the letter is built from, cleaned the same way whether they are
// about to be previewed or sent.
function fromBody(b, candidate) {
  return {
    name: candidate.name,
    email: candidate.email,
    phone: candidate.phone,
    position: clean(b.position) || candidate.profile_position || '',
    department: clean(b.department),
    location: clean(b.location),
    address1: clean(b.address1, 500),
    address2: clean(b.address2, 500),
    offerDate: dateOrNull(b.offerDate) || today(),
    joiningDate: dateOrNull(b.joiningDate),
    validTill: dateOrNull(b.validTill),
    signatoryName: clean(b.signatoryName),
    signatoryDesignation: clean(b.signatoryDesignation),
    signatoryEmail: clean(b.signatoryEmail),
    signatoryPhone: clean(b.signatoryPhone, 50),
    // Split on commas or spaces, since people type both, and only what looks
    // like an address survives - a typo should not silently become a recipient.
    company: clean(b.company) || COMPANY,
    companyAddress1: clean(b.companyAddress1, 500),
    companyAddress2: clean(b.companyAddress2, 500),
    cc: String(b.cc || '').split(/[,;\s]+/).map(x => x.trim()).filter(looksLikeEmail).slice(0, 10),
  };
}

// A letter missing its dates is not a letter, and the one place to catch that
// is before it is a PDF in somebody's inbox.
function whatIsMissing(offer) {
  const missing = [];
  if (!offer.joiningDate) missing.push('joining date');
  if (!offer.validTill) missing.push('offer valid till');
  if (!offer.signatoryName) missing.push("the signatory's name");
  return missing;
}

async function remember(id, offer, userId, sent) {
  const cols = {
    department: offer.department, location: offer.location,
    offer_date: offer.offerDate, joining_date: offer.joiningDate, valid_till: offer.validTill,
    address1: offer.address1, address2: offer.address2,
    signatory_name: offer.signatoryName, signatory_designation: offer.signatoryDesignation,
    signatory_email: offer.signatoryEmail, signatory_phone: offer.signatoryPhone,
    cc_emails: (offer.cc || []).join(', '),
    company_name: offer.company, company_address1: offer.companyAddress1,
    company_address2: offer.companyAddress2,
  };
  const keys = Object.keys(cols);
  const set = keys.map(k => `${k}=VALUES(${k})`).join(', ');
  await db.query(
    `INSERT INTO hrm_offers (candidate_id, ${keys.join(',')}${sent ? ', sent_at, sent_by' : ''})
     VALUES (?, ${keys.map(() => '?').join(',')}${sent ? ', NOW(), ?' : ''})
     ON DUPLICATE KEY UPDATE ${set}${sent ? ', sent_at=NOW(), sent_by=VALUES(sent_by)' : ''}`,
    [id, ...Object.values(cols), ...(sent ? [userId] : [])]);
}

// ── What the dialog opens with ────────────────────────
router.get('/hrm/candidates/:id/offer', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const data = await prefill(parseInt(req.params.id, 10));
  if (!data) throw httpError(404, 'Candidate not found');
  res.json(data);
}));

// ── The letter itself, to read before sending it ──────
// A PDF in the browser rather than a description of one: the only way to be
// sure of a document is to look at it.
router.post('/hrm/candidates/:id/offer/preview', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const c = await db.one('SELECT * FROM hrm_candidates WHERE id=?', [parseInt(req.params.id, 10)]);
  if (!c) throw httpError(404, 'Candidate not found');
  const offer = fromBody(req.body || {}, c);
  const pdf = await offerLetter.render(offer);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${offerLetter.fileName(offer).replace(/[^\w. -]/g, '_')}"`);
  res.send(pdf);
}));

// ── Send it ───────────────────────────────────────────
router.post('/hrm/candidates/:id/offer/send', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = await db.one('SELECT * FROM hrm_candidates WHERE id=?', [id]);
  if (!c) throw httpError(404, 'Candidate not found');
  if (!looksLikeEmail(c.email)) return res.status(400).json({ error: 'That candidate has no valid email address' });

  const offer = fromBody(req.body || {}, c);
  const missing = whatIsMissing(offer);
  if (missing.length) return res.status(400).json({ error: 'The letter still needs ' + missing.join(', ') });

  const pdf = await offerLetter.render(offer);
  const fileName = offerLetter.fileName(offer);

  // Saved before it is sent, so a letter that goes out is always the letter on
  // record - even if the send itself then fails.
  await remember(id, offer, req.session.userId, true);
  await db.query("UPDATE hrm_candidates SET status='Offer Sent' WHERE id=?", [id]);

  const result = await hrmEmail.sendOfferLetter(c, offer, pdf, fileName, offer.cc)
    .catch(e => ({ ok: false, reason: e.message }));

  await db.query(
    `INSERT INTO hrm_message_log (candidate_id, candidate_name, email, action, subject, status, error_detail)
     VALUES (?,?,?,?,?,?,?)`,
    [id, clean(c.name), clean(c.email), 'Offer letter', clean(result?.subject, 500),
     result?.ok ? 'Sent' : 'Failed', result?.ok ? null : clean(result?.reason, 1000)]).catch(() => {});

  res.json({
    ok: !!result?.ok,
    reason: result?.ok ? null : result?.reason,
    // The status moved either way; the letter is what may not have arrived.
    status: 'Offer Sent',
    fileName,
    cc: offer.cc,
  });
}));

// ── Save the draft without sending ────────────────────
// Somebody fills half of it, loses the person who knows the joining date, and
// comes back tomorrow.
router.post('/hrm/candidates/:id/offer', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = await db.one('SELECT * FROM hrm_candidates WHERE id=?', [id]);
  if (!c) throw httpError(404, 'Candidate not found');
  await remember(id, fromBody(req.body || {}, c), req.session.userId, false);
  res.json({ success: true });
}));

module.exports = router;
