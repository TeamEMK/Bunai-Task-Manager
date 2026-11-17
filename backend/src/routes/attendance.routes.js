// ══════════════════════════════════════════════════════
// ATTENDANCE (/api/attendance)
//
// The HR team's attendance sheet, kept in the app: a month at a time, a row a
// day, a column a person, one status in each cell - Present, Leave (Full Day),
// Half Day, WFH, Holiday, Week off. The summary under the month (how many of
// each per person) is counted from the cells, never typed.
//
// The people are the sheet's own list, not the users table: not everyone who
// is marked here signs in, and not everyone who signs in is marked here. An
// Admin keeps the list - adds, renames, reorders, switches someone off. A
// switched-off person keeps their marks and stops showing in new months.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin, requirePage } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();
const PAGE = requirePage('attendance');

const STATUSES = ['Present', 'Leave (Full Day)', 'Half Day', 'WFH', 'Holiday', 'Week off'];
const isYm = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

async function whoAmI(req) {
  const me = await db.one('SELECT name FROM users WHERE id = ?', [req.session.userId]);
  return (me && me.name) || req.session.name || '';
}

router.get('/attendance', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const month = isYm(req.query.month) ? req.query.month : istToday().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${month}-${String(days).padStart(2, '0')}`;
  const [marks, months] = await Promise.all([
    db.rows(`SELECT person_id, DATE_FORMAT(day, '%Y-%m-%d') day, status, updated_by_name,
                    DATE_FORMAT(updated_at + INTERVAL 330 MINUTE, '%e %b %Y, %l:%i %p') updated_at
               FROM att_marks WHERE day BETWEEN ? AND ?`, [first, last]),
    db.rows(`SELECT DISTINCT DATE_FORMAT(day, '%Y-%m') ym FROM att_marks ORDER BY ym`),
  ]);
  // Everyone on the list now, and anyone switched off since who has marks in
  // this month - an old month still shows the people it had.
  const marked = new Set(marks.map(k => k.person_id));
  const people = (await db.rows('SELECT id, name, position, active FROM att_people ORDER BY position, id'))
    .filter(p => Number(p.active) || marked.has(p.id))
    .map(p => ({ id: p.id, name: p.name, active: !!Number(p.active) }));
  const all = (await db.rows('SELECT id, name, position, active FROM att_people ORDER BY position, id'))
    .map(p => ({ id: p.id, name: p.name, active: !!Number(p.active) }));
  const cells = {};
  marks.forEach(k => { cells[k.person_id + '|' + k.day] = { status: k.status, by: k.updated_by_name, at: k.updated_at }; });
  const list = new Set(months.map(r => r.ym));
  list.add(istToday().slice(0, 7));
  list.add(month);
  res.json({ month, days, statuses: STATUSES, people, allPeople: all, cells, months: [...list].sort(), canEditPeople: req.session.role === 'admin' });
}));

// One cell: a status, or "" to clear it.
router.post('/attendance/mark', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const pid = parseInt(b.person_id, 10);
  if (!isYmd(b.day)) throw httpError(400, 'That date is not valid.');
  if (!(await db.one('SELECT id FROM att_people WHERE id = ?', [pid]))) throw httpError(400, 'That person is not on the list.');
  const status = String(b.status || '');
  if (status && !STATUSES.includes(status)) throw httpError(400, 'Choose one of the statuses.');
  if (!status) await db.query('DELETE FROM att_marks WHERE person_id = ? AND day = ?', [pid, b.day]);
  else {
    await db.query(
      `INSERT INTO att_marks (person_id, day, status, updated_by_name, updated_at) VALUES (?,?,?,?, UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE status = VALUES(status), updated_by_name = VALUES(updated_by_name), updated_at = VALUES(updated_at)`,
      [pid, b.day, status, await whoAmI(req)]);
  }
  res.json({ success: true });
}));

// One day for everyone on the list - a holiday, a week off.
router.post('/attendance/day', requireAuth, PAGE, asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!isYmd(b.day)) throw httpError(400, 'That date is not valid.');
  const status = String(b.status || '');
  if (status && !STATUSES.includes(status)) throw httpError(400, 'Choose one of the statuses.');
  const ids = (await db.rows('SELECT id FROM att_people WHERE active = 1')).map(p => p.id);
  if (!ids.length) return res.json({ success: true, n: 0 });
  if (!status) await db.query('DELETE FROM att_marks WHERE day = ? AND person_id IN (?)', [b.day, ids]);
  else {
    const who = await whoAmI(req);
    // The database's clock, not this process's: it runs in UTC like every
    // other stamp here, and the page adds India's offset to all of them.
    await db.query(
      `INSERT INTO att_marks (person_id, day, status, updated_by_name, updated_at)
       VALUES ${ids.map(() => '(?,?,?,?, UTC_TIMESTAMP())').join(',')}
       ON DUPLICATE KEY UPDATE status = VALUES(status), updated_by_name = VALUES(updated_by_name), updated_at = VALUES(updated_at)`,
      ids.flatMap(id => [id, b.day, status, who]));
  }
  res.json({ success: true, n: ids.length });
}));

// ── the people (Admin) ────────────────────────────────
router.post('/attendance/people', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const name = clip((req.body || {}).name, 120);
  if (!name) throw httpError(400, 'Write the name.');
  const last = await db.one('SELECT COALESCE(MAX(position), 0) p FROM att_people');
  const [r] = await db.query('INSERT INTO att_people (name, position, active) VALUES (?,?,1)', [name, Number(last.p) + 1]);
  res.json({ id: r.insertId });
}));

// The whole list at once: names, order and on/off.
router.put('/attendance/people', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const list = Array.isArray((req.body || {}).people) ? req.body.people : [];
  for (let i = 0; i < list.length; i++) {
    const name = clip(list[i].name, 120);
    if (!name) throw httpError(400, 'Every person needs a name.');
    await db.query('UPDATE att_people SET name = ?, position = ?, active = ? WHERE id = ?',
      [name, i + 1, list[i].active ? 1 : 0, parseInt(list[i].id, 10)]);
  }
  res.json({ success: true });
}));

module.exports = router;
