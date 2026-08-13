// ══════════════════════════════════════════════════════
// PASSWORD HASHING — the only place bcrypt is called.
//
// Three things changed from the inline hashSync/compareSync calls:
//   1. ASYNC. bcryptjs is pure JavaScript; a cost-10 compareSync blocks the
//      event loop for ~80-100ms, so on a 2-connection pool every other request
//      in flight stalls behind one login. bcrypt.compare() yields between rounds.
//   2. ONE cost setting (BCRYPT_ROUNDS) instead of the literal 10 repeated in
//      six places, plus transparent re-hashing when that setting changes.
//   3. A constant-work path for unknown emails, so "no such user" and "wrong
//      password" take the same time and cannot be told apart from outside.
// ══════════════════════════════════════════════════════
const bcrypt = require('bcryptjs');
const config = require('../config');

const ROUNDS = config.auth.bcryptRounds;

// A real hash of a value nobody can supply. Comparing against it costs exactly
// what a genuine comparison costs, which is the entire point.
const DUMMY_HASH = bcrypt.hashSync('bunai::no-such-user', ROUNDS);

const hash = (plain) => bcrypt.hash(String(plain), ROUNDS);

// Verifies a password. A missing/blank stored hash still burns the same work
// before returning false.
async function verify(plain, storedHash) {
  if (!storedHash) { await bcrypt.compare(String(plain || ''), DUMMY_HASH); return false; }
  try { return await bcrypt.compare(String(plain || ''), storedHash); }
  catch (_) { return false; }   // malformed hash in the row — treat as a failed login
}

// Called when no user matched the email, so the response time carries no
// information about which addresses are registered.
const burnTime = (plain) => bcrypt.compare(String(plain || ''), DUMMY_HASH).then(() => false, () => false);

// "$2a$10$…" → 10. Returns true when the stored hash is weaker (or stronger)
// than the current setting, so login can quietly upgrade it.
function needsRehash(storedHash) {
  const m = /^\$2[aby]?\$(\d{2})\$/.exec(storedHash || '');
  return !m || Number(m[1]) !== ROUNDS;
}

module.exports = { hash, verify, burnTime, needsRehash, ROUNDS };
