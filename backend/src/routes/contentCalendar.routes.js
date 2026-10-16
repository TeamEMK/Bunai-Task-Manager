// ══════════════════════════════════════════════════════
// CONTENT CALENDAR (/api/content-calendar)
//
// The brand's content plan lives in the marketing team's Google Sheet: a tab a
// month, a row a day, a column a channel (Instagram post, stories, influencer,
// Facebook, YouTube, blog, newsletter ...), each cell saying what goes out.
// The sheet stays where the plan is written. This reads it as it is, and adds
// the one thing a sheet of plans does not have: whether each item went out.
//
// A tick belongs to a day and a channel, not to a cell's text, so editing the
// wording in the sheet does not lose it. The text it was ticked against is kept
// beside it, so a plan that changed after the tick can be told apart.
//
// Columns are found by their header (row 2), never by letter: September's tab
// is laid out differently from October's, and the team adds columns.
// ══════════════════════════════════════════════════════
const express = require('express');
const config = require('../config');
const google = require('../services/google');
const { db } = require('../db/pool');
const { requireAuth, requirePage } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();
const page = requirePage('contentcal');
const sheetId = () => config.sheets.contentCalendar.id;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const MON3 = MONTHS.map(m => m.slice(0, 3));

// What a cell holds when nothing is planned for that channel that day.
const isEmpty = (t) => /^(-+|\?+|false|true|na|n\/a)?$/i.test(String(t || '').trim());

// "INSTAGRAM POST" -> "Instagram Post"; a header used twice gets "(2)".
function channels(headerRow) {
  const out = [], seen = {};
  (headerRow || []).forEach((h, i) => {
    const raw = String(h || '').replace(/\s+/g, ' ').trim();
    if (i < 2 || !raw) return;                     // A = date, B = day
    const name = raw.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
      .replace(/^Youtube/, 'YouTube').replace(/^Whatsapp/, 'WhatsApp');
    seen[name] = (seen[name] || 0) + 1;
    const label = seen[name] > 1 ? name + ' (' + seen[name] + ')' : name;
    out.push({ col: i, key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), label });
  });
  return out;
}

// "Oct 01, 2026" -> "2026-10-01". The sheet shows dates formatted, and reading
// the formatted text is what keeps a date from coming back as a serial number.
function ymd(text) {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(String(text || ''));
  if (!m) return null;
  const mi = MON3.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

// A cell often holds two or three items run together with a wide gap between
// them ("9 AM Quote             Blog Story"); shown one per line.
const tidy = (t) => String(t || '').split(/\n|\s{3,}/).map(s => s.trim()).filter(Boolean).join('\n');

async function monthTabs() {
  const tabs = await google.listTabs(sheetId());
  return tabs.map(t => ({ title: t.title, month: MONTHS.indexOf(t.title.trim().toLowerCase().split(/\s+/)[0]) }))
    .filter(t => t.month >= 0);
}

router.get('/content-calendar', requireAuth, page, asyncRoute(async (req, res) => {
  if (!sheetId()) throw httpError(400, 'No content calendar sheet is set (CONTENT_CALENDAR_SHEET_ID).');
  let tabs;
  // Refresh also forgets the tab list, so a new month's tab shows up at once.
  if (req.query.fresh === '1') google.forgetTabs(sheetId());
  try { tabs = await monthTabs(); }
  catch (e) {
    throw httpError(502, 'Could not open the content calendar sheet: ' + String(e.message || e).slice(0, 160)
      + '. It must be shared with ' + (google.serviceAccountEmail() || 'the service account') + '.');
  }
  if (!tabs.length) throw httpError(404, 'The sheet has no month tabs (September, October ...).');

  // The month asked for, else this month if it has a tab, else the last one.
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const want = String(req.query.tab || '');
  const thisMonth = Number(today.slice(5, 7)) - 1;
  const tab = tabs.find(t => t.title === want) || tabs.find(t => t.month === thisMonth) || tabs[tabs.length - 1];

  const rows = await google.readValues(sheetId(), `'${tab.title.replace(/'/g, "''")}'!A1:AZ80`, { fresh: req.query.fresh === '1' });
  const chans = channels(rows[1]);
  const days = [];
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] || [];
    const date = ymd(row[0]);
    if (!date) continue;
    const items = [];
    for (const c of chans) {
      const text = tidy(row[c.col]);
      if (!isEmpty(text)) items.push({ channel: c.key, text });
    }
    days.push({ date, day: String(row[1] || '').trim(), items });
  }

  const done = days.length ? await db.rows(
    `SELECT DATE_FORMAT(day_date, '%Y-%m-%d') d, channel, item_text, done_by_name,
            DATE_FORMAT(done_at + INTERVAL 330 MINUTE, '%e %b, %l:%i %p') at
       FROM content_calendar_done WHERE day_date BETWEEN ? AND ?`,
    [days[0].date, days[days.length - 1].date]) : [];
  const ticks = {};
  done.forEach(d => { ticks[d.d + '|' + d.channel] = { by: d.done_by_name, at: d.at, text: d.item_text }; });
  days.forEach(d => d.items.forEach(i => {
    const t = ticks[d.date + '|' + i.channel];
    if (t) i.done = { by: t.by, at: t.at, changed: t.text !== i.text };
  }));

  res.json({
    today, trackFrom: config.sheets.contentCalendar.trackFrom, tabs: tabs.map(t => t.title), tab: tab.title,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId()}/edit`,
    channels: chans.map(({ key, label }) => ({ key, label })), days,
  });
}));

// Tick or untick one item. The text is sent so the tick remembers what it was
// ticked against.
router.post('/content-calendar/done', requireAuth, page, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, 'Bad date.');
  const channel = String(b.channel || '').slice(0, 60);
  if (!/^[a-z0-9-]+$/.test(channel)) throw httpError(400, 'Bad channel.');
  if (b.done) {
    const me = await db.one('SELECT name FROM users WHERE id = ?', [req.session.userId]);
    await db.query(
      `INSERT INTO content_calendar_done (day_date, channel, item_text, done_by, done_by_name, done_at)
       VALUES (?,?,?,?,?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE item_text=VALUES(item_text), done_by=VALUES(done_by),
                               done_by_name=VALUES(done_by_name), done_at=UTC_TIMESTAMP()`,
      [date, channel, String(b.text || '').slice(0, 2000), req.session.userId, (me && me.name) || req.session.name || '']);
  } else {
    await db.query('DELETE FROM content_calendar_done WHERE day_date = ? AND channel = ?', [date, channel]);
  }
  res.json({ success: true });
}));

module.exports = router;
