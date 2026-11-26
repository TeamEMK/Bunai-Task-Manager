// ══════════════════════════════════════════════════════
// VENDOR PO (/api/vendor-pos) - what the team issues to a vendor.
//
// A PO is a vendor from the Vendor Name book, the date (today unless changed)
// and as many particulars as there are, each with a quantity, a unit and an
// optional remark. The total quantity is the particulars' quantities added
// up, worked out here so the list and the PO always agree with the lines.
//
// The vendor's name and company are kept on the PO as they were when it was
// made: a vendor renamed later does not rewrite a PO already sent.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin, requirePage } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const vendorPoPdf = require('../services/vendorPoPdf');

const router = express.Router();
const PAGE = requirePage('vendorpo');

const UNITS = ['pcs', 'mtr', 'kg', 'set', 'roll', 'dozen'];
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const TODAY_IST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const poNo = (id) => 'BUN-PO-' + String(id).padStart(4, '0');
// Blank is blank; "25", "25.5" and "1,000" are numbers; anything else is refused.
const qtyOf = (v) => {
  const t = String(v == null ? '' : v).replace(/,/g, '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) / 1000 : NaN;
};
const num = (v) => (v == null ? null : Number(v));

async function whoAmI(req) {
  const me = await db.one('SELECT name FROM users WHERE id = ?', [req.session.userId]).catch(() => null);
  return clip((me && me.name) || req.session.name || '', 120);
}

async function fromBody(b) {
  const vendorId = parseInt(b.vendor_id, 10);
  if (!vendorId) throw httpError(400, 'Pick the vendor.');
  const v = await db.one('SELECT id, vendor_name, company FROM vendor_book WHERE id = ?', [vendorId]);
  if (!v) throw httpError(400, 'That vendor is no longer in the Vendor Name list.');
  const date = isYmd(b.po_date) ? b.po_date : TODAY_IST();
  const lines = [];
  (Array.isArray(b.lines) ? b.lines : []).slice(0, 500).forEach((l, i) => {
    const particular = clip(l.particular, 255), remarks = clip(l.remarks, 500);
    const qty = qtyOf(l.qty);
    // A row left empty is not a particular.
    if (!particular && !remarks && qty === null) return;
    if (!particular) throw httpError(400, 'Line ' + (i + 1) + ': write the particular.');
    if (Number.isNaN(qty)) throw httpError(400, 'Line ' + (i + 1) + ': the quantity is not a number.');
    lines.push({ particular, qty, unit: UNITS.includes(l.unit) ? l.unit : '', remarks });
  });
  if (!lines.length) throw httpError(400, 'Add at least one particular.');
  const counted = lines.filter(l => l.qty != null);
  const total = counted.length ? Math.round(counted.reduce((s, l) => s + l.qty, 0) * 1000) / 1000 : null;
  return {
    vendor_id: v.id, vendor_name: v.vendor_name,
    // The company as typed on the PO, else the one in the book.
    vendor_company: clip(b.vendor_company, 200) || v.company || '',
    po_date: date, notes: clip(b.notes, 2000), total_qty: total, lines,
  };
}

async function writeLines(poId, lines) {
  await db.query('DELETE FROM vendor_po_lines WHERE po_id = ?', [poId]);
  await db.query(
    'INSERT INTO vendor_po_lines (po_id, position, particular, qty, unit, remarks) VALUES ?',
    [lines.map((l, i) => [poId, i + 1, l.particular, l.qty, l.unit, l.remarks])]);
}

// The list, newest first, and the vendors to pick from (this page may be
// granted without the Vendor Name page, so it brings its own list).
router.get('/vendor-pos', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const [rows, vendors] = await Promise.all([
    db.rows(
      `SELECT p.id, p.po_no, p.vendor_id, p.vendor_name, p.vendor_company,
              DATE_FORMAT(p.po_date, '%Y-%m-%d') AS po_date, p.total_qty, p.notes,
              p.created_by_name, p.updated_by_name,
              DATE_FORMAT(p.updated_at + INTERVAL 330 MINUTE, '%e %b %Y, %l:%i %p') AS updated,
              (SELECT COUNT(*) FROM vendor_po_lines l WHERE l.po_id = p.id) AS line_count,
              (SELECT GROUP_CONCAT(l.particular ORDER BY l.position SEPARATOR ' · ') FROM vendor_po_lines l WHERE l.po_id = p.id) AS particulars
         FROM vendor_pos p ORDER BY p.po_date DESC, p.id DESC LIMIT 2000`),
    db.rows('SELECT id, vendor_name AS name, company FROM vendor_book ORDER BY vendor_name'),
  ]);
  res.json({
    units: UNITS, today: TODAY_IST(), vendors,
    rows: rows.map(r => ({ ...r, total_qty: num(r.total_qty), line_count: Number(r.line_count) || 0, particulars: r.particulars || '' })),
  });
}));

router.get('/vendor-pos/:id', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = await db.one(
    `SELECT p.id, p.po_no, p.vendor_id, p.vendor_name, p.vendor_company,
            DATE_FORMAT(p.po_date, '%Y-%m-%d') AS po_date, p.total_qty, p.notes, p.created_by_name, p.updated_by_name,
            DATE_FORMAT(p.updated_at + INTERVAL 330 MINUTE, '%e %b %Y, %l:%i %p') AS updated
       FROM vendor_pos p WHERE p.id = ?`, [id]);
  if (!p) throw httpError(404, 'That PO is no longer on the list.');
  const lines = await db.rows('SELECT particular, qty, unit, remarks FROM vendor_po_lines WHERE po_id = ? ORDER BY position, id', [id]);
  res.json({ ...p, total_qty: num(p.total_qty), lines: lines.map(l => ({ ...l, qty: num(l.qty) })) });
}));

// The PO as a PDF on the letterhead, downloaded. The vendor's address and phone
// come from the Vendor Name book as it is now; the name and company are the PO's.
router.get('/vendor-pos/:id/pdf', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = await db.one(
    `SELECT p.po_no, p.vendor_id, p.vendor_name, p.vendor_company, DATE_FORMAT(p.po_date, '%Y-%m-%d') AS po_date,
            p.notes, p.total_qty, v.address AS vendor_address, v.phone AS vendor_phone
       FROM vendor_pos p LEFT JOIN vendor_book v ON v.id = p.vendor_id WHERE p.id = ?`, [id]);
  if (!p) throw httpError(404, 'That PO is no longer on the list.');
  const lines = await db.rows('SELECT particular, qty, unit, remarks FROM vendor_po_lines WHERE po_id = ? ORDER BY position, id', [id]);
  const po = { ...p, total_qty: num(p.total_qty), lines: lines.map(l => ({ ...l, qty: num(l.qty) })) };
  const pdf = await vendorPoPdf.render(po);
  const name = vendorPoPdf.fileName(po).replace(/[^\w. -]/g, '_');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', (req.query.view ? 'inline' : 'attachment') + '; filename="' + name + '"');
  res.send(pdf);
}));

router.post('/vendor-pos', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const p = await fromBody(req.body || {});
  const name = await whoAmI(req);
  const [ins] = await db.query(
    `INSERT INTO vendor_pos (vendor_id, vendor_name, vendor_company, po_date, notes, total_qty,
                             created_by, created_by_name, updated_by_name, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [p.vendor_id, p.vendor_name, p.vendor_company, p.po_date, p.notes, p.total_qty, req.session.userId, name, name]);
  await db.query('UPDATE vendor_pos SET po_no = ? WHERE id = ?', [poNo(ins.insertId), ins.insertId]);
  await writeLines(ins.insertId, p.lines);
  res.json({ id: ins.insertId, po_no: poNo(ins.insertId) });
}));

router.put('/vendor-pos/:id', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!(await db.one('SELECT id FROM vendor_pos WHERE id = ?', [id]))) throw httpError(404, 'That PO is no longer on the list.');
  const p = await fromBody(req.body || {});
  await db.query(
    `UPDATE vendor_pos SET vendor_id=?, vendor_name=?, vendor_company=?, po_date=?, notes=?, total_qty=?,
            updated_by_name=?, updated_at=UTC_TIMESTAMP() WHERE id=?`,
    [p.vendor_id, p.vendor_name, p.vendor_company, p.po_date, p.notes, p.total_qty, await whoAmI(req), id]);
  await writeLines(id, p.lines);
  res.json({ success: true });
}));

// Deleting a PO that may already be with a vendor is an Admin's call, as
// deleting a vendor is.
router.delete('/vendor-pos/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.query('DELETE FROM vendor_po_lines WHERE po_id = ?', [id]);
  await db.query('DELETE FROM vendor_pos WHERE id = ?', [id]);
  res.json({ success: true });
}));

module.exports = router;
