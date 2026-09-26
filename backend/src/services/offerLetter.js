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
//
// The shape follows the letter the sister company sends: a letterhead the page
// is written under, the facts that matter set in bold so they can be checked
// at a glance, and a page count at the foot so a two-page letter is visibly
// two pages and nobody signs a stray first sheet.
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
  'Any other bank account.',
];

const COMPANY = 'Bunai Private Limited';

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
const FOOT = 40;            // room under the text for the page count
const INK = '#000000';
const QUIET = '#444444';
const RULE = '#999999';
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
    // Held open so the page count can be written once the page count is known.
    bufferPages: true,
    margins: { top: MARGIN, bottom: MARGIN + FOOT, left: MARGIN, right: MARGIN },
    info: {
      Title: `Offer Letter — ${offer.name || ''}`,
      Author: offer.company || COMPANY,
      Subject: `Offer of employment${offer.position ? ` — ${offer.position}` : ''}`,
    },
  });

  const width = doc.page.width - MARGIN * 2;

  const para = (text, opts = {}) => {
    doc.font(opts.bold ? BOLD : FONT).fontSize(opts.size || BODY_SIZE).fillColor(INK)
      .text(text, { width, align: opts.align || 'justify', lineGap: LINE_GAP, ...opts });
    doc.moveDown(opts.after ?? 0.55);
  };

  // A sentence made of alternating plain and bold runs. Everything a reader
  // checks first — the role, the dates — is the bold half, and the runs are
  // written continued so the line still justifies as one paragraph.
  //
  // The space AFTER a bold word has to live inside the bold run. While
  // justifying, pdfkit trims a plain run's leading space at a continued
  // boundary — which is how the letter this one follows ended up reading
  // "JaipurOffice" — and a space carried inside the bold run survives it. A
  // space looks the same in either weight, so nothing is lost by moving it.
  const rich = (runs, opts = {}) => {
    doc.fontSize(BODY_SIZE).fillColor(INK);
    const parts = runs.filter(r => r && r.t !== '');
    parts.forEach((run, i) => {
      doc.font(run.b ? BOLD : FONT)
        .text(run.t, {
          width, align: opts.align || 'justify', lineGap: LINE_GAP,
          continued: i < parts.length - 1,
        });
    });
    doc.moveDown(opts.after ?? 0.55);
  };

  // A label and its value on one line. The candidate's own details are set in
  // bold and the signatory's plain, the way the letter this one follows does
  // it: the reader is checking their name, not ours.
  const field = (label, value, plain) => {
    if (value === undefined || value === null || String(value).trim() === '') return;
    doc.fontSize(BODY_SIZE).fillColor(INK)
      .font(FONT).text(label + ' ', { continued: true, lineGap: LINE_GAP })
      .font(plain ? FONT : BOLD).text(String(value));
  };

  // ── the letterhead ──
  doc.font(BOLD).fontSize(16).fillColor(INK)
    .text(offer.company || COMPANY, { width, align: 'left' });
  [offer.companyAddress1, offer.companyAddress2].filter(Boolean).forEach((line) => {
    doc.font(FONT).fontSize(9).fillColor(QUIET).text(line, { width, align: 'left', lineGap: 1 });
  });
  doc.moveDown(0.6);
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).lineWidth(0.8).strokeColor(RULE).stroke();
  doc.moveDown(1);

  // ── the date, then who it is addressed to ──
  doc.font(FONT).fontSize(BODY_SIZE).fillColor(INK)
    .text(slashDate(offer.offerDate), { width, align: 'left', lineGap: LINE_GAP });
  doc.moveDown(0.9);

  field('Employee Name:', offer.name);
  field('Address 1:', offer.address1);
  field('Address 2:', offer.address2);
  field('Contact No.:', offer.phone);
  field('Email ID:', offer.email);
  doc.moveDown(1.2);

  doc.font(BOLD).fontSize(13).fillColor(INK)
    .text('OFFER LETTER', { width, align: 'center', underline: true });
  doc.moveDown(1.2);

  rich([{ t: 'Dear ' }, { t: offer.name || '', b: true }, { t: ',' }], { align: 'left', after: 0.7 });

  // The one sentence that changes shape: without a department or a location
  // there is nothing to put between "position of" and "Office", and leaving
  // the template's underscores in a signed letter would look unfinished.
  rich([
    { t: 'With reference to your application and subsequent interview you had with us, we are '
       + 'pleased to offer you a position of ' },
    { t: (offer.position || '') + ' ', b: true },
    offer.department ? { t: 'in ' } : null,
    offer.department ? { t: offer.department + ' ', b: true } : null,
    offer.location ? { t: 'in ' } : null,
    offer.location ? { t: offer.location + ' ', b: true } : null,
    offer.location ? { t: 'Office ' } : null,
    { t: `of the ${offer.company || COMPANY}, (hereinafter referred to as the “Entity”) on the `
       + 'terms and conditions as mutually discussed and agreed with you.' },
  ].filter(Boolean));

  rich([
    { t: 'Your employment with the Entity is scheduled to commence on ' },
    { t: slashDate(offer.joiningDate) + ' ', b: true },
    { t: '(the “Joining Date”), subject to your acceptance of this Offer letter and completion '
       + 'of joining formalities.' },
  ]);

  para(
    `The Entity may also, at its discretion, carry out background verification and has the right `
    + `to withdraw the Offer if the results of such verification are not satisfactory.`);

  para(
    `An Appointment Letter detailing the comprehensive terms and conditions of your Employment `
    + `shall be issued to you upon your joining the aforesaid position and after a satisfactory `
    + `background verification check.`);

  rich([
    { t: 'Further, this Offer is valid only till ' },
    { t: slashDate(offer.validTill), b: true },
    { t: '. You are required to communicate your acceptance of the Offer on or before this date.' },
  ]);

  // The list is checked off as one thing, so it should not be torn in half by
  // a page break. If the rest of this page cannot hold it, it starts the next.
  const listHeight = DOCUMENTS.length * (BODY_SIZE + LINE_GAP + 3) + 40;
  if (doc.y + listHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();

  para('You are required to bring the following documents at the time of joining:', { after: 0.4 });

  doc.font(FONT).fontSize(BODY_SIZE).fillColor(INK);
  // Numbered rather than bulleted: these get checked off one by one at a desk,
  // and "you are missing number 4" is a thing somebody can say on the phone.
  doc.list(DOCUMENTS, {
    width: width - 16, listType: 'numbered', textIndent: 16, bulletIndent: 8, lineGap: LINE_GAP,
  });
  doc.moveDown(0.6);

  para('The originals of the above documents shall be returned after verification.');
  doc.moveDown(0.3);
  para('Wishing you a successful career in our organization!', { after: 1 });

  // ── who it comes from ──
  para('Sincerely,', { align: 'left', after: 0.15 });
  para(`For ${offer.company || COMPANY}`, { align: 'left', bold: true, after: 1.6 });

  para('Authorized Signatory', { align: 'left', after: 0.25 });
  field('Name:', offer.signatoryName, true);
  field('Designation:', offer.signatoryDesignation, true);
  field('E-mail:', offer.signatoryEmail, true);
  field('Phone:', offer.signatoryPhone, true);
  doc.moveDown(1.5);

  // ── and the half the candidate signs ──
  // Kept whole: a signature block split across a page break is how a returned
  // copy ends up missing the page that says what was agreed.
  if (doc.y > doc.page.height - MARGIN - FOOT - 165) doc.addPage();

  para('Acknowledgement and Acceptance:', { align: 'left', bold: true, after: 0.35 });
  rich([
    { t: 'I, the undersigned, have read and understood this Offer Letter and accept the Offer. '
       + 'I will join by ' },
    { t: slashDate(offer.joiningDate) + ' ', b: true },
    { t: 'failing which the Offer shall stand withdrawn.' },
  ], { after: 2.4 });

  const third = width / 3;
  const ruleY = doc.y;
  doc.font(FONT).fontSize(BODY_SIZE).fillColor(INK);
  ['Name', 'Signature', 'Date'].forEach((label, i) => {
    const x = MARGIN + third * i;
    doc.moveTo(x, ruleY).lineTo(x + third - 26, ruleY).lineWidth(0.8).strokeColor(INK).stroke();
    doc.text(label, x, ruleY + 6, { width: third - 26, align: 'left', lineBreak: false });
  });
  doc.moveDown(1.4);
  doc.font(FONT).fontSize(BODY_SIZE).fillColor(INK)
    .text('************', MARGIN, doc.y, { width, align: 'center', lineBreak: false });

  // ── the page count, once the pages are all there ──
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // The footer sits in the bottom margin, and writing into the margin is
    // what pdfkit treats as running out of room - it would add a blank page
    // per page. Dropping the margin for the one line stops that.
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(FONT).fontSize(8.5).fillColor(QUIET)
      .text(`Page ${i + 1} of ${range.count}`,
        MARGIN, doc.page.height - MARGIN - 4,
        { width, align: 'center', lineBreak: false });
    doc.page.margins.bottom = keep;
  }
  doc.flushPages();

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

module.exports = { render, fileName, slashDate, DOCUMENTS, COMPANY };
