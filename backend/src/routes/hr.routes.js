// ══════════════════════════════════════════════════════
// HR — employee master records (Phase 1). Admin only.
// One row per employee in hr_employees; user_id optionally links it to a login
// account (users), but a record can exist without one (non-login staff).
// Holds PII (Aadhaar/PAN/bank) and salary, so every route is requireAdmin.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');

const router = express.Router();

// ── value coercers — empty string always becomes NULL ──
const TEXT = v => { const s = (v == null ? '' : String(v)).trim(); return s === '' ? null : s; };
const UPPER = v => { const s = TEXT(v); return s ? s.toUpperCase() : null; };
const NUM = v => { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const DATE = v => { const s = TEXT(v); return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const GENDER = v => { const s = (TEXT(v) || '').toLowerCase(); return ['male', 'female', 'other'].includes(s) ? s : null; };

// Every editable column → how to clean the incoming value. Drives INSERT/UPDATE
// so a new field is added in exactly one place.
const FIELDS = [
  ['user_id', NUM],
  ['employee_code', TEXT],
  ['full_name', TEXT],
  ['gender', GENDER],
  ['dob', DATE],
  ['blood_group', TEXT],
  ['marital_status', TEXT],
  ['personal_email', TEXT],
  ['personal_phone', TEXT],
  ['current_address', TEXT],
  ['permanent_address', TEXT],
  ['emergency_contact_name', TEXT],
  ['emergency_contact_phone', TEXT],
  ['emergency_contact_relation', TEXT],
  ['designation', TEXT],
  ['department', TEXT],
  ['joining_date', DATE],
  ['employment_type', TEXT],
  ['employment_status', v => TEXT(v) || 'Active'],
  ['reporting_manager', TEXT],
  ['work_location', TEXT],
  ['exit_date', DATE],
  ['pan', UPPER],
  ['aadhaar', TEXT],
  ['uan', TEXT],
  ['pf_number', TEXT],
  ['esic_number', TEXT],
  ['bank_name', TEXT],
  ['bank_account', TEXT],
  ['bank_ifsc', UPPER],
  ['bank_holder_name', TEXT],
  ['ctc', NUM],
  ['monthly_salary', NUM],
  ['official_email', TEXT],
  ['kra', TEXT],
  ['offer_letter_date', TEXT],
  ['probation_end_date', DATE],
  ['confirmation_date', DATE],
  ['appointment_nda_status', TEXT],
  ['code_of_conduct_status', TEXT],
  ['policy_handbook_status', TEXT],
  ['bg_verification_status', TEXT],
  ['record_log', TEXT],
  ['performance_remarks', TEXT],
  ['notes', TEXT],
];

const buildRow = body => {
  const row = {};
  for (const [col, coerce] of FIELDS) row[col] = coerce(body[col]);
  return row;
};

// A login account may back at most one employee record.
async function assertUserLinkFree(userId, selfId) {
  if (!userId) return;
  const clash = await db.one(
    'SELECT id, full_name FROM hr_employees WHERE user_id = ? AND id <> ? LIMIT 1',
    [userId, selfId || 0]);
  if (clash) throw httpError(400, `That login is already linked to ${clash.full_name}`);
}

// Turn the unique-code collision into a readable message.
const friendlyDup = e => (e && e.code === 'ER_DUP_ENTRY')
  ? httpError(400, 'That employee code is already used')
  : e;

// ── LIST — searchable, with a status filter and headline counts ──
router.get('/hr/employees', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || '').trim();
  const where = [];
  const args = [];
  if (status) { where.push('e.employment_status = ?'); args.push(status); }
  if (q) {
    where.push('(e.full_name LIKE ? OR e.employee_code LIKE ? OR e.designation LIKE ? OR e.department LIKE ? OR e.personal_phone LIKE ? OR e.personal_email LIKE ? OR e.official_email LIKE ? OR e.reporting_manager LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like, like, like, like, like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const employees = await db.rows(
    `SELECT e.id, e.employee_code, e.full_name, e.designation, e.department,
            e.employment_type, e.employment_status, e.joining_date,
            e.personal_phone, e.personal_email, e.work_location, e.user_id,
            u.name AS login_name, u.email AS login_email
       FROM hr_employees e
       LEFT JOIN users u ON u.id = e.user_id
       ${whereSql}
      ORDER BY (e.employment_status = 'Active') DESC, e.full_name ASC`, args);

  const counts = await db.one(
    `SELECT COUNT(*) total,
            SUM(employment_status = 'Active') active,
            SUM(employment_status <> 'Active') inactive
       FROM hr_employees`);

  res.json({ employees, counts });
}));

// ── Login accounts available to link (for the dropdown) ──
router.get('/hr/linkable-users', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const users = await db.rows(
    `SELECT u.id, u.name, u.email, u.phone, u.department, u.role,
            (e.id IS NOT NULL) AS already_linked
       FROM users u
       LEFT JOIN hr_employees e ON e.user_id = u.id
      ORDER BY u.name ASC`);
  res.json(users);
}));

// ── One record, everything ──
router.get('/hr/employee', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.query.id, 10);
  if (!id) throw httpError(400, 'No employee id');
  const employee = await db.one(
    `SELECT e.*, u.name AS login_name, u.email AS login_email
       FROM hr_employees e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.id = ?`, [id]);
  if (!employee) return res.json({ notFound: true });
  res.json({ employee });
}));

// ── Create ──
router.post('/hr/employees', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const row = buildRow(req.body);
  if (!row.full_name) throw httpError(400, 'Full name is required');
  await assertUserLinkFree(row.user_id, null);
  const cols = Object.keys(row);
  try {
    const [r] = await db.query(
      `INSERT INTO hr_employees (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map(c => row[c]));
    res.json({ success: true, id: r.insertId });
  } catch (e) { throw friendlyDup(e); }
}));

// ── Update ──
router.put('/hr/employees/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) throw httpError(400, 'No employee id');
  const row = buildRow(req.body);
  if (!row.full_name) throw httpError(400, 'Full name is required');
  await assertUserLinkFree(row.user_id, id);
  const cols = Object.keys(row);
  try {
    await db.query(
      `UPDATE hr_employees SET ${cols.map(c => `${c}=?`).join(',')} WHERE id=?`,
      [...cols.map(c => row[c]), id]);
    res.json({ success: true });
  } catch (e) { throw friendlyDup(e); }
}));

// ── Delete ──
router.delete('/hr/employees/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) throw httpError(400, 'No employee id');
  await db.query('DELETE FROM hr_employees WHERE id=?', [id]);
  res.json({ success: true });
}));

module.exports = router;
