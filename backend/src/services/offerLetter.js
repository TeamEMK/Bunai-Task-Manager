// ══════════════════════════════════════════════════════
// OFFER LETTER
//
// The company's own template, set as a PDF. The wording is theirs, copied from
// Bunai Final Offer Letter.docx and left alone — this is a document somebody
// signs, so the only thing the app supplies is the blanks.
//
// Built with pdfkit rather than by filling the .docx, for two reasons: the
// production host has no Word and no LibreOffice to convert one, and a PDF is
// what should reach a candidate anyway — it looks the same everywhere and is
// not edited by accident on the way to being signed.
// ══════════════════════════════════════════════════════
const PDFDocument = require('pdfkit');

// The template's own list, in its own order. Kept as data because it is the
// part most likely to be edited, and editing a list should not mean editing
// layout code.
const DOCUMENTS = [
  'Six Passport Size Photographs with a white background.',
  'All Educational/Vocational degrees/certificates in original with a photocopy.',
  'Appointment letter with Annexure (salary break-up) of the current/previous entity.',
  'Resignation & Relieving Letter from previous employer.',
  'PAN Card.',
  'Aadhaar Card.',
  'Bank Details with Account Number (for salary payment process).',
  'Last 3 months Bank Statement (for salary verification).',
  'Last 3 months Salary Slips.',
  'Address Proof.',
];

// "2026-12-01" → "01/12/2026". The template writes its blanks as ___/___/____,
// so the filled letter should read the same way round.
function slashDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(String(value).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

const MARGIN = 62;          // a hair under an inch, so it prints inside any tray
const INK = '#000000';
const BODY_SIZE = 11.5;
const LINE_GAP = 4.5;

// Times New Roman is what the template uses. pdfkit ships the PostScript base
// fourteen, of which Times-Roman is the same letterform, so the page keeps its
// look without shipping a font file.
const FONT = 'Times-Roman';
const BOLD = 'Times-Bold';

function build(offer) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: {
      Title: `Offer Letter — ${offer.name || ''}`,
      Author: 'Bunai Private Limited',
      Subject: `Offer of employment${offer.position ? ` — ${offer.position}` : ''}`,
    },
  });

  const width = doc.page.width - MARGIN * 2;
  const para = (text, opts = {}) => {
    doc.font(opts.bold ? BOLD : FONT).fontSize(opts.size || BODY_SIZE).fillColor(INK)
      .text(text, { width, align: opts.align || 'justify', lineGap: LINE_GAP, ...opts });
    doc.moveDown(opts.after ?? 0.55);
  };
  // A label and its value on one line, the label bold as in the template.
  const field = (label, value) => {
    doc.font(BOLD).fontSize(BODY_SIZE).fillColor(INK)
      .text(label, { continued: true, lineGap: LINE_GAP })
      .font(FONT).text(' ' + (value || ''));
  };

  // ── the date, top right ──
  doc.font(BOLD).fontSize(BODY_SIZE)
    .text(slashDate(offer.offerDate), { width, align: 'right', lineGap: LINE_GAP });
  doc.moveDown(1);

  // ── who it is addressed to ──
  field('Employee Name:', offer.name);
  field('Address 1:', offer.address1);
  field('Address 2:', offer.address2);
  field('Contact No.:', offer.phone);
  field('Email ID:', offer.email);
  doc.moveDown(1.1);

  doc.font(BOLD).fontSize(13).text('OFFER LETTER', { width, align: 'center', underline: true });
  doc.moveDown(1.1);

  para(`Dear ${offer.name || ''},`, { align: 'left', after: 0.7 });

  // The one sentence that changes shape: without a department or a location
  // there is nothing to put between "position of" and "Office", and leaving
  // the template's underscores in a signed letter would look unfinished.
  const where = [
    offer.department ? ` in ${offer.department}` : '',
    offer.location ? ` in ${offer.location} Office` : '',
  ].join('');
  para(
    `With reference to your application and subsequent interview you had with us, we are pleased `
    + `to offer you a position of ${offer.position || ''}${where} of the Bunai Private Limited, `
    + `(hereinafter referred to as the “Entity”) on the terms and conditions as mutually `
    + `discussed and agreed with you.`);

  para(
    `Your employment with the Entity is scheduled to commence on ${slashDate(offer.joiningDate)} `
    + `(the “Joining Date”), subject to your acceptance of this Offer letter and completion of `
    + `joining formalities.`);

  para(
    `The Entity may also, at its discretion, carry out background verification and has the right `
    + `to withdraw the Offer if the results of such verification are not satisfactory.`);

  para(
    `An Appointment Letter detailing the comprehensive terms and conditions of your Employment `
    + `shall be issued to you upon your joining the aforesaid position and after a satisfactory `
    + `background verification check.`);

  para(
    `Further, this Offer is valid only till ${slashDate(offer.validTill)}. You are required to `
    + `communicate your acceptance of the Offer on or before this date.`);

  para('You are required to bring the following documents at the time of joining:', { after: 0.4 });

  doc.font(FONT).fontSize(BODY_SIZE).fillColor(INK);
  // Numbered rather than bulleted: these get checked off one by one at a desk,
  // and "you are missing number 4" is a thing somebody can say on the phone.
  doc.list(DOCUMENTS, {
    width: width - 16, listType: 'numbered', textIndent: 16, bulletIndent: 8, lineGap: LINE_GAP,
  });
  doc.moveDown(0.6);

  para('The originals of the above documents shall be returned after verification.');
  doc.moveDown(0.4);

  para('Wishing you a successful career in our organization!', { after: 1 });

  // ── who it comes from ──
  para('Sincerely,', { align: 'left', after: 0.15 });
  para('For Bunai Private Limited', { align: 'left', bold: true, after: 1.6 });

  para('Authorized Signatory', { align: 'left', bold: true, after: 0.35 });
  field('Name:', offer.signatoryName);
  field('Designation:', offer.signatoryDesignation);
  field('E-mail:', offer.signatoryEmail);
  field('Phone:', offer.signatoryPhone);
  doc.moveDown(1.4);

  // ── and the half the candidate signs ──
  // Kept on the same page as the offer where it fits; a signature block that
  // floats alone on page two is the classic way a returned copy loses its
  // first page.
  if (doc.y > doc.page.height - MARGIN - 150) doc.addPage();

  para('Acknowledgement and Acceptance:', { align: 'left', bold: true, after: 0.35 });
  para(
    `I, the undersigned, have read and understood this Offer Letter and accept the Offer. I will `
    + `join by ${slashDate(offer.joiningDate)} failing which the Offer shall stand withdrawn.`,
    { after: 2.2 });

  const third = width / 3;
  const ruleY = doc.y;
  doc.font(FONT).fontSize(BODY_SIZE).fillColor(INK);
  ['Name', 'Signature', 'Date'].forEach((label, i) => {
    const x = MARGIN + third * i;
    doc.moveTo(x, ruleY).lineTo(x + third - 22, ruleY).lineWidth(0.7).strokeColor(INK).stroke();
    doc.text(label, x, ruleY + 6, { width: third - 22, align: 'left' });
  });

  return doc;
}

// The whole PDF in memory. These are two pages at most, and the caller either
// emails it or streams it straight back — neither wants a file on disk, least
// of all on a host that does not keep one.
function render(offer) {
  return new Promise((resolve, reject) => {
    try {
      const doc = build(offer);
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// "Offer Letter - Naman Gupta.pdf", and nothing in it that a filesystem will
// argue with.
function fileName(offer) {
  const who = String(offer.name || 'Candidate').replace(/[^\w \-.]/g, '').trim() || 'Candidate';
  return `Offer Letter - ${who}.pdf`;
}

module.exports = { render, fileName, slashDate, DOCUMENTS };
