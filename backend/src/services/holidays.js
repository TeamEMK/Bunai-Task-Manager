// ══════════════════════════════════════════════════════
// HOLIDAYS / OFF-DAYS
// Single source of truth for "is this person working that day?" — plus a small
// cache, because the holiday list was re-read from MySQL on every task create,
// every compliance grid and every meeting-slot request although it changes
// perhaps twice a year. Writes invalidate it immediately.
// ══════════════════════════════════════════════════════
const { db } = require('../db/pool');
const { toDateStr } = require('../utils/dates');

const CACHE_MS = 60 * 1000;
let _cache = null;          // { set, expires }
let _inFlight = null;       // shared promise, so a burst of requests causes one query

async function loadHolidaysSet({ fresh = false } = {}) {
  if (!fresh && _cache && Date.now() < _cache.expires) return _cache.set;
  if (!fresh && _inFlight) return _inFlight;

  _inFlight = (async () => {
    try {
      const rows = await db.rows('SELECT DATE_FORMAT(holiday_date,"%Y-%m-%d") AS d FROM holidays');
      const set = new Set(rows.map(r => r.d));
      _cache = { set, expires: Date.now() + CACHE_MS };
      return set;
    } catch (e) {
      console.error('loadHolidaysSet error:', e.message);
      return _cache ? _cache.set : new Set();
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

function invalidateHolidays() { _cache = null; }

// dateStr = 'YYYY-MM-DD'; holidaysSet = Set of 'YYYY-MM-DD'.
// Per-user week_off / extra_off are deliberately NOT considered — the Holiday
// tab is the one list that applies to everybody. The user argument is kept
// because callers pass a row and a future rule may need it.
function isUserOffOn(_user, dateStr, holidaysSet) {
  return !!holidaysSet && holidaysSet.has(toDateStr(dateStr));
}

// Next working day strictly AFTER fromDate (60-day lookahead, then give up).
function nextWorkingDay(user, fromDateStr, holidaysSet) {
  const d = new Date(toDateStr(fromDateStr) + 'T00:00:00');
  for (let i = 0; i < 60; i++) {
    d.setDate(d.getDate() + 1);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!isUserOffOn(user, ds, holidaysSet)) return ds;
  }
  return toDateStr(fromDateStr); // fallback
}

// Declaring a holiday: pending checklist rows on that date are dropped and
// pending delegation tasks are pushed to the next working day.
// The push used to be one UPDATE per task; tasks are now grouped by their new
// date so it is one UPDATE per distinct date instead (usually exactly one).
async function cascadeHolidayDate(dateStr) {
  let deletedChecklist = 0, pushedDelegation = 0;

  try {
    const [del] = await db.query("DELETE FROM checklist_tasks WHERE due_date=? AND status='pending'", [dateStr]);
    deletedChecklist = del.affectedRows || 0;
  } catch (e) { console.error('cascade checklist:', e.message); }

  try {
    const holidaysSet = await loadHolidaysSet({ fresh: true });
    const rows = await db.rows(
      `SELECT t.id, t.assigned_to, u.week_off, u.extra_off
         FROM delegation_tasks t JOIN users u ON t.assigned_to=u.id
        WHERE t.due_date=? AND t.status='pending'`, [dateStr]);

    const byNewDate = new Map();
    for (const t of rows) {
      const newDate = nextWorkingDay(t, dateStr, holidaysSet);
      const bucket = byNewDate.get(newDate);
      if (bucket) bucket.push(t.id); else byNewDate.set(newDate, [t.id]);
    }
    for (const [newDate, ids] of byNewDate) {
      await db.query(
        `UPDATE delegation_tasks SET due_date=? WHERE id IN (${ids.map(() => '?').join(',')})`,
        [newDate, ...ids]);
      pushedDelegation += ids.length;
    }
  } catch (e) { console.error('cascade delegation:', e.message); }

  return { deletedChecklist, pushedDelegation };
}

module.exports = { loadHolidaysSet, invalidateHolidays, isUserOffOn, nextWorkingDay, cascadeHolidayDate };
