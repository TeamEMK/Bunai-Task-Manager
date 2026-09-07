// ══════════════════════════════════════════════════════
// DOER NAME MATCHING
// A planning sheet writes people the way the floor says them — "Ashok kumar",
// "Mamaji", "Ashok Ji" — while the app holds one formal name per user. Compared
// literally, none of those find anybody, so every step came back with no doer
// even though the sheet named one on every line.
//
// The rule here is the one the admin set: a wrong assignment is expensive, a
// blank one costs a click. So a name is taken only when it lands on EXACTLY ONE
// user. The moment two people could be meant, it is reported unmatched and left
// for the admin, who is looking at the screen anyway.
// ══════════════════════════════════════════════════════

// Titles carry no identity — "Ashok Ji" and "Ashok" are one person. They are
// only dropped as a fallback though, never before an exact comparison has had
// its chance, because on some sheets the title IS how the user is registered.
const HONORIFICS = new Set([
  'ji', 'jee', 'sir', 'madam', 'mam', 'maam', 'mr', 'mrs', 'ms', 'miss',
  'shri', 'shree', 'smt', 'dr', 'bhai', 'bhaiya', 'bhaiyya', 'didi',
]);

// Anything that is not a letter or a digit is separation, not spelling, so
// "Mr.Rahul", "ashok_kumar" and "Ashok  Kumar" all reduce to the same thing.
const tokensOf = (name) => String(name || '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean);

// A title is written either as its own word ("Ashok Ji") or glued to the name
// ("Mamaji"). Both are removed; a glued one only when enough name survives, so
// "Raji" is not quietly shortened to "Ra".
function coreTokens(tokens) {
  const out = [];
  for (const t of tokens) {
    if (HONORIFICS.has(t)) continue;
    let word = t;
    for (const h of HONORIFICS) {
      if (word.length > h.length + 2 && word.endsWith(h)) { word = word.slice(0, -h.length); break; }
    }
    out.push(word);
  }
  // A name made of nothing but titles keeps its original form rather than
  // becoming empty and matching everybody.
  return out.length ? out : tokens;
}

// The comparable shapes of one name, cheapest first.
function shapesOf(name) {
  const tokens = tokensOf(name);
  const core = coreTokens(tokens);
  return {
    tokens,
    core,
    full: tokens.join(' '),
    tight: tokens.join(''),        // "Mama Ji" and "Mamaji" meet here
    coreFull: core.join(' '),
    coreTight: core.join(''),
  };
}

const startsWith = (long, short) =>
  short.length > 0 && short.length <= long.length && short.every((t, i) => long[i] === t);

// Tried in order. The first tier that finds anyone decides the answer — if that
// tier found two people the name is ambiguous and we stop, because a looser
// comparison can only pull in more.
const TIERS = [
  { how: 'exact', test: (n, u) => !!n.full && (n.full === u.full || n.tight === u.tight) },
  { how: 'title', test: (n, u) => !!n.coreTight && n.coreTight === u.coreTight },
  { how: 'first-name', test: (n, u) => startsWith(u.core, n.core) || startsWith(n.core, u.core) },
];

// users: [{ id, name }]. Returns a lookup that shapes each user once.
function buildIndex(users) {
  return (users || [])
    .filter(u => u && u.name && tokensOf(u.name).length)
    .map(u => ({ id: u.id, name: u.name, shapes: shapesOf(u.name) }));
}

// One sheet name -> one user, or null when nobody or too many fit.
function matchOne(sheetName, index) {
  const n = shapesOf(sheetName);
  if (!n.tokens.length) return null;
  for (const tier of TIERS) {
    const hits = index.filter(u => tier.test(n, u.shapes));
    if (hits.length === 1) return { id: hits[0].id, name: hits[0].name, sheetName, how: tier.how };
    if (hits.length > 1) return null;   // ambiguous — deliberately unassigned
  }
  return null;
}

// One cell often holds several people — "Ashok/Mamaji", "Paridhi & Rahees",
// "Ashok kumar and Rahees". Splitting on "and" needs the word boundaries or it
// would cut "Nandkishor" in half.
const splitNames = (text) => String(text || '')
  .split(/[\/,&+]|\band\b/i)
  .map(n => n.trim())
  .filter(Boolean);

// The whole job for one step: candidate names in, assigned users and the names
// nobody could be found for, out.
function matchNames(names, index) {
  const matched = [];
  const unmatched = [];
  const seenName = new Set();
  const seenUser = new Set();
  for (const raw of names) {
    const key = raw.trim().toLowerCase();
    if (!key || seenName.has(key)) continue;
    seenName.add(key);
    const hit = matchOne(raw, index);
    if (!hit) { unmatched.push(raw); continue; }
    if (seenUser.has(hit.id)) continue;   // two spellings of one person
    seenUser.add(hit.id);
    matched.push(hit);
  }
  return { matched, unmatched };
}

module.exports = { buildIndex, matchOne, matchNames, splitNames, shapesOf, tokensOf, coreTokens };
