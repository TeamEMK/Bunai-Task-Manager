// ══════════════════════════════════════════════════════
// CONTENT CALENDAR (/api/content-calendar)
//
// The brand's content plan: a month at a time, a row a day, a column a channel
// (Instagram post and stories, influencer, Facebook, YouTube, blog, newsletter
// ...), each cell saying what goes out that day - and a tick for whether it
// did.
//
// It started life as the marketing team's Google Sheet and was brought in from
// there once (scripts/import-content-calendar.js); the plan is written here
// now. A new month is made blank, or from the pattern of another month: each
// day takes what the same weekday held in that month (1st Monday from 1st
// Monday), for the channels chosen - the daily posts repeat, a festival
// creative or an influencer's name does not.
//
// A tick belongs to a day and a channel, not to a cell's words, so rewording a
// plan keeps it; the words it was ticked against are kept beside it.
// ══════════════════════════════════════════════════════
const express = require('express');
const config = require('../config');
const { db } = require('../db/pool');
const { requireAuth, requirePage } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();
const page = requirePage('contentcal');

const isYm = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isKey = (v) => /^[a-z0-9-]{1,60}$/.test(String(v || ''));
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

// Every date of a month, "2026-11" -> ["2026-11-01", ... "2026-11-30"].
function datesOf(ym) {
  const [y, m] = ym.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
}
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function whoAmI(req) {
  const me = await db.one('SELECT name FROM users WHERE id = ?', [req.session.userId]);
  return (me && me.name) || req.session.name || '';
}

router.get('/content-calendar', requireAuth, page, asyncRoute(async (req, res) => {
  const months = (await db.rows('SELECT ym FROM content_calendar_months ORDER BY ym')).map(r => r.ym);
  const channels = await db.rows('SELECT ch_key AS `key`, label FROM content_calendar_channels ORDER BY position, ch_key');
  const today = todayIst();
  const trackFrom = config.sheets.contentCalendar.trackFrom;
  if (!months.length) return res.json({ today, trackFrom, months, month: null, channels, days: [] });

  // The month asked for, else this month if it exists, else the latest.
  const want = String(req.query.month || '');
  const month = months.includes(want) ? want : months.includes(today.slice(0, 7)) ? today.slice(0, 7) : months[months.length - 1];
  const dates = datesOf(month);
  const range = [dates[0], dates[dates.length - 1]];

  const [items, ticks] = await Promise.all([
    db.rows(`SELECT DATE_FORMAT(day_date, '%Y-%m-%d') d, channel, text
               FROM content_calendar_items WHERE day_date BETWEEN ? AND ?`, range),
    db.rows(`SELECT DATE_FORMAT(day_date, '%Y-%m-%d') d, channel, item_text, done_by_name,
                    DATE_FORMAT(done_at + INTERVAL 330 MINUTE, '%e %b, %l:%i %p') at
               FROM content_calendar_done WHERE day_date BETWEEN ? AND ?`, range),
  ]);
  const tick = {};
  ticks.forEach(t => { tick[t.d + '|' + t.channel] = t; });
  const byDay = {};
  items.forEach(i => {
    const t = tick[i.d + '|' + i.channel];
    (byDay[i.d] = byDay[i.d] || []).push({
      channel: i.channel, text: i.text,
      done: t ? { by: t.done_by_name, at: t.at, changed: t.item_text !== i.text } : null,
    });
  });
  res.json({
    today, trackFrom, months, month, channels,
    days: dates.map(d => ({ date: d, day: WEEKDAYS[weekday(d)], items: byDay[d] || [] })),
  });
}));

// Write one cell. Blank text clears it.
router.put('/content-calendar/item', requireAuth, page, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!isYmd(b.date)) throw httpError(400, 'Bad date.');
  if (!isKey(b.channel)) throw httpError(400, 'Bad channel.');
  if (!(await db.one('SELECT 1 n FROM content_calendar_channels WHERE ch_key = ?', [b.channel]))) {
    throw httpError(400, 'Unknown channel.');
  }
  if (!(await db.one('SELECT 1 n FROM content_calendar_months WHERE ym = ?', [b.date.slice(0, 7)]))) {
    throw httpError(400, 'That month has not been made yet. Use + New month first.');
  }
  const text = String(b.text || '').replace(/\r\n/g, '\n').trim().slice(0, 2000);
  if (!text) {
    await db.query('DELETE FROM content_calendar_items WHERE day_date = ? AND channel = ?', [b.date, b.channel]);
  } else {
    await db.query(
      `INSERT INTO content_calendar_items (day_date, channel, text, updated_by_name, updated_at)
       VALUES (?,?,?,?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE text = VALUES(text), updated_by_name = VALUES(updated_by_name),
                               updated_at = UTC_TIMESTAMP()`,
      [b.date, b.channel, text, await whoAmI(req)]);
  }
  res.json({ success: true });
}));

// Many cells at once: for the channels and dates chosen, replace what is
// planned, add a line to it, or clear it. "Add" skips a cell that already has
// that exact line, so applying it twice does not write it twice.
router.put('/content-calendar/bulk', requireAuth, page, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!isYm(b.month)) throw httpError(400, 'Bad month.');
  if (!(await db.one('SELECT 1 n FROM content_calendar_months WHERE ym = ?', [b.month]))) {
    throw httpError(400, 'That month has not been made yet.');
  }
  const action = String(b.action || '');
  if (!['set', 'add', 'clear'].includes(action)) throw httpError(400, 'Choose Replace, Add or Clear.');
  const known = new Set((await db.rows('SELECT ch_key FROM content_calendar_channels')).map(r => r.ch_key));
  const channels = [...new Set((Array.isArray(b.channels) ? b.channels : []).filter(c => known.has(c)))];
  if (!channels.length) throw httpError(400, 'Choose at least one channel.');
  const inMonth = new Set(datesOf(b.month));
  const dates = [...new Set((Array.isArray(b.dates) ? b.dates : []).filter(d => inMonth.has(d)))];
  if (!dates.length) throw httpError(400, 'Choose at least one date.');
  const text = String(b.text || '').replace(/\r\n/g, '\n').trim().slice(0, 2000);
  if (action !== 'clear' && !text) throw httpError(400, 'Write what to put in.');

  let changed = 0;
  if (action === 'clear') {
    const [r] = await db.query('DELETE FROM content_calendar_items WHERE day_date IN (?) AND channel IN (?)', [dates, channels]);
    changed = r.affectedRows;
  } else {
    const name = await whoAmI(req);
    const have = await db.rows(
      `SELECT DATE_FORMAT(day_date, '%Y-%m-%d') d, channel, text FROM content_calendar_items
        WHERE day_date IN (?) AND channel IN (?)`, [dates, channels]);
    const cur = Object.fromEntries(have.map(h => [h.d + '|' + h.channel, h.text]));
    const rows = [];
    for (const d of dates) for (const c of channels) {
      const old = cur[d + '|' + c];
      let next = text;
      if (action === 'add' && old) {
        if (old.split('\n').some(l => l.trim().toLowerCase() === text.toLowerCase())) continue;
        next = (old + '\n' + text).slice(0, 2000);
      }
      if (next === old) continue;
      rows.push([d, c, next, name]);
    }
    for (let i = 0; i < rows.length; i += 300) {
      const part = rows.slice(i, i + 300);
      await db.query(
        `INSERT INTO content_calendar_items (day_date, channel, text, updated_by_name, updated_at)
         VALUES ${part.map(() => '(?,?,?,?, UTC_TIMESTAMP())').join(',')}
         ON DUPLICATE KEY UPDATE text = VALUES(text), updated_by_name = VALUES(updated_by_name),
                                 updated_at = UTC_TIMESTAMP()`, part.flat());
    }
    changed = rows.length;
  }
  res.json({ changed });
}));

// Make a month: blank, or from another month's weekday pattern for the
// channels named.
router.post('/content-calendar/months', requireAuth, page, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!isYm(b.month)) throw httpError(400, 'Choose a month.');
  if (b.copyFrom && !isYm(b.copyFrom)) throw httpError(400, 'Bad month to copy from.');
  if (await db.one('SELECT 1 n FROM content_calendar_months WHERE ym = ?', [b.month])) {
    throw httpError(409, 'That month already exists.');
  }
  const name = await whoAmI(req);

  // Worked out before the month is created, so a failure leaves nothing behind.
  const out = [];
  if (b.copyFrom) {
    const want = (Array.isArray(b.channels) ? b.channels : []).filter(isKey);
    const src = datesOf(b.copyFrom);
    const rows = want.length ? await db.rows(
      `SELECT DATE_FORMAT(day_date, '%Y-%m-%d') d, channel, text FROM content_calendar_items
        WHERE day_date BETWEEN ? AND ? AND channel IN (?)`, [src[0], src[src.length - 1], want]) : [];
    const plan = {};
    rows.forEach(r => { (plan[r.d] = plan[r.d] || []).push(r); });
    // The n-th of each weekday in the source month. A 5th Monday with no 5th
    // Monday to copy from takes the 4th.
    const nth = {};
    src.forEach(d => { const w = weekday(d); (nth[w] = nth[w] || []).push(d); });
    for (const d of datesOf(b.month)) {
      const list = nth[weekday(d)] || [];
      const from = list[Math.min(Math.ceil(Number(d.slice(8)) / 7) - 1, list.length - 1)];
      (plan[from] || []).forEach(r => out.push([d, r.channel, r.text, name]));
    }
  }

  await db.query('INSERT INTO content_calendar_months (ym, created_by_name, created_at) VALUES (?,?, UTC_TIMESTAMP())',
    [b.month, name]);
  for (let i = 0; i < out.length; i += 300) {
    const part = out.slice(i, i + 300);
    await db.query(
      `INSERT INTO content_calendar_items (day_date, channel, text, updated_by_name, updated_at)
       VALUES ${part.map(() => '(?,?,?,?, UTC_TIMESTAMP())').join(',')}`, part.flat());
  }
  res.json({ month: b.month, copied: out.length });
}));

// Remove a month, with everything planned and ticked in it.
router.delete('/content-calendar/months/:ym', requireAuth, page, asyncRoute(async (req, res) => {
  const ym = String(req.params.ym);
  if (!isYm(ym)) throw httpError(400, 'Bad month.');
  const d = datesOf(ym);
  await db.query('DELETE FROM content_calendar_items WHERE day_date BETWEEN ? AND ?', [d[0], d[d.length - 1]]);
  await db.query('DELETE FROM content_calendar_done WHERE day_date BETWEEN ? AND ?', [d[0], d[d.length - 1]]);
  await db.query('DELETE FROM content_calendar_months WHERE ym = ?', [ym]);
  res.json({ success: true });
}));

// Tick or untick one item. The text is sent so the tick remembers what it was
// ticked against.
router.post('/content-calendar/done', requireAuth, page, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!isYmd(b.date)) throw httpError(400, 'Bad date.');
  if (!isKey(b.channel)) throw httpError(400, 'Bad channel.');
  if (b.done) {
    await db.query(
      `INSERT INTO content_calendar_done (day_date, channel, item_text, done_by, done_by_name, done_at)
       VALUES (?,?,?,?,?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE item_text=VALUES(item_text), done_by=VALUES(done_by),
                               done_by_name=VALUES(done_by_name), done_at=UTC_TIMESTAMP()`,
      [b.date, b.channel, String(b.text || '').slice(0, 2000), req.session.userId, await whoAmI(req)]);
  } else {
    await db.query('DELETE FROM content_calendar_done WHERE day_date = ? AND channel = ?', [b.date, b.channel]);
  }
  res.json({ success: true });
}));

module.exports = router;
