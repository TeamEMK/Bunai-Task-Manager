// ══════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// The JWT carries userId/role/name; anything else about the user (department,
// week-off…) is read from the database, because a token issued a week ago must
// not decide today's permissions.
// ══════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db/pool');

function signToken(user) {
  return jwt.sign(
    { userId: user.id, role: user.role, name: user.name },
    config.auth.jwtSecret,
    { expiresIn: config.auth.jwtExpiry });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret);
    req.session = { userId: decoded.userId, role: decoded.role, name: decoded.name };
    next();
  } catch (e) { res.status(401).json({ error: 'Invalid token' }); }
}

// Role gates. Each one names the roles it lets through so the route list reads
// as a permission table.
const allowRoles = (roles, message) => (req, res, next) => {
  if (roles.includes(req.session.role)) return next();
  res.status(403).json({ error: message });
};

const requireAdmin = allowRoles(['admin'], 'Admin only');
const requireAdminOrHod = allowRoles(['admin', 'hod', 'pc'], 'Admin or HOD only');
const requireAdminOrHodOnly = allowRoles(['admin', 'hod'], 'Admin or HOD (App Role) only');
const requireAdminOrPC = allowRoles(['admin', 'pc'], 'Admin or PC only');

// ── Department gates (PO section) ─────────────────────
// The JWT has no department, so it comes from the row. Admin always passes.
async function getUserDept(userId) {
  const row = await db.one('SELECT department FROM users WHERE id=?', [userId]);
  return (row?.department || '').trim().toLowerCase();
}

const requireDept = (allowed, message) => (req, res, next) => {
  (async () => {
    if (req.session.role === 'admin') return next();
    const dept = await getUserDept(req.session.userId);
    if (allowed.includes(dept)) return next();
    res.status(403).json({ error: message });
  })().catch(err => res.status(500).json({ error: err.message }));
};

const requirePOFill = requireDept(['production'], 'Only the Production department (or an Admin) can fill a PO.');
const requirePOUpload = requireDept(['finance'], 'Only the Finance department (or an Admin) can upload a PO document.');
const requirePOView = requireDept(['production', 'finance'], 'This PO section is only for Production, Finance or Admin.');

// Cron endpoints have no session — they authenticate with a shared secret sent
// either as a Bearer header (what Vercel Cron does) or ?key=.
function requireCronSecret(req, res, next) {
  const secret = config.cronSecret;
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not configured' });
  const sent = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.key || '';
  if (sent !== secret) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

module.exports = {
  signToken, requireAuth,
  requireAdmin, requireAdminOrHod, requireAdminOrHodOnly, requireAdminOrPC,
  getUserDept, requirePOFill, requirePOUpload, requirePOView,
  requireCronSecret,
};
