// ════════════════════════════════════════════════════════════════════════
//  import-content-calendar.js — brings the marketing team's content plan in
//  from their Google Sheet ("Bunai Content Calendar"), once, so it can be kept
//  in the app from then on.
//
//    node backend/scripts/import-content-calendar.js            dry run
//    node backend/scripts/import-content-calendar.js --apply    writes it
//
//  Each month tab becomes a month, each day row its days, each column with a
//  header a channel. Columns are found by their header (row 2), not letter:
//  September's tab is laid out differently from October's. "-", "?" and
//  checkbox values are empty cells, not plans. A cell with several items run
//  together with a wide gap ("9 AM Quote      Blog Story") is kept one per line.
//
//  Run again, it only fills what is missing: a month already in the app is
//  left alone, so nothing typed in the app is overwritten by the sheet.
// ════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const path = require('path');
const config = require(path.join(__dirname, '..', 'src', 'config'));
const google = require(path.join(__dirname, '..', 'src', 'services', 'google'));
const { db } = require(path.join(__dirname, '..', 'src', 'db', 'pool'));

const APPLY = process.argv.includes('--apply');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const MON3 = MONTHS.map(m => m.slice(0, 3));

const isEmpty = (t) => /^(-+|\?+|false|true|na|n\/a)?$/i.test(String(t || '').trim());
const tidy = (t) => String(t || '').split(/\n|\s{3,}/).map(s => s.trim()).filter(Boolean).join('\n');

function ymd(text) {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(String(text || ''));
  if (!m) return null;
  const mi = MON3.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

// "INSTAGRAM POST" -> "Instagram Post"; a header used twice gets "(2)".
function channels(headerRow) {
  const out = [], seen = {};
  (headerRow || []).forEach((h, i) => {
    const raw = String(h || '').replace(/\s+/g, ' ').trim();
    if (i < 2 || !raw) return;
    const name = raw.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
      .replace(/^Youtube/, 'YouTube').replace(/^Whatsapp/, 'WhatsApp');
    seen[name] = (seen[name] || 0) + 1;
    let label = seen[name] > 1 ? name + ' (' + seen[name] + ')' : name;
    // September had one Instagram column; from October it is split into Post
    // and Stories. Its single column is the post one.
    if (label === 'Instagram') label = 'Instagram Post';
    out.push({ col: i, key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), label });
  });
  return out;
}

(async () => {
  const id = config.sheets.contentCalendar.id;
  const tabs = (await google.listTabs(id)).map(t => t.title)
    .filter(t => MONTHS.includes(t.trim().toLowerCase().split(/\s+/)[0]));
  const haveMonths = new Set((await db.rows('SELECT ym FROM content_calendar_months')).map(r => r.ym));

  const chanOrder = new Map();     // key -> {label, position}
  const months = [];
  let newest = null;               // the latest month's columns set the order
  for (const tab of tabs) {
    const rows = await google.readValues(id, `'${tab.replace(/'/g, "''")}'!A1:AZ80`, { fresh: true });
    const chans = channels(rows[1]);
    chans.forEach(c => { if (!chanOrder.has(c.key)) chanOrder.set(c.key, { label: c.label, position: 0 }); });
    const items = [];
    let ym = null;
    for (let r = 2; r < rows.length; r++) {
      const date = ymd((rows[r] || [])[0]);
      if (!date) continue;
      ym = ym || date.slice(0, 7);
      for (const c of chans) {
        const text = tidy((rows[r] || [])[c.col]);
        if (!isEmpty(text)) items.push([date, c.key, text]);
      }
    }
    months.push({ tab, ym, items, skip: haveMonths.has(ym) });
    if (ym && (!newest || ym > newest.ym)) newest = { ym, chans };
  }
  // Columns in the order the latest month lays them out; any it lacks after.
  let pos = 0;
  (newest ? newest.chans : []).forEach(c => { chanOrder.get(c.key).position = ++pos; });
  for (const c of chanOrder.values()) if (!c.position) c.position = ++pos;

  console.log('Channels:', [...chanOrder.values()].sort((a, b) => a.position - b.position).map(c => c.label).join(' | '));
  months.forEach(m => console.log(`  ${m.tab.padEnd(10)} -> ${m.ym}  ${m.items.length} items${m.skip ? '  (already in the app, left alone)' : ''}`));
  if (!APPLY) { console.log('\nDry run - nothing written. Add --apply.'); process.exit(0); }

  for (const [key, c] of chanOrder) {
    await db.query(
      `INSERT INTO content_calendar_channels (ch_key, label, position) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE label = label`, [key, c.label, c.position]);
  }
  for (const m of months) {
    if (m.skip || !m.ym) continue;
    await db.query('INSERT INTO content_calendar_months (ym, created_by_name, created_at) VALUES (?, ?, UTC_TIMESTAMP())',
      [m.ym, 'Imported from the sheet']);
    for (let i = 0; i < m.items.length; i += 300) {
      const part = m.items.slice(i, i + 300);
      await db.query(
        `INSERT INTO content_calendar_items (day_date, channel, text, updated_by_name, updated_at)
         VALUES ${part.map(() => '(?,?,?, \'Imported from the sheet\', UTC_TIMESTAMP())').join(',')}`, part.flat());
    }
    console.log('  imported', m.ym, m.items.length, 'items');
  }
  process.exit(0);
})().catch(e => { console.error('✗ import-content-calendar:', e.message); process.exit(1); });
