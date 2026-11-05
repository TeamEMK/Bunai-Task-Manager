// ════════════════════════════════════════════════════════════════════════
//  import-brand-calendar.js - brings Aaheli's or Mulmul's content plan in
//  from their Google Sheet, once, into that brand's own calendar in the app.
//
//    node backend/scripts/import-brand-calendar.js --brand aaheli --sheet <id>            dry run
//    node backend/scripts/import-brand-calendar.js --brand aaheli --sheet <id> --apply    writes it
//
//  Their sheets share one layout (row 2 is the header): DATE, DAY, INSTAGRAM
//  STORIES, INSTA POST REFERENCE, FINAL POST, FACEBOOK, STATUS. Into the app's
//  shared columns:
//    INSTAGRAM STORIES     -> Insta Stories
//    FINAL POST            -> Instagram Post, with the reference under it as
//                             "Ref: ..." (a column of its own would show, empty,
//                             on Bunai's calendar too - the columns are shared)
//    FACEBOOK              -> Facebook
//    STATUS TRUE           -> every item that day ticked as done
//  "-" and empty cells are not plans. A row with no date is skipped and listed.
//
//  Run again, it only fills what is missing: a month the brand already has in
//  the app is left alone, so nothing typed in the app is overwritten.
// ════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const path = require('path');
const google = require(path.join(__dirname, '..', 'src', 'services', 'google'));
const { db } = require(path.join(__dirname, '..', 'src', 'db', 'pool'));

const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : ''; };
const APPLY = process.argv.includes('--apply');
const BRAND = arg('brand');
const SHEET = arg('sheet');
const WHO = 'Imported from the sheet';

const MON3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const isEmpty = (t) => /^(-+|\?+|na|n\/a)?$/i.test(String(t || '').trim());
const tidy = (t) => String(t || '').split(/\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

function ymd(text) {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(String(text || ''));
  if (!m) return null;
  const mi = MON3.indexOf(m[1].toLowerCase());
  return mi < 0 ? null : `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

// The column of each heading, found by its words rather than its letter.
function columns(header) {
  const find = (re) => (header || []).findIndex(h => re.test(String(h || '').replace(/\s+/g, ' ')));
  return {
    stories: find(/instagram stories/i),
    reference: find(/post reference/i),
    post: find(/final post/i),
    facebook: find(/facebook/i),
    status: find(/status/i),
  };
}

(async () => {
  if (!['aaheli', 'mulmul'].includes(BRAND) || !SHEET) {
    console.log('Usage: --brand aaheli|mulmul --sheet <spreadsheet id> [--apply]');
    process.exit(1);
  }
  const known = new Set((await db.rows('SELECT ch_key FROM content_calendar_channels')).map(r => r.ch_key));
  for (const k of ['insta-stories', 'instagram-post', 'facebook']) {
    if (!known.has(k)) throw new Error('The app has no "' + k + '" column.');
  }
  const have = new Set((await db.rows('SELECT ym FROM content_calendar_months WHERE brand = ?', [BRAND])).map(r => r.ym));

  const months = [];
  for (const { title } of await google.listTabs(SHEET)) {
    const rows = await google.readValues(SHEET, `'${title.replace(/'/g, "''")}'!A1:Z80`, { fresh: true });
    const c = columns(rows[1]);
    const items = [], done = [], skipped = [];
    let ym = null;
    for (let r = 2; r < rows.length; r++) {
      const row = rows[r] || [];
      const cell = (i) => (i >= 0 ? tidy(row[i]) : '');
      const date = ymd(row[0]);
      const plans = [];
      const stories = cell(c.stories);
      if (!isEmpty(stories)) plans.push(['insta-stories', stories]);
      const post = isEmpty(cell(c.post)) ? '' : cell(c.post);
      const ref = isEmpty(cell(c.reference)) ? '' : cell(c.reference);
      if (post || ref) plans.push(['instagram-post', [post, ref && 'Ref: ' + ref].filter(Boolean).join('\n')]);
      const fb = cell(c.facebook);
      if (!isEmpty(fb)) plans.push(['facebook', fb]);
      if (!date) {
        if (plans.length) skipped.push('row ' + (r + 1) + ': ' + plans.map(p => p[1].replace(/\n/g, ' ')).join(' | '));
        continue;
      }
      ym = ym || date.slice(0, 7);
      const ticked = /^true$/i.test(cell(c.status));
      for (const [ch, text] of plans) {
        items.push([BRAND, date, ch, text.slice(0, 2000)]);
        if (ticked) done.push([BRAND, date, ch, text]);
      }
    }
    months.push({ title, ym, items, done, skipped, skip: !ym || have.has(ym) });
  }

  console.log('Brand:', BRAND);
  for (const m of months) {
    console.log(`  ${m.title.padEnd(10)} -> ${m.ym || '?'}  ${m.items.length} items, ${m.done.length} ticked done`
      + (m.skip ? '  (already in the app - left alone)' : ''));
    m.skipped.forEach(s => console.log('      no date, skipped - ' + s));
  }
  if (!APPLY) { console.log('\nDry run - nothing written. Add --apply.'); process.exit(0); }

  for (const m of months) {
    if (m.skip) continue;
    await db.query('INSERT INTO content_calendar_months (brand, ym, created_by_name, created_at) VALUES (?,?,?, UTC_TIMESTAMP())',
      [BRAND, m.ym, WHO]);
    if (m.items.length) {
      await db.query(
        `INSERT INTO content_calendar_items (brand, day_date, channel, text, updated_by_name, updated_at)
         VALUES ${m.items.map(() => `(?,?,?,?, '${WHO}', UTC_TIMESTAMP())`).join(',')}`, m.items.flat());
    }
    if (m.done.length) {
      await db.query(
        `INSERT INTO content_calendar_done (brand, day_date, channel, item_text, done_by_name, done_at)
         VALUES ${m.done.map(() => `(?,?,?,?, '${WHO}', UTC_TIMESTAMP())`).join(',')}`, m.done.flat());
    }
    console.log('  imported', BRAND, m.ym, m.items.length, 'items,', m.done.length, 'ticked');
  }
  process.exit(0);
})().catch(e => { console.error('✗ import-brand-calendar:', e.message); process.exit(1); });
