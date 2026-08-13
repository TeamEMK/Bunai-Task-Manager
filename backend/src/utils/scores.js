// ══════════════════════════════════════════════════════
// SCORING
// Both formulas are deficit scales in [-100, 0]: 0 means "nothing slipped".
// They were duplicated in five endpoints with slightly different rounding;
// this is the one definition all of them now share.
// ══════════════════════════════════════════════════════
const { N } = require('./collections');

const round1 = n => Math.round(n * 10) / 10;

// Delegation / checklist / combined MIS score.
function deficitScore(total, pending, overdue, revised) {
  total = N(total); pending = N(pending); overdue = N(overdue); revised = N(revised);
  if (total <= 0) return 0;
  return Math.max(-100, round1(0 - (pending / total) * 100 - (overdue / total) * 50 - (revised / total) * 25));
}

// Same shape as deficitScore, but returns null (not 0) when the employee has no
// work in the window — "no data" and "perfect" must not look identical in the
// weekly table.
function deficitScoreOrNull(total, pending, overdue, revised) {
  if (N(total) <= 0) return null;
  return deficitScore(total, pending, overdue, revised);
}

// FMS has no "revised" state — only pending and delayed rows count against it.
function fmsScore(total, pending, delayed) {
  total = N(total); pending = N(pending); delayed = N(delayed);
  if (!total) return 0;
  return Math.max(-100, round1(0 - (pending / total) * 100 - (delayed / total) * 50));
}

module.exports = { round1, deficitScore, deficitScoreOrNull, fmsScore };
