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
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const config = require('../config');

// ── The company's letterhead ──────────────────────────
// Three images out of the Word letterhead the client sent: the banner across
// the top, the band across the bottom, and the pale yarn-ball mark the page is
// written over. They live in frontend/ beside the email logo, because that is
// the folder the production build is told to carry.
//
// Read once and kept. If any of them is missing the letter still goes out —
// with the name and address set as type instead, which is what it looked like
// before the client sent this.
const ART = {
  top: 'letterhead-top.png',
  bottom: 'letterhead-bottom.png',
  mark: 'letterhead-watermark.png',
};
let _art;
function letterhead() {
  if (_art === undefined) {
    _art = {};
    for (const [key, file] of Object.entries(ART)) {
      try {
        _art[key] = fs.readFileSync(path.join(config.publicDir, file));
      } catch (err) {
        console.warn('⚠️ Offer letter: ' + file + ' is missing — falling back to a typed letterhead');
        _art = null;
        break;
      }
    }
  }
  return _art;
}

// What each band takes up once it is drawn the full width of an A4 page, and
// where inside it the printing stops — measured off the images themselves
// rather than guessed, because the text has to clear both and a letter whose
// date sits on the letterhead rule looks like a mistake.
//
//   top:    ink runs from the very top down to 65.7% of the band
//   bottom: ink starts at 70% of the band and runs to the foot
const ART_RATIO = { top: 836 / 2476, bottom: 726 / 2476 };
const ART_INK = { top: 0.657, bottom: 0.70 };

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
  const art = letterhead();

  // A4 is 595pt across. The bands are drawn edge to edge, so their height
  // follows from that, and the text starts under the banner's rule and stops
  // above the footer's address rather than at an arbitrary inch.
  const PAGE_W = 595.28;
  const artTop = art ? PAGE_W * ART_RATIO.top : 0;
  const artBottom = art ? PAGE_W * ART_RATIO.bottom : 0;
  const topMargin = art ? Math.round(artTop * ART_INK.top) + 26 : MARGIN;
  const bottomMargin = art ? Math.round(artBottom * (1 - ART_INK.bottom)) + 30 : MARGIN + FOOT;

  const doc = new PDFDocument({
    size: 'A4',
    // Held open so the page count can be written once the page count is known.
    bufferPages: true,
    margins: { top: topMargin, bottom: bottomMargin, left: MARGIN, right: MARGIN },
    info: {
      Title: `Offer Letter — ${offer.name || ''}`,
      Author: offer.company || COMPANY,
      Subject: `Offer of employment${offer.position ? ` — ${offer.position}` : ''}`,
    },
  });

  const width = doc.page.width - MARGIN * 2;

  // Drawn before anything else on every page, so the letter is written on top
  // of the mark rather than the other way round. Explicit coordinates, which
  // leave the text cursor where it was.
  const dressPage = () => {
    if (!art) return;
    const { width: pw, height: ph } = doc.page;
    // The watermark, at the size and centring the Word file gives it.
    doc.image(art.mark, (pw - 365.15) / 2, (ph - 338.4) / 2, { width: 365.15, height: 338.4 });
    doc.image(art.top, 0, 0, { width: pw });
    doc.image(art.bottom, 0, ph - pw * ART_RATIO.bottom, { width: pw });
  };
  doc.on('pageAdded', dressPage);
  dressPage();

  // ── Setting a paragraph ───────────────────────────────
  // Laid out a word at a time rather than handed to pdfkit's own justify.
  //
  // pdfkit justifies each `continued` run on its own, as though that run had
  // to fill the line by itself. In a sentence that switches weight mid-line —
  // and every sentence here does, because the role and the dates are bold —
  // that spreads one run's words across the whole measure and leaves
  //
  //     ...02/11/2026(the        "Joining        Date"),
  //
  // which is the same fault the letter this one is modelled on has. Measuring
  // the words and placing them is the only way to get one even line out of two
  // fonts, and it fixes the swallowed space at a run boundary for free.
  const LINE_H = BODY_SIZE + LINE_GAP;
  const SPACE = () => doc.widthOfString(' ');

  const setParagraph = (runs, opts = {}) => {
    const justify = (opts.align || 'justify') === 'justify';
    const size = opts.size || BODY_SIZE;

    // Every word, as the pieces it is made of. A word can change weight in the
    // middle of itself — the comma after a bold name is set plain, and it has
    // to stay hard against the name rather than become a word of its own — so
    // a word is a list of segments, not a string.
    const words = [];
    let open = false;          // does the previous run end mid-word?
    runs.filter(r => r && r.t !== '').forEach((run) => {
      const text = String(run.t);
      const startsMidWord = open && !/^\s/.test(text);
      text.split(/\s+/).filter(Boolean).forEach((w, i) => {
        if (i === 0 && startsMidWord && words.length) words[words.length - 1].push({ w, b: !!run.b });
        else words.push([{ w, b: !!run.b }]);
      });
      open = !/\s$/.test(text);
    });
    if (!words.length) return;

    doc.fontSize(size).fillColor(INK);
    const widthOf = (word) => word.reduce((sum, seg) => {
      doc.font(seg.b ? BOLD : FONT);
      return sum + doc.widthOfString(seg.w);
    }, 0);
    doc.font(FONT);
    const spaceW = SPACE();

    // Greedy line filling, the way any typesetter does it.
    const lines = [];
    let line = [], used = 0;
    for (const word of words) {
      const w = widthOf(word);
      const need = line.length ? used + spaceW + w : w;
      if (line.length && need > width) {
        lines.push({ words: line, used });
        line = [word];
        used = w;
      } else {
        line.push(word);
        used = need;
      }
    }
    if (line.length) lines.push({ words: line, used });

    lines.forEach((ln, i) => {
      // A paragraph that runs off the bottom carries on over the page, and the
      // new page brings its letterhead with it.
      if (doc.y + LINE_H > doc.page.height - doc.page.margins.bottom) doc.addPage();
      const last = i === lines.length - 1;
      // The last line of a justified paragraph is set normally — stretching it
      // is what makes a letter look broken.
      const gap = (justify && !last && ln.words.length > 1)
        ? (width - (ln.used - spaceW * (ln.words.length - 1))) / (ln.words.length - 1)
        : spaceW;
      let x = MARGIN;
      const y = doc.y;
      ln.words.forEach((word) => {
        word.forEach((seg) => {
          doc.font(seg.b ? BOLD : FONT).fontSize(size).fillColor(INK)
            .text(seg.w, x, y, { lineBreak: false });
          x += doc.widthOfString(seg.w);
        });
        x += gap;
      });
      doc.y = y + LINE_H;
    });
    doc.y += (opts.after ?? 0.55) * LINE_H;
    // Drawing at an explicit x leaves the cursor at the last word. Anything
    // that lays itself out afterwards — the numbered list does — starts from
    // doc.x, and would begin wherever this paragraph happened to end.
    doc.x = MARGIN;
  };

  const para = (text, opts = {}) => setParagraph([{ t: text, b: opts.bold }], opts);
  const rich = (runs, opts = {}) => setParagraph(runs, opts);

  // A label and its value on one line. The candidate's own details are set in
  // bold and the signatory's plain, the way the letter this one follows does
  // it: the reader is checking their name, not ours.
  const field = (label, value, plain) => {
    if (value === undefined || value === null || String(value).trim() === '') return;
    doc.fontSize(BODY_SIZE).fillColor(INK)
      .font(FONT).text(label + ' ', { continued: true, lineGap: LINE_GAP })
      .font(plain ? FONT : BOLD).text(String(value));
  };

  // ── the letterhead, where the banner could not be loaded ──
  // The printed one carries the name, the address and a rule; this is the same
  // information set as type, so a missing image costs the letter its look and
  // not its contents.
  if (!art) {
    doc.font(BOLD).fontSize(16).fillColor(INK)
      .text(offer.company || COMPANY, { width, align: 'left' });
    [offer.companyAddress1, offer.companyAddress2].filter(Boolean).forEach((line) => {
      doc.font(FONT).fontSize(9).fillColor(QUIET).text(line, { width, align: 'left', lineGap: 1 });
    });
    doc.moveDown(0.6);
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).lineWidth(0.8).strokeColor(RULE).stroke();
    doc.moveDown(1);
  }

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

  // The list may run over a page break — it is numbered, so it picks itself up
  // again — but it should not leave an orphan of one or two items behind. If
  // fewer than five would fit here, the whole thing starts on the next page.
  const lineH = BODY_SIZE + LINE_GAP + 3;
  const room = doc.page.height - doc.page.margins.bottom - doc.y - 40;
  if (room < lineH * 5) doc.addPage();

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
    // Above the printed band, not over it: the band has its own address and
    // phone number, and a page count sitting on top of them reads as a smudge.
    const y = art
      ? doc.page.height - doc.page.width * ART_RATIO.bottom * (1 - ART_INK.bottom) - 24
      : doc.page.height - MARGIN - 4;
    doc.font(FONT).fontSize(8.5).fillColor(QUIET)
      .text(`Page ${i + 1} of ${range.count}`, MARGIN, y, { width, align: 'center', lineBreak: false });
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
