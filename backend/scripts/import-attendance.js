// ════════════════════════════════════════════════════════════════════════
//  import-attendance.js - brings the HR team's attendance sheet into the app,
//  once, so attendance can be kept in the app from then on.
//
//    node backend/scripts/import-attendance.js --sheet <id>            dry run
//    node backend/scripts/import-attendance.js --sheet <id> --apply    writes it
//
//  The sheet: a tab a month, row 2 the people (from column C), then a row a
//  day - the date in column B as dd/mm/yyyy, a status under each person. The
//  summary block under the days is counted, not copied: the page counts it
//  from the cells. Rows without a date (blank rows, the summary) are skipped.
//
//  People are matched by name and added in the sheet's order if new. A cell
//  the app already has is left alone, so running it again changes nothing
//  that was marked in the app.
// ════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const path = require('path');
const google = require(path.join(__dirname, '..', 'src', 'services', 'google'));
const { db } = require(path.join(__dirname, '..', 'src', 'db', 'pool'));

const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : ''; };
const APPLY = process.argv.includes('--apply');
const SHEET = arg('sheet');
const STATUSES = ['Present', 'Leave (Full Day)', 'Half Day', 'WFH', 'Holiday', 'Week off'];
const WHO = 'Imported from the sheet';

// "Present " and "present" are Present; anything else unknown is reported.
const statusOf = (v) => {
  const t = String(v || '').replace(/\s+/g, ' ').trim();
  return STATUSES.find(s => s.toLowerCase() === t.toLowerCase()) || (t ? null : '');
};
const ymd = (v) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v || '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};

(async () => {
  if (!SHEET) { console.log('Usage: --sheet <spreadsheet id> [--apply]'); process.exit(1); }
  const api = await google.getReadClient();
  const meta = await api.spreadsheets.get({ spreadsheetId: SHEET, fields: 'sheets.properties.title' });
  const tabs = meta.data.sheets.map(s => s.properties.title);

  const names = [];                 // every person, in the order the sheet first lists them
  const marks = [];                 // [name, day, status]
  const unknown = [];
  for (const tab of tabs) {
    const r = await api.spreadsheets.values.get({ spreadsheetId: SHEET, range: `'${tab.replace(/'/g, "''")}'!A1:Z80` });
    const rows = r.data.values || [];
    const people = (rows[1] || []).map((n, c) => [c, String(n || '').trim()]).filter(([c, n]) => c >= 2 && n);
    people.forEach(([, n]) => { if (!names.includes(n)) names.push(n); });
    let days = 0, cells = 0;
    for (const row of rows.slice(2)) {
      const day = ymd((row || [])[1]);
      if (!day) continue;
      days++;
      for (const [c, n] of people) {
        const s = statusOf(row[c]);
        if (s === null) { unknown.push(`${tab} ${day} ${n}: "${row[c]}"`); continue; }
        if (s) { marks.push([n, day, s]); cells++; }
      }
    }
    console.log(`  ${tab.padEnd(10)} ${days} days, ${people.length} people, ${cells} marks`);
  }
  console.log('People:', names.join(', '));
  unknown.forEach(u => console.log('  not a status, skipped - ' + u));

  const existing = new Map((await db.rows('SELECT id, name FROM att_people')).map(p => [p.name.toLowerCase(), p.id]));
  const newPeople = names.filter(n => !existing.has(n.toLowerCase()));
  console.log('New people to add:', newPeople.length ? newPeople.join(', ') : 'none');
  if (!APPLY) { console.log('\nDry run - nothing written. Add --apply.'); process.exit(0); }

  let pos = Number((await db.one('SELECT COALESCE(MAX(position), 0) p FROM att_people')).p);
  for (const n of newPeople) {
    const [ins] = await db.query('INSERT INTO att_people (name, position, active) VALUES (?,?,1)', [n, ++pos]);
    existing.set(n.toLowerCase(), ins.insertId);
  }
  let added = 0;
  for (let i = 0; i < marks.length; i += 300) {
    const part = marks.slice(i, i + 300);
    const [r] = await db.query(
      `INSERT IGNORE INTO att_marks (person_id, day, status, updated_by_name, updated_at)
       VALUES ${part.map(() => `(?,?,?, '${WHO}', UTC_TIMESTAMP())`).join(',')}`,
      part.flatMap(([n, day, s]) => [existing.get(n.toLowerCase()), day, s]));
    added += r.affectedRows;
  }
  console.log(`Imported ${added} marks (${marks.length - added} were already in the app and left alone).`);
  process.exit(0);
})().catch(e => { console.error('✗ import-attendance:', e.message); process.exit(1); });
