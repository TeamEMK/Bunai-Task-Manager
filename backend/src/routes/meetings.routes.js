// ══════════════════════════════════════════════════════
// MEETINGS + availability grid.
// Two things are deliberately absent: Google-Meet auto-link creation (needs
// Workspace domain-wide delegation this project is not set up for — paste a
// link instead) and WhatsApp invites (the queue cannot survive a serverless
// request). Scheduling, availability, recurrence and attendees are all here.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const { isYmd, isLastSaturdayOfMonth } = require('../utils/dates');
const { placeholders, groupBy } = require('../utils/collections');
const { loadHolidaysSet } = require('../services/holidays');

const router = express.Router();

// Working window for the availability grid, in minutes from midnight, so a
// half-hour start (8:30) is expressible. The last slot ends exactly at endMin.
const BIZ_HOURS = { startMin: 8 * 60 + 30, endMin: 19 * 60, slotMin: 30 };

// Builds the half-hour grid for a day and marks what is taken.
// A slot counts as "booked" only when the VIEWER is in that meeting — other
// people's calendars must not grey out your own. busyUserIds is still recorded
// for everyone, so the attendee picker can warn about clashes.
async function buildMeetingSlots(dateStr, userIds = [], viewerId = null) {
  const slots = [];
  const { startMin, endMin, slotMin } = BIZ_HOURS;
  const hhmm = t => String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  for (let t = startMin; t + slotMin <= endMin; t += slotMin) {
    slots.push({ start: hhmm(t), end: hhmm(t + slotMin), booked: false, busyUserIds: [] });
  }

  const meetings = await db.rows(
    `SELECT m.id, m.title, TIME_FORMAT(m.start_time,'%H:%i') AS start_time,
            TIME_FORMAT(m.end_time,'%H:%i') AS end_time, m.organizer_id
       FROM meetings m
      WHERE m.meeting_date = ? AND m.status = 'scheduled'`, [dateStr]);

  const busyRanges = {};
  if (meetings.length) {
    const mIds = meetings.map(m => m.id);
    const attendees = await db.rows(
      `SELECT meeting_id, user_id FROM meeting_attendees WHERE meeting_id IN (${placeholders(mIds)})`, mIds);
    const attByMtg = groupBy(attendees, 'meeting_id');
    const selected = new Set(userIds);

    for (const m of meetings) {
      const involved = new Set([m.organizer_id, ...(attByMtg.get(m.id) || []).map(a => a.user_id)]);
      const viewerInvolved = viewerId != null && involved.has(viewerId);
      for (const slot of slots) {
        if (slot.start < m.end_time && slot.end > m.start_time) {
          if (viewerInvolved) slot.booked = true;
          for (const uid of involved) if (!slot.busyUserIds.includes(uid)) slot.busyUserIds.push(uid);
        }
      }
      for (const uid of involved) {
        if (userIds.length && !selected.has(uid)) continue;
        (busyRanges[uid] = busyRanges[uid] || []).push({ start: m.start_time, end: m.end_time, title: m.title });
      }
    }
    if (userIds.length) {
      for (const slot of slots) slot.conflictForSelection = slot.busyUserIds.some(uid => selected.has(uid));
    }
  } else if (userIds.length) {
    for (const slot of slots) slot.conflictForSelection = false;
  }
  return { slots, busyRanges };
}

// Expands a recurrence rule into dates. Capped so a mistyped "repeat until
// 2099" cannot spawn thousands of rows.
const RECURRENCE_MAX_OCCURRENCES = 120;
function generateRecurrenceDates(startDateStr, frequency, untilStr, customDays) {
  const start = new Date(startDateStr + 'T00:00:00Z');
  const until = new Date(untilStr + 'T00:00:00Z');
  const dates = [];
  if (until < start) return dates;

  if (frequency === 'monthly') {
    const cur = new Date(start);
    while (cur <= until && dates.length < RECURRENCE_MAX_OCCURRENCES) {
      dates.push(cur.toISOString().split('T')[0]);
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    return dates;
  }

  const customSet = new Set((customDays || []).map(d => parseInt(d, 10)));
  const startDow = start.getUTCDay();
  const cur = new Date(start);
  while (cur <= until && dates.length < RECURRENCE_MAX_OCCURRENCES) {
    const dow = cur.getUTCDay();
    let include = false;
    if (frequency === 'daily') include = true;
    else if (frequency === 'weekday') include = dow !== 0;
    else if (frequency === 'weekly') include = dow === startDow;
    else if (frequency === 'custom') include = customSet.has(dow);
    if (include) dates.push(cur.toISOString().split('T')[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// Only the organiser or an admin may change a meeting.
async function assertCanWrite(id, req) {
  const m = await db.one('SELECT id, organizer_id FROM meetings WHERE id=?', [id]);
  if (!m) throw httpError(404, 'Meeting not found');
  if (m.organizer_id !== req.session.userId && req.session.role !== 'admin') {
    throw httpError(403, 'Only the organiser or an admin can change this meeting');
  }
  return m;
}

const cleanIds = (list) => (Array.isArray(list) ? list : [])
  .map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0);

// GET — meetings the caller organises or is invited to.
router.get('/meetings', requireAuth, asyncRoute(async (req, res) => {
  const uid = req.session.userId;
  const { from, to, status, organizer } = req.query;
  // Admin oversees every meeting; everyone else sees only their own.
  const isAdmin = req.session.role === 'admin';
  let where = isAdmin ? '1=1' : `(m.organizer_id = ? OR EXISTS
    (SELECT 1 FROM meeting_attendees ma WHERE ma.meeting_id = m.id AND ma.user_id = ?))`;
  const params = isAdmin ? [] : [uid, uid];
  if (isYmd(from)) { where += ' AND m.meeting_date >= ?'; params.push(from); }
  if (isYmd(to)) { where += ' AND m.meeting_date <= ?'; params.push(to); }
  if (status) { where += ' AND m.status = ?'; params.push(status); }
  if (organizer && organizer !== 'all') { where += ' AND m.organizer_id = ?'; params.push(organizer); }

  const rows = await db.rows(
    `SELECT m.id, m.title, m.agenda, m.client_id, m.organizer_id,
            DATE_FORMAT(m.meeting_date,'%Y-%m-%d') AS meeting_date,
            TIME_FORMAT(m.start_time,'%H:%i') AS start_time,
            TIME_FORMAT(m.end_time,'%H:%i')   AS end_time,
            m.meet_link, m.status, m.created_at,
            c.name AS client_name, u.name AS organizer_name
       FROM meetings m
       LEFT JOIN clients c ON m.client_id = c.id
       LEFT JOIN users   u ON m.organizer_id = u.id
      WHERE ${where}
      ORDER BY m.meeting_date ASC, m.start_time ASC
      LIMIT 500`, params);

  // Attendees in one extra query rather than one per meeting.
  if (rows.length) {
    const ids = rows.map(r => r.id);
    const atts = await db.rows(
      `SELECT ma.meeting_id, ma.user_id, u.name
         FROM meeting_attendees ma JOIN users u ON ma.user_id = u.id
        WHERE ma.meeting_id IN (${placeholders(ids)})`, ids);
    const byMtg = groupBy(atts, 'meeting_id');
    for (const r of rows) r.attendees = (byMtg.get(r.id) || []).map(a => ({ id: a.user_id, name: a.name }));
  }
  res.json(rows);
}));

// GET — availability grid for one date. Registered before /meetings/:id so
// "slots" is not read as an id.
router.get('/meetings/slots', requireAuth, asyncRoute(async (req, res) => {
  const date = req.query.date;
  if (!isYmd(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
  const userIds = String(req.query.userIds || '')
    .split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n > 0);

  const holidays = await loadHolidaysSet();
  const d = new Date(date + 'T00:00:00Z');
  let offReason = null;
  if (d.getUTCDay() === 0) offReason = 'Sunday';
  else if (isLastSaturdayOfMonth(date)) offReason = 'Last Saturday (off)';
  else if (holidays.has(date)) offReason = 'Holiday';
  if (offReason) return res.json({ date, off: true, reason: offReason, slots: [], busyRanges: {} });

  const { slots, busyRanges } = await buildMeetingSlots(date, userIds, req.session.userId);
  res.json({ date, off: false, slots, busyRanges });
}));

router.get('/meetings/:id', requireAuth, asyncRoute(async (req, res) => {
  const [m, atts] = await Promise.all([
    db.one(
      `SELECT m.id, m.title, m.agenda, m.client_id, m.organizer_id,
              DATE_FORMAT(m.meeting_date,'%Y-%m-%d') AS meeting_date,
              TIME_FORMAT(m.start_time,'%H:%i') AS start_time,
              TIME_FORMAT(m.end_time,'%H:%i')   AS end_time,
              m.meet_link, m.status,
              c.name AS client_name, u.name AS organizer_name
         FROM meetings m
         LEFT JOIN clients c ON m.client_id = c.id
         LEFT JOIN users   u ON m.organizer_id = u.id
        WHERE m.id = ?`, [req.params.id]),
    db.rows(
      `SELECT u.id, u.name, u.email FROM meeting_attendees ma
         JOIN users u ON ma.user_id = u.id WHERE ma.meeting_id = ?`, [req.params.id]),
  ]);
  if (!m) throw httpError(404, 'Meeting not found');
  m.attendees = atts;
  res.json(m);
}));

// POST — one meeting, or a whole recurring series.
router.post('/meetings', requireAuth, asyncRoute(async (req, res) => {
  const { title, agenda, client_id, meeting_date, start_time, end_time, meet_link,
          attendee_ids, frequency, repeat_until, repeat_days } = req.body;
  if (!title || !meeting_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'Title, date, start time and end time are required' });
  }
  if (end_time <= start_time) return res.status(400).json({ error: 'End time must be after the start time' });

  const organizerId = req.session.userId;
  const freq = ['daily', 'weekday', 'weekly', 'monthly', 'custom'].includes(frequency) ? frequency : null;
  let occurrenceDates = [meeting_date];
  if (freq) {
    if (!repeat_until) return res.status(400).json({ error: 'Pick a "repeat until" date for a recurring meeting' });
    if (freq === 'custom' && !(Array.isArray(repeat_days) && repeat_days.length)) {
      return res.status(400).json({ error: 'Select at least one day to repeat on' });
    }
    occurrenceDates = generateRecurrenceDates(meeting_date, freq, repeat_until, repeat_days);
    if (!occurrenceDates.length) return res.status(400).json({ error: 'No occurrences fall in the selected range' });
  }

  const attIds = cleanIds(attendee_ids);
  const newIds = [];
  for (const dateStr of occurrenceDates) {
    const [r] = await db.query(
      `INSERT INTO meetings (title, agenda, client_id, organizer_id, meeting_date, start_time, end_time, meet_link)
       VALUES (?,?,?,?,?,?,?,?)`,
      [title, agenda || null, client_id || null, organizerId, dateStr, start_time, end_time, meet_link || null]);
    newIds.push(r.insertId);
  }
  // All attendees of all occurrences in ONE insert — a 120-occurrence series
  // with 8 invitees used to be 960 separate statements.
  if (attIds.length && newIds.length) {
    const values = [];
    for (const mid of newIds) for (const uid of attIds) values.push([mid, uid]);
    await db.query('INSERT IGNORE INTO meeting_attendees (meeting_id, user_id) VALUES ?', [values]);
  }
  res.json({ ok: true, id: newIds[0], count: newIds.length });
}));

// PUT — edit a meeting and replace its attendee list.
router.put('/meetings/:id', requireAuth, asyncRoute(async (req, res) => {
  const id = req.params.id;
  await assertCanWrite(id, req);
  const { title, agenda, client_id, meeting_date, start_time, end_time, meet_link, attendee_ids } = req.body;
  if (!title || !meeting_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'Title, date, start time and end time are required' });
  }
  if (end_time <= start_time) return res.status(400).json({ error: 'End time must be after the start time' });

  await db.query(
    `UPDATE meetings SET title=?, agenda=?, client_id=?, meeting_date=?, start_time=?, end_time=?, meet_link=?
      WHERE id=?`,
    [title, agenda || null, client_id || null, meeting_date, start_time, end_time, meet_link || null, id]);

  if (Array.isArray(attendee_ids)) {
    await db.query('DELETE FROM meeting_attendees WHERE meeting_id=?', [id]);
    const ids = cleanIds(attendee_ids);
    if (ids.length) {
      await db.query('INSERT IGNORE INTO meeting_attendees (meeting_id, user_id) VALUES ?',
        [ids.map(uid => [id, uid])]);
    }
  }
  res.json({ ok: true });
}));

// PUT — scheduled / done / cancelled. The Employee 360 meetings score is
// done/total, so this is what moves that number.
router.put('/meetings/:id/status', requireAuth, asyncRoute(async (req, res) => {
  const { status } = req.body;
  if (!['scheduled', 'done', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  await assertCanWrite(req.params.id, req);
  await db.query('UPDATE meetings SET status=? WHERE id=?', [status, req.params.id]);
  res.json({ ok: true });
}));

// DELETE — cancels rather than removes, so the history stays in the scorecard.
router.delete('/meetings/:id', requireAuth, asyncRoute(async (req, res) => {
  await assertCanWrite(req.params.id, req);
  await db.query("UPDATE meetings SET status='cancelled' WHERE id=?", [req.params.id]);
  res.json({ ok: true });
}));

module.exports = router;
