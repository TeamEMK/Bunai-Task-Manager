// ══════════════════════════════════════════════════════
// BUNAI PRODUCT COST - the cost sheet as a PDF, for use inside Bunai.
//
// On the letterhead, as the Vendor PO is: the product (photo, SKU, category,
// who last saved it), its cost lines, and the way to its internal price -
// total, overhead, total before profit, profit, internal price - worked out by
// the caller exactly as the page works it, so the PDF can never disagree.
//
// Money is "Rs": the PDF's built-in fonts have no rupee sign.
// ══════════════════════════════════════════════════════
const page = require('./letterheadPdf');

const { PINK, PINK_FILL, PINK_TINT, INK, QUIET, LINE, FONT, BOLD, M } = page.STYLE;

const rs = (v) => (v == null || v === '' ? '-' : 'Rs ' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (v) => (v == null || v === '' ? '-' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 }));
const plain = (v) => (v == null || v === '' ? '-' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }));

// The product photo as bytes pdfkit can draw - JPEG or PNG. Drive's thumbnail
// of the uploaded photo (link-viewable, as the list's own thumbnails are): a
// 60 KB picture in about a second, where the full upload took six. Anything
// else, slow, or gone: the sheet goes out without a photo.
async function photoOf(url) {
  const id = (/\/d\/([\w-]{20,})/.exec(url || '') || /[?&]id=([\w-]{20,})/.exec(url || '') || [])[1];
  if (!id) return null;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 5000);
  try {
    const res = await fetch('https://drive.google.com/thumbnail?id=' + id + '&sz=w600', { signal: stop.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8, png = buf[0] === 0x89 && buf[1] === 0x50;
    return jpeg || png ? buf : null;
  } catch (err) {
    console.warn('⚠️ Product cost PDF: no photo -', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// c: { sku, category, updated, updated_by_name, overhead, overhead_type, profit, profit_type, lines: [...],
//      price: { total, overhead, beforeProfit, profit, selling }, photo: Buffer|null, today: 'YYYY-MM-DD' }
function build(c) {
  const { doc, pw, W, top, limit } = page.open({ title: 'Product Cost ' + (c.sku || ''), subject: 'Bunai product cost sheet' });
  let y = top;

  // ── Title ──
  doc.font(BOLD).fontSize(24).fillColor(PINK).text('PRODUCT COST SHEET', M, y, { width: W, align: 'center', lineBreak: false });
  y += 34;
  doc.moveTo(M, y).lineTo(pw - M, y).lineWidth(0.8).strokeColor(PINK).stroke();
  y += 14;
  doc.font(BOLD).fontSize(10).fillColor(INK);
  doc.text('SKU: ' + (c.sku || ''), M, y, { width: W / 2, lineBreak: false });
  doc.text('Date: ' + page.longDate(c.today), M + W / 2, y, { width: W / 2, align: 'right', lineBreak: false });
  y += 24;

  // ── The product: photo on the left, its details beside it ──
  const PH_W = 96, PH_H = 120, PAD = 14;
  const hasPhoto = !!c.photo;
  const infoX = M + PAD + (hasPhoto ? PH_W + 18 : 0);
  const infoW = pw - M - PAD - infoX;
  const info = [
    ['SKU', c.sku], ['Category', c.category || '-'], ['Cost lines', String((c.lines || []).length)],
    ['Last updated', (c.updated || '-') + (c.updated_by_name ? ' by ' + c.updated_by_name : '')],
  ];
  doc.font(FONT).fontSize(10);
  const infoH = info.reduce((s, [k, v]) => s + doc.heightOfString(k + ': ' + v, { width: infoW }) + 7, 0);
  const boxH = Math.max(hasPhoto ? PH_H : 0, infoH + 4) + PAD * 2;
  doc.rect(M, y, W, boxH).lineWidth(0.8).strokeColor(LINE).stroke();
  if (hasPhoto) {
    try {
      doc.image(c.photo, M + PAD, y + PAD, { fit: [PH_W, PH_H], align: 'center', valign: 'center' });
      doc.rect(M + PAD, y + PAD, PH_W, PH_H).lineWidth(0.5).strokeColor(LINE).stroke();
    } catch (_) { /* a picture pdfkit cannot read: the details still stand */ }
  }
  let iy = y + PAD + 2;
  info.forEach(([k, v]) => {
    doc.font(BOLD).fontSize(10).fillColor(INK).text(k + ': ', infoX, iy, { continued: true })
      .font(FONT).fillColor(QUIET).text(v, { width: infoW });
    iy += doc.heightOfString(k + ': ' + v, { width: infoW }) + 7;
  });
  y += boxH + 20;

  // ── The cost lines ──
  const C = [
    { key: 'n', label: 'S.No', w: 44, align: 'center' },
    { key: 'component', label: 'Particular', w: 110, align: 'left' },
    { key: 'material', label: 'Fabric', w: 150, align: 'left' },
    { key: 'qty', label: 'Quantity', w: 62, align: 'right' },
    { key: 'rate', label: 'Rate (Rs)', w: 66, align: 'right' },
    { key: 'amount', label: 'Amount (Rs)', w: W - 432, align: 'right' },
  ];
  let cx = M;
  C.forEach(col => { col.x = cx; cx += col.w; });
  const CP = 8, HEAD_H = 28;
  const head = () => {
    doc.rect(M, y, W, HEAD_H).fillColor(PINK_FILL).fill();
    doc.font(BOLD).fontSize(9.5).fillColor(INK);
    C.forEach(col => doc.text(col.label, col.x + CP, y + 10, { width: col.w - CP * 2, align: col.align, lineBreak: false }));
    y += HEAD_H;
  };
  const nextPage = () => {
    doc.addPage();
    y = doc.page.margins.top;
    doc.font(BOLD).fontSize(9.5).fillColor(QUIET).text((c.sku || '') + ' (continued)', M, y, { width: W, align: 'right', lineBreak: false });
    y += 20;
  };
  head();
  (c.lines || []).forEach((l, i) => {
    const cells = {
      n: String(i + 1), component: l.component || '-', material: l.material || '-',
      qty: num(l.qty), rate: plain(l.rate), amount: l.amount == null ? '-' : Number(l.amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    };
    doc.font(FONT).fontSize(9.5);
    const h = Math.max(26, ...C.map(col => doc.heightOfString(cells[col.key], { width: col.w - CP * 2 }) + 15));
    if (y + h > limit()) { nextPage(); head(); }
    doc.font(FONT).fontSize(9.5).fillColor(INK);
    C.forEach(col => doc.text(cells[col.key], col.x + CP, y + 8, { width: col.w - CP * 2, align: col.align }));
    y += h;
    doc.moveTo(M, y).lineTo(pw - M, y).lineWidth(0.6).strokeColor(LINE).stroke();
  });

  // ── From the total to the internal price - kept together ──
  const p = c.price || {};
  const pct = (v, t) => (v != null && t === 'pct' ? ' (' + plain(v) + '%)' : '');
  const rows = [
    ['Total', rs(p.total)],
    ['Overhead' + pct(c.overhead, c.overhead_type), c.overhead == null ? '-' : rs(p.overhead)],
    ['Total before profit', rs(p.beforeProfit)],
    ['Profit' + pct(c.profit, c.profit_type), c.profit == null ? '-' : rs(p.profit)],
  ];
  const ROW = 24, SW = 280, SX = pw - M - SW;
  const needed = 16 + rows.length * ROW + 34 + 40;
  if (y + needed > limit()) nextPage();
  y += 16;
  rows.forEach(([k, v]) => {
    doc.font(FONT).fontSize(10).fillColor(QUIET).text(k, SX + 12, y + 7, { width: SW * 0.55, lineBreak: false });
    doc.font(BOLD).fontSize(10).fillColor(INK).text(v, SX + SW * 0.45, y + 7, { width: SW * 0.55 - 12, align: 'right', lineBreak: false });
    y += ROW;
    doc.moveTo(SX, y).lineTo(pw - M, y).lineWidth(0.5).strokeColor(LINE).stroke();
  });
  doc.rect(SX, y + 4, SW, 30).fillColor(PINK_TINT).fill();
  doc.rect(SX, y + 4, SW, 30).lineWidth(0.8).strokeColor(PINK).stroke();
  doc.font(BOLD).fontSize(12).fillColor(INK).text('Internal price', SX + 12, y + 13, { width: SW * 0.5, lineBreak: false });
  doc.font(BOLD).fontSize(12.5).fillColor(INK).text(rs(p.selling), SX + SW * 0.4, y + 13, { width: SW * 0.6 - 12, align: 'right', lineBreak: false });
  y += 50;

  doc.font(FONT).fontSize(8.5).fillColor(QUIET)
    .text('For use inside Bunai only - this sheet shows costing and profit.', M, y, { width: W, lineBreak: false });

  return doc;
}

const render = (c) => page.render(() => build(c));

// "BUNA-IH 268 - Cost Sheet.pdf"
const fileName = (c) => (String(c.sku || 'Product').replace(/[^\w \-.]/g, '').trim() || 'Product') + ' - Cost Sheet.pdf';

module.exports = { render, fileName, photoOf };
