// ══════════════════════════════════════════════════════
// B2B PROSPECTS BULK UPLOAD
//
// A notebook of parties typed into a sheet, brought in as prospects in one go.
// The columns are read by their heading, not their position, so a sheet laid
// out as Sr. No / Party Name / City / Mobile Number / Contact Person / Remarks
// reads as it stands; the template offers the same six first, then the optional
// ones the prospect form also has.
//
// A file is read twice, as the Recruitment upload is: once to check (nothing
// saved, every row's fate listed), once to import. Nobody is contacted.
//
// Phone numbers arrive as they were written - "98180-30347", "8130-32-5599 /
// 8860-43-4701" - so the dashes and spaces are taken out and a second number is
// kept after a " / ". A digit marked "?" (unclear in the notebook) is never
// guessed at: it stays, the row is flagged, and the prospect's notes say to
// check it.
// ══════════════════════════════════════════════════════
const ExcelJS = require('exceljs');

const HEADERS = ['Sr. No', 'Party Name', 'City', 'Mobile Number', 'Contact Person', 'Remarks / Follow-up',
  'Owner Name', 'WhatsApp Number', 'Email ID', 'State', 'Pincode', 'Address'];

const ALIASES = {
  party_name: ['party name', 'party', 'name', 'customer', 'customer name', 'firm', 'firm name', 'shop', 'shop name', 'company', 'company name'],
  city: ['city', 'town', 'location'],
  phone: ['mobile number', 'mobile', 'mobile no', 'mobile no.', 'phone', 'phone number', 'phone no', 'contact number', 'contact no', 'contact no.'],
  contact_person: ['contact person', 'contact name', 'person', 'spoke to'],
  notes: ['remarks / follow-up', 'remarks/follow-up', 'remarks', 'remark', 'notes', 'note', 'follow-up', 'follow up', 'followup'],
  owner_name: ['owner name', 'owner'],
  whatsapp: ['whatsapp number', 'whatsapp', 'whatsapp no', 'whatsapp no.'],
  email: ['email id', 'email', 'e-mail', 'email address', 'mail'],
  state: ['state'],
  pincode: ['pincode', 'pin code', 'pin', 'zip', 'postal code'],
  address: ['address'],
};
// What the prospect form accepts, so an upload cannot hold what a typed one would cut.
const MAX = { party_name: 255, contact_person: 255, owner_name: 255, email: 255, phone: 50, whatsapp: 50,
  address: 500, city: 120, state: 120, pincode: 12, notes: 1000 };

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[.:]+$/, '').replace(/\s+/g, ' ');
// The same party however it is cased or spaced.
const nameKey = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const UNCLEAR = 'Check these details - unclear in the notebook.';

// ── the template ──────────────────────────────────────
async function template() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bunai Task Manager';
  const ws = wb.addWorksheet('Prospects', { views: [{ state: 'frozen', ySplit: 1 }] });
  const widths = [8, 28, 18, 24, 22, 36, 22, 20, 28, 16, 10, 40];
  ws.columns = HEADERS.map((h, i) => ({ header: h, key: h, width: widths[i] }));
  const head = ws.getRow(1);
  head.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA63F43' } };
  head.alignment = { vertical: 'middle' };
  head.height = 20;
  for (let r = 2; r <= 501; r++) {
    ws.getCell(`A${r}`).value = { formula: `IF(B${r}="","",ROW()-1)` };
    ws.getCell(`D${r}`).numFmt = '@';   // phone numbers stay text: leading zeros, +91 and separators survive
    ws.getCell(`H${r}`).numFmt = '@';
    ws.getCell(`K${r}`).numFmt = '@';
    ws.getRow(r).font = { name: 'Arial' };
  }

  const help = wb.addWorksheet('How to fill');
  help.columns = [{ width: 22 }, { width: 90 }];
  [
    ['Fill the "Prospects" tab, one party per row, then upload it from Bunai B2B > Prospects > Bulk upload.'],
    [],
    ['Column', 'What goes in it'],
    ['Sr. No', 'Fills itself in. Leave it.'],
    ['Party Name', 'Required. The shop or company. A name already on the list (customer or prospect) is skipped.'],
    ['City', 'Optional.'],
    ['Mobile Number', 'Optional. Dashes and spaces are fine. Two numbers: put a "/" between them.'],
    ['Contact Person', 'Optional. Who you speak to.'],
    ['Remarks / Follow-up', 'Optional. Becomes the prospect\'s notes.'],
    ['Owner Name … Address', 'Optional, as on the Add prospect form.'],
    [],
    ['Nobody is contacted by an upload. Uploading the same file twice adds nobody twice.'],
    ['A "?" in a name, city, number or contact is kept as written and the prospect\'s notes say to check it.'],
  ].forEach((l) => help.addRow(l));
  help.eachRow((row) => { row.font = { name: 'Arial' }; row.alignment = { wrapText: true, vertical: 'top' }; });
  help.getRow(1).font = { name: 'Arial', bold: true };
  help.getRow(3).font = { name: 'Arial', bold: true };
  return wb.xlsx.writeBuffer();
}

// ── reading an upload ─────────────────────────────────
function cellText(cell) {
  const v = cell && cell.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.hyperlink && v.text == null) return String(v.hyperlink).trim();
    if (v.text != null) return String(v.text).trim();
    if (v.richText) return v.richText.map((t) => t.text).join('').trim();
    if (v.result != null) return String(v.result).trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v).trim();
}

// "8130-32-5599 / 8860-43-4701" -> ["8130325599", "8860434701"]. A "+" and a
// "?" stay; spaces, dashes, dots and brackets go.
function phonesOf(raw) {
  return String(raw || '').split(/\s*(?:\/|,|;|&|\bor\b)\s*/i)
    .map((s) => s.replace(/[\s\-().]/g, '')).filter(Boolean);
}
// How many real digits a number holds (an unclear "?" is not one).
const digitCount = (p) => (p.match(/\d/g) || []).length;

// buffer: the .xlsx. known: { parties: [names already on the list], customers: [names with an order] }.
async function read(buffer, known) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); }
  catch (_) { return { error: 'That file could not be read. Upload an .xlsx file (Excel), saved as Excel.' }; }

  let ws = null, headerRow = 0, cols = null;
  for (const sheet of wb.worksheets) {
    for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
      const found = {};
      sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, c) => {
        const h = norm(cellText(cell));
        for (const [field, words] of Object.entries(ALIASES)) {
          if (!(field in found) && words.includes(h)) { found[field] = c; break; }
        }
      });
      if (found.party_name) { ws = sheet; headerRow = r; cols = found; break; }
    }
    if (ws) break;
  }
  if (!ws) return { error: 'No "Party Name" column was found. Put the headings in the first row of the tab - Party Name, City, Mobile Number, Contact Person, Remarks.' };

  const onList = new Set((known.parties || []).map(nameKey));
  const customers = new Set((known.customers || []).map(nameKey));
  const inFile = new Map();
  const rows = [];

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (f) => (cols[f] ? cellText(row.getCell(cols[f])) : '');
    const d = {};
    for (const f of Object.keys(MAX)) d[f] = get(f).replace(/\s+/g, ' ').trim().slice(0, MAX[f]);
    // A row with nothing in any of the columns read is an unused line.
    if (!Object.values(d).some(Boolean)) continue;

    const out = { row: r, name: d.party_name || '(no name)', problems: [], notes: [], data: d };
    const key = nameKey(d.party_name);
    if (!d.party_name) out.problems.push('no party name');
    else if (customers.has(key)) out.problems.push('already a customer (it has an order)');
    else if (onList.has(key)) out.problems.push('already on the list');
    else if (inFile.has(key)) out.problems.push('same party as row ' + inFile.get(key));

    // Numbers: separators out, a second number kept, odd lengths pointed at.
    const numbers = phonesOf(d.phone);
    if (numbers.length) {
      d.phone = numbers.join(' / ').slice(0, MAX.phone);
      const odd = numbers.filter((p) => { const n = digitCount(p); return n !== 10 && !(n === 12 && /^\+?91/.test(p)); });
      if (odd.length) out.notes.push('phone ' + odd.join(', ') + ' does not have 10 digits - check it');
    }
    if (d.whatsapp) d.whatsapp = phonesOf(d.whatsapp).join(' / ').slice(0, MAX.whatsapp);
    if (d.email && !looksLikeEmail(d.email)) {
      out.notes.push('email "' + d.email.slice(0, 40) + '" does not look right, left blank');
      d.email = '';
    }

    // Anything the notebook could not make out stays as written, and says so.
    if (/\?/.test([d.party_name, d.city, d.phone, d.contact_person].join(' '))) {
      out.notes.push('has a "?" in it (unclear in the notebook), kept as written');
      if (!d.notes.includes(UNCLEAR)) d.notes = (d.notes ? d.notes + ' ' : '') + UNCLEAR;
      d.notes = d.notes.slice(0, MAX.notes);
    }

    if (!out.problems.length && key) inFile.set(key, r);
    rows.push(out);
  }
  return { sheet: ws.name, rows };
}

module.exports = { HEADERS, template, read, nameKey };
