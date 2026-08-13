// ══════════════════════════════════════════════════════
// HASH-INDEX HELPERS
// The pattern these replace is `rows.find(r => r.id === x)` inside a loop —
// O(n·m) work that also tends to hide an N+1 query underneath it. Building a
// Map once and reading it is O(n+m), and it makes the intent ("index these
// rows by step_id") readable at the call site.
// ══════════════════════════════════════════════════════

// '?,?,?' for an IN (…) list. Always pair it with the same array as params —
// never interpolate the values themselves.
const placeholders = (list) => list.map(() => '?').join(',');

// rows → Map(key → row). Last row wins on a duplicate key.
function indexBy(rows, key) {
  const map = new Map();
  const pick = typeof key === 'function' ? key : (r => r[key]);
  for (const row of rows) map.set(pick(row), row);
  return map;
}

// rows → Map(key → row[]). The bucket always exists after a push, so callers
// can do `groups.get(id) || []` and never branch on undefined mid-loop.
function groupBy(rows, key) {
  const map = new Map();
  const pick = typeof key === 'function' ? key : (r => r[key]);
  for (const row of rows) {
    const k = pick(row);
    const bucket = map.get(k);
    if (bucket) bucket.push(row); else map.set(k, [row]);
  }
  return map;
}

// Numeric coercion used all over the reporting endpoints: MySQL returns SUM()
// as a string, and `null + 1` is what turns a report into NaN.
const N = v => Number(v) || 0;

module.exports = { placeholders, indexBy, groupBy, N };
