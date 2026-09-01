#!/usr/bin/env node
// ══════════════════════════════════════════════════════
// HR IMPORT — pulls the client's employee tracker sheet into hr_employees.
//
// Reads the sheet through its CSV export rather than the Sheets API: the export
// needs no credentials and, more to the point, no API quota — the app's Google
// project regularly sits at its per-minute read limit because of the FMS/Sales
// pages, and an import that fails for that reason is confusing to debug.
// The sheet must be link-shared ("anyone with the link can view").
//
// Matching is by name, normalised for case and spacing, because the sheet has
// no stable id and the same person is written "Meghal Mittal" there and
// "Meghal mittal" in the app.
//
//   node backend/scripts/import-hr-sheet.js --dry      # show what would change
//   node backend/scripts/import-hr-sheet.js            # insert + update
//   node backend/scripts/import-hr-sheet.js --prune    # ALSO delete anyone
//                                                      # absent from the sheet
//
// --prune is deliberately opt-in and never the default: the sheet holds fewer
// people than the app, so a stray run would wipe live employee records.
// ══════════════════════════════════════════════════════
const { db } = require('../src/db/pool');

const SHEET_ID = process.env.HR_SHEET_ID || '1J0C7dFF61rUlKQW2wA6yiiCrlGOy4rBr0La4sl4YZG0';
const GID = process.env.HR_SHEET_GID || '0';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

const DRY = process.argv.includes('--dry');
const PRUNE = process.argv.includes('--prune');

// ── CSV ───────────────────────────────────────────────
// Hand-rolled because the file has quoted fields containing commas AND real
// newlines (the header's "Official Email ID\n" is one), which a split(',') or a
// line-by-line reader both mangle.
function parseCsv(s) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── Dates ─────────────────────────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// The sheet is typed by hand, so the month arrives as "August", "august" or
// "Agust". Spelling is corrected before the three-letter lookup rather than
// after, so a typo does not silently become a null joining date.
const MONTH_TYPOS = { agust: 'august', augst: 'august', agsut: 'august', febuary: 'february', janurary: 'january' };

function monthNumber(word) {
  let w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  w = MONTH_TYPOS[w] || w;
  return MONTHS[w.slice(0, 3)] || null;
}

// "10August 2026", "19th May 2026", "1st august 2026" → "2026-08-10".
// Returns null when nothing sane can be read, and the caller reports it rather
// than storing a guess.
function parseLooseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const cleaned = s.toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')     // 19th → 19
    .replace(/(\d)([a-z])/g, '$1 $2')          // 10August → 10 August
    .replace(/([a-z])(\d)/g, '$1 $2');
  const m = cleaned.match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/)
         || cleaned.match(/([a-z]+)\s+(\d{1,2})\s+(\d{4})/);
  if (!m) return null;
  const dayFirst = /^\d/.test(m[1]);
  const day = parseInt(dayFirst ? m[1] : m[2], 10);
  const mon = monthNumber(dayFirst ? m[2] : m[1]);
  const year = parseInt(m[3], 10);
  if (!mon || !day || day > 31 || !year) return null;
  return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ── Column map ────────────────────────────────────────
// Sheet column index → hr_employees column. Column 23 ("Other fields that can
// be tracked/added") is deliberately absent: it holds a wishlist of future
// fields running down the column, not per-employee data, and importing it would
// staple "· Employment Type" onto whoever happened to share its row.
const MAP = [
  [0,  'full_name'],
  [1,  'employee_code'],
  [2,  'personal_phone'],
  [3,  'official_email'],
  [4,  'emergency_contact_phone'],
  [5,  'designation'],
  [6,  'department'],
  [7,  'kra'],
  [8,  'reporting_manager'],
  [9,  'work_location'],
  [10, 'offer_letter_date'],          // free text in the sheet, VARCHAR here
  [11, 'joining_date',        'date'],
  [12, 'probation_end_date',  'date'],
  [13, 'confirmation_date',   'date'],
  [14, 'appointment_nda_status'],
  [15, 'code_of_conduct_status'],
  [16, 'policy_handbook_status'],
  [17, 'bg_verification_status'],
  [18, 'employment_status'],
  [19, 'exit_date',           'date'],
  [20, 'record_log'],
  [21, 'performance_remarks'],
];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function main() {
  console.log(`Reading ${CSV_URL}\n`);
  const resp = await fetch(CSV_URL);
  if (!resp.ok) throw new Error(`sheet fetch failed: HTTP ${resp.status} — is it link-shared?`);
  const rows = parseCsv(await resp.text());
  const body = rows.slice(1).filter(r => (r[0] || '').trim());

  const existing = await db.rows('SELECT id, full_name FROM hr_employees');
  const byName = new Map(existing.map(e => [norm(e.full_name), e]));

  const dateWarnings = [];
  let inserted = 0, updated = 0;
  const seen = new Set();

  for (const r of body) {
    const rec = {};
    for (const [idx, col, kind] of MAP) {
      const raw = (r[idx] || '').trim();
      if (!raw) continue;
      if (kind === 'date') {
        const d = parseLooseDate(raw);
        if (!d) { dateWarnings.push(`${r[0].trim()} — ${col}: could not read "${raw}"`); continue; }
        rec[col] = d;
      } else rec[col] = raw;
    }
    if (!rec.full_name) continue;

    const match = byName.get(norm(rec.full_name));
    if (match) seen.add(match.id);

    if (DRY) {
      console.log(`${match ? 'UPDATE' : 'INSERT'}  ${rec.full_name}  (${Object.keys(rec).length} fields)`);
      continue;
    }

    if (match) {
      // Only the columns the sheet actually filled are written, so an empty cell
      // never blanks something already captured in the app.
      const cols = Object.keys(rec);
      await db.query(`UPDATE hr_employees SET ${cols.map(c => `${c}=?`).join(', ')} WHERE id=?`,
        [...cols.map(c => rec[c]), match.id]);
      updated++;
    } else {
      const cols = Object.keys(rec);
      await db.query(`INSERT INTO hr_employees (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        cols.map(c => rec[c]));
      inserted++;
    }
  }

  console.log(`\n${DRY ? '[dry run] ' : ''}inserted ${inserted}, updated ${updated}, sheet rows ${body.length}`);

  if (dateWarnings.length) {
    console.log('\nDates left empty because they could not be read:');
    dateWarnings.forEach(w => console.log('  ' + w));
  }

  const sheetNames = new Set(body.map(r => norm(r[0])));
  const extras = existing.filter(e => !sheetNames.has(norm(e.full_name)));
  if (extras.length) {
    console.log(`\n${extras.length} employee(s) in the app are NOT in the sheet:`);
    extras.forEach(e => console.log('  ' + e.full_name));
    if (PRUNE && !DRY) {
      await db.query(`DELETE FROM hr_employees WHERE id IN (${extras.map(() => '?').join(',')})`,
        extras.map(e => e.id));
      console.log(`\n--prune given — deleted all ${extras.length}.`);
    } else {
      console.log('\nLeft alone. Re-run with --prune to delete them.');
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
