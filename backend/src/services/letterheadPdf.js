// ══════════════════════════════════════════════════════
// A4 pages on the company letterhead - what the Vendor PO and the Bunai
// product cost sheet are printed on (the offer letter sets its own, older
// layout on the same images).
//
// open() gives a pdfkit document whose every page carries the letterhead's top
// and bottom bands and a faint Bunai logo, with margins that keep the writing
// clear of both bands; render() turns a builder into the PDF's bytes.
// ══════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const config = require('../config');
const { letterhead, ART_RATIO, ART_INK, COMPANY } = require('./offerLetter');

const STYLE = {
  PINK: '#F2A9AF',        // the letterhead's pink, a shade deeper so type on white reads
  PINK_FILL: '#F5B8BC',   // table headers, as the letterhead band
  PINK_TINT: '#FDEEEF',   // a highlighted row
  INK: '#333333',
  QUIET: '#555555',
  LINE: '#D9D9D9',
  FONT: 'Helvetica',
  BOLD: 'Helvetica-Bold',
  M: 44,                  // side margin
};

// The logo for the watermark, read once. Missing, the page goes out without one.
let _logo;
function logo() {
  if (_logo === undefined) {
    try { _logo = fs.readFileSync(path.join(config.publicDir, 'bunai-logo.png')); } catch (_) { _logo = null; }
  }
  return _logo;
}

// "2026-11-26" -> "26 Nov 2026", read as a calendar day, never through a timezone.
function longDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return Number(m[3]) + ' ' + MON[Number(m[2]) - 1] + ' ' + m[1];
}

// info: the PDF's Title and Subject.
function open(info) {
  const art = letterhead();
  const PAGE_W = 595.28;
  const bandTop = art ? PAGE_W * ART_RATIO.top : 0;
  const bandBottom = art ? PAGE_W * ART_RATIO.bottom : 0;
  const top = art ? Math.round(bandTop * ART_INK.top) + 6 : STYLE.M;
  const bottom = art ? Math.round(bandBottom * (1 - ART_INK.bottom)) + 34 : STYLE.M;

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top, bottom, left: STYLE.M, right: STYLE.M },
    info: { Title: info.title || '', Author: COMPANY, Subject: info.subject || '' },
  });
  const pw = doc.page.width, ph = doc.page.height;
  const W = pw - STYLE.M * 2;

  const dress = () => {
    if (!art) {
      doc.font(STYLE.BOLD).fontSize(16).fillColor(STYLE.INK).text(COMPANY.toUpperCase(), STYLE.M, 30, { width: W });
      return;
    }
    const mark = logo();
    if (mark) doc.save().opacity(0.07).image(mark, (pw - 240) / 2, (ph - 234) / 2 + 30, { width: 240 }).restore();
    doc.image(art.top, 0, 0, { width: pw });
    doc.image(art.bottom, 0, ph - bandBottom, { width: pw });
  };
  doc.on('pageAdded', dress);
  dress();

  return { doc, pw, ph, W, M: STYLE.M, top, limit: () => ph - doc.page.margins.bottom };
}

// The whole PDF in memory: these are a page or a few, sent straight back.
function render(build) {
  return new Promise((resolve, reject) => {
    try {
      const doc = build();
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

module.exports = { STYLE, open, render, longDate, logo };
