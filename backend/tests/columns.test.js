// Fixture tests for header-name column resolution.
const ROOT = require('path').join(__dirname, '..', 'src', 'services') + require('path').sep;
const { buildHeaderMap, buildRowHeader, resolveStep } = require(ROOT + 'fmsColumns.js');

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`  ✗ ${label}\n      got  ${g}\n      want ${w}`);
};
const section = (t) => console.log(`\n── ${t} ──`);
const L = (i) => { let s = '', n = i + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

// A two-step sheet whose steps share the header names "Planned" and "Actual".
//  0 SO | 1 Planned | 2 Actual | 3 Done By | 4 Cut Qty | 5 Planned | 6 Actual | 7 Done By | 8 Stitch Notes
const HEADERS = ['SO', 'Planned', 'Actual', 'Done By', 'Cut Qty', 'Planned', 'Actual', 'Done By', 'Stitch Notes'];

const step1 = { plan_col: 'B', actual_col: 'C', doer_name_col: 'D', delay_reason_col: '', show_cols: '[]' };
const step2 = { plan_col: 'F', actual_col: 'G', doer_name_col: 'H', delay_reason_col: '', show_cols: '[]' };
let extras1 = [{ id: 11, col_letter: 'E' }];
let extras2 = [{ id: 22, col_letter: 'I' }];
// An extra row carries its own header, because saving an FMS re-inserts these
// rows with fresh ids.
const withHeaders = (rows, headers) => rows.map(r => ({ ...r, ...buildRowHeader(r, headers) }));

// ── building the map from the sheet as it stands ──────
section('buildHeaderMap');
const map1 = buildHeaderMap(step1, extras1, HEADERS);
const map2 = buildHeaderMap(step2, extras2, HEADERS);
eq([map1.plan.h, map1.plan.occ], ['Planned', 0], 'step 1 takes the first "Planned"');
eq([map2.plan.h, map2.plan.occ], ['Planned', 1], 'step 2 takes the second "Planned"');
eq(buildRowHeader(extras1[0], HEADERS), { header_name: 'Cut Qty', header_occ: 0 }, 'extra row carries its own header');

const s1 = { ...step1, header_map: JSON.stringify(map1) };
const s2 = { ...step2, header_map: JSON.stringify(map2) };
extras1 = withHeaders(extras1, HEADERS);
extras2 = withHeaders(extras2, HEADERS);

// ── unchanged sheet ──────────────────────────────────
section('sheet unchanged');
let r1 = resolveStep(s1, extras1, HEADERS);
let r2 = resolveStep(s2, extras2, HEADERS);
eq([r1.plan, r1.actual, r1.doer], [1, 2, 3], 'step 1 resolves to itself');
eq([r2.plan, r2.actual, r2.doer], [5, 6, 7], 'step 2 resolves to ITS OWN repeated headers');
eq(r1.extras[11], 4, 'step 1 extra');
eq(r2.extras[22], 8, 'step 2 extra');
eq(r1.unresolved, [], 'nothing unresolved');

// ── a column inserted in the middle ───────────────────
// "Priority" goes in at position 1: everything after it shifts one right.
section('column inserted in the middle');
const withCol = ['SO', 'Priority', 'Planned', 'Actual', 'Done By', 'Cut Qty', 'Planned', 'Actual', 'Done By', 'Stitch Notes'];
r1 = resolveStep(s1, extras1, withCol);
r2 = resolveStep(s2, extras2, withCol);
eq([r1.plan, r1.actual, r1.doer, r1.extras[11]], [2, 3, 4, 5], 'step 1 followed the shift');
eq([r2.plan, r2.actual, r2.doer, r2.extras[22]], [6, 7, 8, 9], 'step 2 followed the shift');
eq(r1.mapped && r2.mapped, true, 'resolved by name, not by letter');

// ── a column inserted INSIDE step 1's band ───────────
section('column inserted inside a step band');
const inBand = ['SO', 'Planned', 'Actual', 'Extra Check', 'Done By', 'Cut Qty', 'Planned', 'Actual', 'Done By', 'Stitch Notes'];
r1 = resolveStep(s1, extras1, inBand);
r2 = resolveStep(s2, extras2, inBand);
eq([r1.plan, r1.actual, r1.doer, r1.extras[11]], [1, 2, 4, 5], 'step 1 skipped the intruder');
eq([r2.plan, r2.actual, r2.doer], [6, 7, 8], 'step 2 still correct');

// ── a whole STEP inserted in the middle ──────────────
// A new "Washing" step lands between the two. Step 2's "Planned" is now the
// THIRD one in the sheet, not the second.
section('step inserted in the middle');
const withStep = [
  'SO', 'Planned', 'Actual', 'Done By', 'Cut Qty',
  'Planned', 'Actual', 'Done By', 'Wash Temp',        // ← new step
  'Planned', 'Actual', 'Done By', 'Stitch Notes',
];
r2 = resolveStep(s2, extras2, withStep);
eq([r2.plan, r2.actual, r2.doer, r2.extras[22]], [9, 10, 11, 12],
  'step 2 found its own band by signature ("Stitch Notes"), not by occurrence');
r1 = resolveStep(s1, extras1, withStep);
eq([r1.plan, r1.actual, r1.doer, r1.extras[11]], [1, 2, 3, 4], 'step 1 unaffected');

// ── a renamed header ─────────────────────────────────
section('header renamed');
const renamed = ['SO', 'Planned', 'Actual Date', 'Done By', 'Cut Qty', 'Planned', 'Actual', 'Done By', 'Stitch Notes'];
r1 = resolveStep(s1, extras1, renamed);
eq(r1.unresolved, ['actual'], 'the rename is reported, not guessed around');
eq(r1.actual, 2, 'falls back to the stored letter rather than grabbing another step\'s column');

// ── a step saved before header mapping existed ───────
section('legacy step with no header map');
const legacy = resolveStep(step1, extras1, HEADERS);
eq([legacy.plan, legacy.actual, legacy.doer, legacy.extras[11]], [1, 2, 3, 4], 'letters still work');
eq(legacy.mapped, false, 'flagged as unmapped so it can be backfilled');

// ── steps that are genuinely identical ───────────────
// Nothing can tell these apart, so it falls back to occurrence order and stays
// stable. Documented, not pretended away.
section('indistinguishable steps');
const twinHeaders = ['SO', 'Planned', 'Actual', 'Planned', 'Actual'];
const t1 = { plan_col: 'B', actual_col: 'C', doer_name_col: '', delay_reason_col: '', show_cols: '[]' };
const t2 = { plan_col: 'D', actual_col: 'E', doer_name_col: '', delay_reason_col: '', show_cols: '[]' };
const tm1 = { ...t1, header_map: JSON.stringify(buildHeaderMap(t1, [], twinHeaders)) };
const tm2 = { ...t2, header_map: JSON.stringify(buildHeaderMap(t2, [], twinHeaders)) };
eq([resolveStep(tm1, [], twinHeaders).plan, resolveStep(tm2, [], twinHeaders).plan], [1, 3],
  'occurrence keeps identical steps apart');

console.log(`\n${fail ? '❌' : '✅'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
