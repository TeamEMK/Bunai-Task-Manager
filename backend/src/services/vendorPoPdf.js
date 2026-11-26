// ══════════════════════════════════════════════════════
// VENDOR PO - the PDF.
//
// On the company letterhead, as the offer letter is, laid out after the design
// the client picked (26 Nov 2026): a pink PURCHASE ORDER title, PO number and
// date, the vendor in a box, the particulars in a table with a pink header,
// the total quantity under it, notes, and two signature lines.
//
// Quantities only - nothing on a PO to a vendor carries a price. A long PO
// runs onto more pages, the table's header repeated at the top of each.
// ══════════════════════════════════════════════════════
const page = require('./letterheadPdf');

const { PINK, PINK_FILL, INK, QUIET, LINE, FONT, BOLD, M } = page.STYLE;
const { longDate } = page;

// Written when the PO has no notes of its own - the two lines of the design.
const DEFAULT_NOTES = ['Deliver as per the approved sample.', 'Mention the PO number on the delivery challan.'];

const qtyText = (v) => (v == null || v === '' ? '-' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 }));

// po: { po_no, po_date, vendor_name, vendor_company, vendor_address, vendor_phone, notes, total_qty, lines: [...] }
function build(po) {
  const { doc, pw, W, top, limit } = page.open({
    title: 'Purchase Order ' + (po.po_no || ''), subject: 'Purchase Order to ' + (po.vendor_name || ''),
  });

  let y = top;

  // ── Title ──
  doc.font(BOLD).fontSize(26).fillColor(PINK).text('PURCHASE ORDER', M, y, { width: W, align: 'center', lineBreak: false });
  y += 36;
  doc.moveTo(M, y).lineTo(pw - M, y).lineWidth(0.8).strokeColor(PINK).stroke();
  y += 14;

  // ── PO number and date ──
  doc.font(BOLD).fontSize(10).fillColor(INK);
  doc.text('PO No: ' + (po.po_no || ''), M, y, { width: W / 2, lineBreak: false });
  doc.text('Date: ' + longDate(po.po_date), M + W / 2, y, { width: W / 2, align: 'right', lineBreak: false });
  y += 24;

  // ── The vendor ──
  const half = W / 2 - 18;
  const blank = '______________________________';
  const left = [['Vendor Name', po.vendor_name], ['Company', po.vendor_company]];
  const right = [['Address', po.vendor_address], ['Phone', po.vendor_phone]];
  doc.font(FONT).fontSize(10);
  const rowH = (pairs, size) => pairs.map(([k, v]) => doc.fontSize(size).heightOfString(k + ': ' + (v || blank), { width: half }) + 6);
  const lh = rowH(left, 10), rh = rowH(right, 9);
  const boxH = 14 + 18 + Math.max(lh.reduce((a, b) => a + b, 0), rh.reduce((a, b) => a + b, 0)) + 8;
  doc.rect(M, y, W, boxH).lineWidth(0.8).strokeColor(LINE).stroke();
  doc.font(BOLD).fontSize(11).fillColor(INK).text('Issued To (Vendor)', M + 16, y + 12, { width: W - 32 });
  let ly = y + 32, ry = y + 33;
  left.forEach(([k, v], i) => { doc.font(FONT).fontSize(10).fillColor(QUIET).text(k + ': ' + (v || blank), M + 16, ly, { width: half }); ly += lh[i]; });
  right.forEach(([k, v], i) => { doc.font(FONT).fontSize(9).fillColor(QUIET).text(k + ': ' + (v || blank), M + W / 2 + 6, ry, { width: half }); ry += rh[i]; });
  y += boxH + 20;

  // ── The particulars ──
  const C = [
    { key: 'n', label: 'S.No', x: M, w: 46, align: 'center' },
    { key: 'particular', label: 'Particular', x: M + 46, w: 210, align: 'left' },
    { key: 'qty', label: 'Quantity', x: M + 256, w: 84, align: 'center' },
    { key: 'unit', label: 'Unit', x: M + 340, w: 60, align: 'center' },
    { key: 'remarks', label: 'Remarks', x: M + 400, w: W - 400, align: 'left' },
  ];
  // A page after the first says whose it is, so a loose sheet still names its PO.
  const nextPage = () => {
    doc.addPage();
    y = doc.page.margins.top;
    doc.font(BOLD).fontSize(9.5).fillColor(QUIET)
      .text((po.po_no || 'PO') + ' (continued)', M, y, { width: W, align: 'right', lineBreak: false });
    y += 20;
  };
  const PAD = 10, HEAD_H = 30;
  const head = () => {
    doc.rect(M, y, W, HEAD_H).fillColor(PINK_FILL).fill();
    doc.font(BOLD).fontSize(10).fillColor(INK);
    C.forEach(c => doc.text(c.label, c.x + PAD, y + 10, { width: c.w - PAD * 2, align: c.align, lineBreak: false }));
    y += HEAD_H;
  };
  head();
  (po.lines || []).forEach((l, i) => {
    const cells = {
      n: String(i + 1), particular: l.particular || '', qty: qtyText(l.qty),
      unit: l.unit || '-', remarks: l.remarks || '-',
    };
    doc.font(FONT).fontSize(10);
    const h = Math.max(30, ...C.map(c => doc.heightOfString(cells[c.key], { width: c.w - PAD * 2 }) + 18));
    if (y + h > limit()) { nextPage(); head(); }
    // The header leaves the bold face set; a row is measured and set in the plain one.
    doc.font(FONT).fontSize(10).fillColor(INK);
    C.forEach(c => doc.text(cells[c.key], c.x + PAD, y + 9, { width: c.w - PAD * 2, align: c.align }));
    y += h;
    doc.moveTo(M, y).lineTo(pw - M, y).lineWidth(0.6).strokeColor(LINE).stroke();
  });

  // ── Total, notes, signatures - kept together, on a new page if they do not fit ──
  const notes = String(po.notes || '').trim() ? String(po.notes).trim().split(/\r?\n/) : DEFAULT_NOTES;
  doc.font(FONT).fontSize(9.5);
  const notesH = 30 + notes.reduce((s, t) => s + doc.heightOfString(t, { width: W - 32 }) + 3, 0) + 8;
  const tailH = 28 + notesH + 30 + 60;
  if (y + tailH > limit()) nextPage();

  y += 12;
  doc.font(BOLD).fontSize(12.5).fillColor(INK)
    .text('Total Quantity: ' + qtyText(po.total_qty == null ? 0 : po.total_qty), M, y, { width: W, align: 'right', lineBreak: false });
  y += 30;

  doc.rect(M, y, W, notesH).lineWidth(0.8).strokeColor(LINE).stroke();
  doc.font(BOLD).fontSize(10).fillColor(INK).text('Notes', M + 16, y + 12, { width: W - 32 });
  let ny = y + 30;
  notes.forEach(t => {
    doc.font(FONT).fontSize(9.5).fillColor(QUIET).text(t, M + 16, ny, { width: W - 32 });
    ny += doc.heightOfString(t, { width: W - 32 }) + 3;
  });
  y += notesH + 44;

  const sigW = 165;
  [[M, 'Prepared By'], [pw - M - sigW, 'Authorised Signatory']].forEach(([x, label]) => {
    doc.moveTo(x, y).lineTo(x + sigW, y).lineWidth(0.8).strokeColor(INK).stroke();
    doc.font(FONT).fontSize(10).fillColor(INK).text(label, x, y + 8, { width: sigW, align: 'center', lineBreak: false });
  });

  return doc;
}

const render = (po) => page.render(() => build(po));

// "BUN-PO-0012 - Harsh.pdf"
function fileName(po) {
  const who = String(po.vendor_name || '').replace(/[^\w \-.]/g, '').trim();
  return (po.po_no || 'PO') + (who ? ' - ' + who : '') + '.pdf';
}

module.exports = { render, fileName };
