// The sheet names people the way the floor says them; the app holds one formal
// name each. Matching those two is the difference between a Configure Steps
// screen that arrives filled in and one where every doer box is empty — which
// is exactly what happened on the real Bunai sheet, where "Ashok kumar/Mamaji"
// matched nobody.
//
// The rule under test is the admin's: take a name only when it lands on exactly
// one user, and leave it blank the moment two people could be meant.
const path = require('path');
const dm = require(path.join(__dirname, '..', 'src', 'services', 'doerMatch.js'));

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`  ✗ ${label}\n      got  ${g}\n      want ${w}`);
};
const section = (t) => console.log(`\n── ${t} ──`);

// Who the app knows about, and who the sheet says — deliberately spelled apart.
const TEAM = [
  { id: 1, name: 'Ashok Kumar' },
  { id: 2, name: 'Mama Ji' },
  { id: 3, name: 'Rahees Khan' },
  { id: 4, name: 'Paridhi Jain' },
  { id: 5, name: 'Nandkishor Patel' },
];
const idx = dm.buildIndex(TEAM);
const who = (name) => { const m = dm.matchOne(name, idx); return m ? m.name : null; };

section('the spellings the real sheet uses');
eq(who('Ashok kumar'), 'Ashok Kumar', 'lower-case surname is the same person');
eq(who('  Ashok   Kumar '), 'Ashok Kumar', 'stray spacing');
eq(who('Mamaji'), 'Mama Ji', 'title glued on — "Mamaji" is "Mama Ji"');
eq(who('Ashok Ji'), 'Ashok Kumar', 'title instead of a surname, and only one Ashok to mean');
eq(who('ASHOK KUMAR'), 'Ashok Kumar', 'shouting');
eq(who('Rahees'), 'Rahees Khan', 'first name alone, when it is unique');
eq(who('Mr. Rahees'), 'Rahees Khan', 'punctuation and a title together');

section('what it refuses to decide');
const twoAshoks = dm.buildIndex([...TEAM, { id: 6, name: 'Ashok Verma' }]);
eq(dm.matchOne('Ashok Ji', twoAshoks), null, 'two Ashoks — the sheet does not say which, so neither');
eq(dm.matchOne('Ashok', twoAshoks), null, 'a bare first name shared by two people');
eq(dm.matchOne('Ashok Kumar', twoAshoks)?.id, 1, '...but the full name still resolves');
const twins = dm.buildIndex([{ id: 7, name: 'Ravi Shah' }, { id: 8, name: 'Ravi Shah' }]);
eq(dm.matchOne('Ravi Shah', twins), null, 'two users registered under one name match nobody');
eq(who('Somebody Else'), null, 'a name the app has never heard of');
eq(who(''), null, 'an empty cell');
eq(who('   '), null, 'a cell holding only spaces');

section('a title is dropped only as a fallback, never over a real match');
// Some sheets register the title AS the name. An exact hit must win outright.
const withTitleUser = dm.buildIndex([{ id: 1, name: 'Ashok Kumar' }, { id: 9, name: 'Ashok Ji' }]);
eq(dm.matchOne('Ashok Ji', withTitleUser)?.id, 9, '"Ashok Ji" is its own user here, not a titled Ashok');
eq(dm.matchOne('Ashok Kumar', withTitleUser)?.id, 1, 'and Ashok Kumar is still himself');

section('a short name is not trimmed into somebody else');
const risky = dm.buildIndex([{ id: 10, name: 'Ravi Shah' }, { id: 11, name: 'Raji Menon' }]);
eq(dm.matchOne('Raji', risky)?.name, 'Raji Menon', '"Raji" keeps its ending — it is a name, not a title');

section('one cell, several people');
eq(dm.splitNames('Ashok/Mamaji'), ['Ashok', 'Mamaji'], 'slash');
eq(dm.splitNames('Paridhi & Rahees'), ['Paridhi', 'Rahees'], 'ampersand');
eq(dm.splitNames('Ashok, Rahees and Paridhi'), ['Ashok', 'Rahees', 'Paridhi'], 'comma and the word "and"');
eq(dm.splitNames('Nandkishor'), ['Nandkishor'], 'the "and" inside a name is not a separator');
eq(dm.splitNames(''), [], 'empty');
eq(dm.splitNames(null), [], 'missing');

section('the whole cell, end to end — this is the step that was coming back blank');
const one = dm.matchNames(dm.splitNames('Ashok kumar/Mamaji'), idx);
eq(one.matched.map(m => m.name), ['Ashok Kumar', 'Mama Ji'], 'both doers assigned');
eq(one.unmatched, [], 'nothing left over');

const mixed = dm.matchNames(dm.splitNames('Rahees & Someone Unknown'), idx);
eq(mixed.matched.map(m => m.name), ['Rahees Khan'], 'the one it knows is assigned');
eq(mixed.unmatched, ['Someone Unknown'], 'the one it does not is reported, not guessed');

const twice = dm.matchNames(['Ashok kumar', 'Ashok Ji', 'ashok kumar'], idx);
eq(twice.matched.map(m => m.id), [1], 'three spellings of one man assign him once');

const nobody = dm.matchNames(dm.splitNames('Ashok/Ashok Verma'), twoAshoks);
eq(nobody.matched.map(m => m.name), ['Ashok Verma'], 'the unambiguous half of an ambiguous cell still lands');
eq(nobody.unmatched, ['Ashok'], 'and the ambiguous half is handed back');

section('the matcher says how it decided, so a review can be argued with');
eq(dm.matchOne('Ashok Kumar', idx).how, 'exact', 'exact');
eq(dm.matchOne('Mamaji', idx).how, 'exact', 'spacing only — still exact');
eq(dm.matchOne('Ashok Ji', idx).how, 'first-name', 'title dropped, then first name');

console.log(`\n${fail ? '❌' : '✅'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
