// ══════════════════════════════════════════════════════
// RECRUITMENT BULK UPLOAD
//
// The template the client fills, and the reading of it back. Their columns, in
// their order: Sr. No, Name, Contact number, Email, Position, Source, Status,
// Location, Expected salary, Notice period.
//
// No Resume column. A file cannot go inside a spreadsheet, and a column asking
// for one only confused people; the CV is uploaded on the candidate's Edit form
// after the import. A sheet that still has a Resume column of links is read all
// the same.
//
// An upload never writes to anybody. Adding a candidate by hand can send an
// interview invitation; adding three hundred from last year's spreadsheet must
// not, so nothing here touches the mailer.
//
// A file is read twice: once to check (nothing saved, every row's fate listed),
// once to import. Rows are matched to columns by header text, not position, so
// a sheet with a column moved or an extra one added still reads right.
// ══════════════════════════════════════════════════════
const ExcelJS = require('exceljs');

const STATUSES = ['Applied', 'Scheduled', 'Rescheduled', 'Selected', 'Onboarding', 'Rejected', 'Offer Sent'];

const HEADERS = ['Sr. No', 'Name', 'Contact number', 'Email', 'Position', 'Source', 'Status',
  'Location', 'Expected salary', 'Notice period'];

// The words people actually write in these headers.
const ALIASES = {
  name: ['name', 'candidate name', 'full name', 'candidate'],
  phone: ['contact number', 'contact no', 'contact', 'phone', 'phone number', 'mobile', 'mobile number', 'contact no.'],
  email: ['email', 'email id', 'e-mail', 'mail', 'email address'],
  position: ['position', 'profile', 'role', 'designation', 'post', 'profile position'],
  source: ['source', 'candidate source', 'lead source', 'sourced from', 'referred by'],
  resume: ['resume', 'cv', 'resume link', 'cv link'],
  status: ['status'],
  location: ['location', 'city', 'current location'],
  expected_salary: ['expected salary', 'expected ctc', 'expected', 'salary expected'],
  notice_period: ['notice period', 'notice'],
};
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[.:]+$/, '').replace(/\s+/g, ' ');

// ── the template ──────────────────────────────────────
async function template() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bunai Task Manager';
  const ws = wb.addWorksheet('Candidates', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = HEADERS.map((h) => ({
    header: h, key: h,
    width: { 'Sr. No': 8, Name: 26, 'Contact number': 16, Email: 30, Position: 22, Source: 18, Status: 14,
      Location: 18, 'Expected salary': 16, 'Notice period': 15 }[h],
  }));
  const head = ws.getRow(1);
  head.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA63F43' } };
  head.alignment = { vertical: 'middle' };
  head.height = 20;
  // Room for a few hundred people, each row with the same dropdown and a
  // running number that fills itself in as soon as a name is typed.
  for (let r = 2; r <= 501; r++) {
    ws.getCell(`A${r}`).value = { formula: `IF(B${r}="","",ROW()-1)` };
    ws.getCell(`G${r}`).dataValidation = {
      type: 'list', allowBlank: true, showErrorMessage: true,
      formulae: ['"' + STATUSES.join(',') + '"'],
      errorTitle: 'Status', error: 'Pick one from the list.',
    };
    ws.getCell(`C${r}`).numFmt = '@';   // phone numbers stay text, so leading zeros and +91 survive
    ws.getRow(r).font = { name: 'Arial' };
  }

  // The example and the rules sit on their own tab, so an example row can never
  // be uploaded as a real candidate.
  const help = wb.addWorksheet('How to fill');
  help.columns = [{ width: 22 }, { width: 90 }];
  const lines = [
    ['Fill the "Candidates" tab, one person per row, then upload it from Recruitment > Bulk upload.'],
    [],
    ['Column', 'What goes in it'],
    ['Sr. No', 'Fills itself in. Leave it.'],
    ['Name', 'Required.'],
    ['Contact number', 'Phone number. Name plus a phone or an email is the minimum.'],
    ['Email', 'Optional, but needed later to email the candidate. Must look like name@domain.com.'],
    ['Position', 'The role they applied for, e.g. MIS Executive.'],
    ['Source', 'Where the candidate came from, e.g. Naukri, LinkedIn, Indeed, Referral, Walk-in.'],
    ['Status', 'Pick from the list: ' + STATUSES.join(', ') + '. Blank means Applied.'],
    ['Location', 'Where they live or would work from.'],
    ['Expected salary', 'As they said it, e.g. 25,000 per month or 3.5 LPA.'],
    ['Notice period', 'e.g. Immediate, 15 days, 1 month.'],
    [],
    ['Nobody is emailed by an upload.'],
    ['A person already in Recruitment (same email or phone) is skipped, so uploading the same file twice adds nobody twice.'],
    ['CVs: after the upload, open the candidate in Recruitment, click Edit and upload the CV there.'],
    ['Example row (do not copy it into Candidates):'],
    HEADERS,
    [1, 'Riya Sharma', '9876543210', 'riya.sharma@example.com', 'MIS Executive', 'Naukri',
      'Applied', 'Jaipur', '25,000 per month', '1 month'],
  ];
  lines.forEach((l) => help.addRow(l));
  help.eachRow((row) => { row.font = { name: 'Arial' }; row.alignment = { wrapText: true, vertical: 'top' }; });
  help.getRow(1).font = { name: 'Arial', bold: true };
  help.getRow(3).font = { name: 'Arial', bold: true };
  help.getRow(18).font = { name: 'Arial', bold: true };
  help.getRow(19).font = { name: 'Arial', bold: true };
  help.getRow(20).font = { name: 'Arial', italic: true, color: { argb: 'FF78716C' } };

  return wb.xlsx.writeBuffer();
}

// ── reading an upload ─────────────────────────────────
// A cell can be text, a number, a hyperlink, a formula or a date; this gives the
// text a person sees, and for a hyperlink its address.
function cellText(cell) {
  const v = cell && cell.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.hyperlink) return String(v.hyperlink).trim();
    if (v.text != null) return String(v.text).trim();
    if (v.richText) return v.richText.map((t) => t.text).join('').trim();
    if (v.result != null) return String(v.result).trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v).trim();
}

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const phoneKey = (v) => String(v || '').replace(/\D/g, '').slice(-10);

// Reads the first tab that has a "Name" header, and returns every row with what
// will happen to it. `existing` is the candidates already on file.
async function read(buffer, existing) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); }
  catch (_) { return { error: 'That file could not be read. Upload the .xlsx template, filled in and saved as Excel.' }; }

  let ws = null, headerRow = 0, cols = null;
  for (const sheet of wb.worksheets) {
    for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
      const found = {};
      sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, c) => {
        const h = norm(cellText(cell));
        for (const [field, words] of Object.entries(ALIASES)) {
          if (!(field in found) && words.includes(h)) found[field] = c;
        }
      });
      if (found.name) { ws = sheet; headerRow = r; cols = found; break; }
    }
    if (ws) break;
  }
  if (!ws) return { error: 'No "Name" column was found. Use the template\'s "Candidates" tab, with the headings in the first row.' };

  const seenEmail = new Set(existing.map((e) => String(e.email || '').toLowerCase()).filter(Boolean));
  const seenPhone = new Set(existing.map((e) => phoneKey(e.phone)).filter((p) => p.length === 10));
  const inFileEmail = new Map(), inFilePhone = new Map();

  const rows = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (f) => (cols[f] ? cellText(row.getCell(cols[f])) : '');
    const c = {
      name: get('name').slice(0, 255), phone: get('phone').slice(0, 50), email: get('email').slice(0, 255),
      position: get('position').slice(0, 255), resume: get('resume').slice(0, 1000), status: get('status'),
      source: get('source').slice(0, 120),
      location: get('location').slice(0, 255), expected_salary: get('expected_salary').slice(0, 100),
      notice_period: get('notice_period').slice(0, 100),
    };
    // A row with nothing but the running number in it is an unused line.
    if (!c.name && !c.phone && !c.email && !c.position) continue;

    const out = { row: r, name: c.name || '(no name)', problems: [], notes: [], data: c };
    if (!c.name) out.problems.push('no name');
    if (!c.phone && !c.email) out.problems.push('no phone or email');
    if (c.email && !looksLikeEmail(c.email)) out.problems.push('email "' + c.email + '" does not look right');

    const em = c.email.toLowerCase(), ph = phoneKey(c.phone);
    if (em && seenEmail.has(em)) out.problems.push('already in Recruitment (same email)');
    else if (ph.length === 10 && seenPhone.has(ph)) out.problems.push('already in Recruitment (same phone)');
    else if (em && inFileEmail.has(em)) out.problems.push('same email as row ' + inFileEmail.get(em));
    else if (ph.length === 10 && inFilePhone.has(ph)) out.problems.push('same phone as row ' + inFilePhone.get(ph));

    const st = STATUSES.find((s) => s.toLowerCase() === c.status.toLowerCase());
    if (!c.status) c.status = 'Applied';
    else if (st) c.status = st;
    else { out.notes.push('status "' + c.status + '" is not one of the list, saved as Applied'); c.status = 'Applied'; }

    if (c.resume && !/^https?:\/\//i.test(c.resume)) {
      out.notes.push('resume "' + c.resume.slice(0, 40) + '" is not a link, left blank');
      c.resume = '';
    }

    if (!out.problems.length) {
      if (em) inFileEmail.set(em, r);
      if (ph.length === 10) inFilePhone.set(ph, r);
    }
    rows.push(out);
  }
  return { sheet: ws.name, rows };
}

module.exports = { STATUSES, HEADERS, template, read };
