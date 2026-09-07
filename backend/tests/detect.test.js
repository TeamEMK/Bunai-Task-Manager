// Fixture tests for the FMS step detector — no network, no database.
const path = require('path');
const ROOT = require('path').join(__dirname, '..', 'src', 'services') + require('path').sep;
const { detectSteps, classify, fieldTypeFor, stepNameFrom, stepLabelsFrom, guessHeaderRow, labelledRows, rowLabel } = require(ROOT + 'fmsDetect.js');

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`  ✗ ${label}\n      got  ${g}\n      want ${w}`);
};
const section = (t) => console.log(`\n── ${t} ──`);

// Builds a column the way sheetIntrospect would report it.
let nextIdx = 0;
const col = (name, extra = {}) => {
  const index = extra.index ?? nextIdx++;
  const letter = (() => { let s = '', n = index + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; })();
  return {
    index, col: letter, name,
    isFormula: false, formulaCells: 0, filled: 10, sampled: 10,
    numberFormat: null, validation: null, samples: [],
    ...extra,
  };
};
const reset = () => { nextIdx = 0; };

// ── classify ─────────────────────────────────────────
section('classify');
eq(classify('Cutting Planned Date'), 'plan', 'planned → plan');
eq(classify('Cutting Actual Date'), 'actual', 'actual → actual');
eq(classify('Done By'), 'doer', '"Done By" is a doer, not an actual');
eq(classify('Completed By'), 'doer', '"Completed By" is a doer');
eq(classify('Doer Name'), 'doer', 'doer name');
eq(classify('Delay Reason'), 'delay', 'delay reason');
eq(classify('Remarks'), 'other', 'a bare "Remarks" stays an ordinary column');
eq(classify('Reason'), 'other', 'a bare "Reason" stays an ordinary column');
eq(classify('Target Date'), 'plan', 'target → plan');
eq(classify('Fabric Type'), 'other', 'ordinary column');
eq(classify(''), 'blank', 'empty header');

// ── step names ───────────────────────────────────────
section('stepNameFrom');
eq(stepNameFrom('Cutting Planned Date', 'Cutting Actual Date'), 'Cutting', 'prefix survives');
eq(stepNameFrom('Planned Date', 'Actual Date'), '', 'nothing distinctive left');
eq(stepNameFrom('Plan 1', 'Actual 1'), '', 'numbering is not a name');
eq(stepNameFrom('Stitching Plan', ''), 'Stitching', 'suffix form');

// ── field types ──────────────────────────────────────
section('fieldTypeFor');
eq(fieldTypeFor(col('Qty', { numberFormat: 'NUMBER' })), 'number', 'number format');
eq(fieldTypeFor(col('Received On', { numberFormat: 'DATE' })), 'date', 'date format');
eq(fieldTypeFor(col('Status', { validation: { type: 'list', options: ['OK', 'Hold'] } })), 'dropdown', 'validation list');
eq(fieldTypeFor(col('Doc Link', { samples: ['https://x.com/a', 'https://x.com/b'] })), 'link', 'values are URLs');
eq(fieldTypeFor(col('Upload Photo')), 'file', 'file by header');
eq(fieldTypeFor(col('Sheet Link')), 'link', 'link by header');
eq(fieldTypeFor(col('Notes')), 'text', 'fallback');
// A list rule outranks the number format: the options are the better UI.
eq(fieldTypeFor(col('Grade', { numberFormat: 'NUMBER', validation: { type: 'list', options: ['1', '2'] } })), 'dropdown', 'validation beats format');

// ── a whole realistic sheet ──────────────────────────
section('detectSteps — two-step production sheet');
reset();
const sheet = [
  col('SO Number'), col('Party Name'), col('Style'),
  // step 1
  col('Cutting Planned Date', { numberFormat: 'DATE' }),
  col('Cutting Actual Date', { numberFormat: 'DATE' }),
  col('Cutting Doer'),
  col('Cutting Qty', { numberFormat: 'NUMBER' }),
  col('Fabric Status', { validation: { type: 'list', options: ['Inhouse', 'Raise PO'] } }),
  col('Cutting Delay Reason'),
  col('Cutting Days', { isFormula: true, formulaCells: 10 }),
  // step 2
  col('Stitching Planned Date', { numberFormat: 'DATE' }),
  col('Stitching Actual Date', { numberFormat: 'DATE' }),
  col('Stitching Done By'),
  col('Stitching Remarks'),
  col('QC Passed', { validation: { type: 'boolean' } }),
];
const out = detectSteps(sheet);

eq(out.planColumnCount, 2, 'two steps found');
eq(out.leadingColumns.map(c => c.name), ['SO Number', 'Party Name', 'Style'], 'identity columns are not step inputs');

const [s1, s2] = out.steps;
eq(s1.stepName, 'Cutting', 'step 1 name');
eq([s1.planCol, s1.actualCol], ['D', 'E'], 'step 1 plan/actual');
eq(s1.doerNameCol, 'F', 'step 1 doer column');
eq(s1.delayReasonCol, 'I', 'step 1 delay column');
eq(s1.extraRows.map(r => [r.col_letter, r.field_type]), [['G', 'number'], ['H', 'dropdown']], 'step 1 extras + types');
eq(s1.extraRows[1].dropdown_options, 'Inhouse, Raise PO', 'dropdown options come from the sheet');
eq(s1.extraRows.every(r => r.required === 0), true, 'auto-detected extras start optional');

eq(s2.stepName, 'Stitching', 'step 2 name');
eq([s2.planCol, s2.actualCol], ['K', 'L'], 'step 2 plan/actual');
eq(s2.doerNameCol, 'M', 'step 2 doer column ("Done By")');
eq(s2.delayReasonCol, '', 'step 2 has no delay column — left blank');
eq(s2.extraRows.map(r => r.col_letter), ['N'], 'step 2 extras exclude the checkbox');

eq(out.skipped.map(s => [s.col, s.reason]), [['J', 'formula column'], ['O', 'checkbox column']], 'skips are reported, not silent');

// ── nothing to detect ────────────────────────────────
section('detectSteps — a sheet with no plan columns');
reset();
const flat = detectSteps([col('Name'), col('Qty'), col('Notes')]);
eq(flat.steps.length, 0, 'no steps invented');
eq(flat.leadingColumns.length, 3, 'every column reported as leading');

// ── unnamed steps still get a placeholder ────────────
section('detectSteps — generic headers');
reset();
const generic = detectSteps([col('Plan 1'), col('Actual 1'), col('Plan 2'), col('Actual 2')]);
eq(generic.steps.map(s => s.stepName), ['Step 1', 'Step 2'], 'placeholder names, not wrong names');
eq(generic.steps.map(s => [s.planCol, s.actualCol]), [['A', 'B'], ['C', 'D']], 'pairs still resolve');


// ── the shape a real Bunai FMS sheet actually has ────
// Found by running this against "Required Data-Bunai": five columns per step,
// the dates computed by formula, and completion driven by a checkbox.
section('detectSteps — computed columns must not become write targets');
reset();
const live = [
  col('Entry Date'), col('Style / Design No'), col('Item Description'),
  col('Category'), col('Quantity'), col('Remark'),
  col('Planned', { isFormula: true, formulaCells: 8 }),
  col('Actual', { isFormula: true, formulaCells: 8 }),
  col('Time Delay', { isFormula: true, formulaCells: 8 }),
  col('Status', { validation: { type: 'boolean' } }),
  col('Doer'),
  col('Planned', { isFormula: true, formulaCells: 8 }),
  col('Actual', { isFormula: true, formulaCells: 8 }),
  col('Time Delay', { isFormula: true, formulaCells: 8 }),
  col('Status', { validation: { type: 'boolean' } }),
  col('Doer'),
];
// Row 1 banners the groups, row 2 names them. The names are what matter.
const labelRows = [
  ['', '', '', '', '', '', 'Step1', '', '', '', '', 'Step2'],
  ['What', '', '', '', '', '', 'Fabric Sourced', '', '', '', '', 'Fabric Dyed'],
];
const liveOut = detectSteps(live, { labelRows });

eq(liveOut.steps.length, 2, 'a step per Planned column');
eq(liveOut.steps.map(s => s.stepName), ['Fabric Sourced', 'Fabric Dyed'],
  'step names come from the sheet, not from "Step 1"');
eq(liveOut.steps.map(s => [s.planCol, s.actualCol, s.doerNameCol]), [['G', 'H', 'K'], ['L', 'M', 'P']],
  'plan / actual / doer paired within each band');
// "Time Delay" is derived from the two dates. Writing a reason there would
// destroy the formula, so it is refused however well the name matches.
eq(liveOut.steps.map(s => s.delayReasonCol), ['', ''], 'a computed column is never the delay target');

// The Actual column is derived from the checkbox, so completing the step means
// ticking the checkbox. That becomes the write target; the derived column is
// left to the formula that owns it.
eq(liveOut.steps.map(s => s.completeCol), ['J', 'O'], 'the checkbox is the completion target');
eq(liveOut.steps.map(s => s.completeHeader), ['Status', 'Status'], 'and it is named');
eq(liveOut.steps[0].warnings.map(w => w.col), ['I', 'J'], 'the delay formula and the completion switch are both reported');
eq(liveOut.steps[0].warnings[1].kind, 'info', 'the completion note is information, not a hazard');
eq(/completes by ticking it/.test(liveOut.steps[0].warnings[1].reason), true,
  'it says the step completes by ticking, rather than warning about a formula');
// The checkbox is the switch, so it is not offered as an input to type into.
eq(liveOut.skipped.map(k => k.col), [], 'the checkbox is no longer listed as a skipped column');

// Without a checkbox there is nothing to tick, so the hazard stands.
reset();
const noBox = detectSteps([
  col('Planned', { isFormula: true, formulaCells: 8 }),
  col('Actual', { isFormula: true, formulaCells: 8 }),
  col('Doer'),
]);
eq(noBox.steps[0].completeCol, '', 'no checkbox, no completion column');
eq(/no checkbox to tick/.test(noBox.steps[0].warnings[0].reason), true,
  'and the formula hazard is stated plainly');
eq(liveOut.leadingColumns.length, 6, 'the identity columns stay out of the steps');

section('stepLabelsFrom');
eq(stepLabelsFrom([['', 'Step1', '', 'Step2'], ['', 'Cutting', '', 'Stitching']], [1, 3]),
  ['Cutting', 'Stitching'], 'a descriptive row beats a "Step N" banner');
eq(stepLabelsFrom([['', 'Step1', '', 'Step2']], [1, 3]), ['Step1', 'Step2'],
  'a banner row is still returned when it is all there is');
eq(stepLabelsFrom([], [1, 3]), [], 'nothing above the header row');


section('guessHeaderRow');
// The banner block a real sheet opens with, then the actual header row.
const banner = [
  ['07/09/2026 14:37', '0.208', '9', '19'],
  ['What', 'Sample Requirement'],
  ['Who', 'Ashok Ji'],
  [],
  ['When', 'Anytime'],
  ['prerequisites'],
  ['Entry Date', 'Style', 'Item', 'Category', 'Qty', 'Remark',
   'Planned', 'Actual', 'Time Delay', 'Status', 'Doer',
   'Planned', 'Actual', 'Time Delay', 'Status', 'Doer'],
];
eq(guessHeaderRow(banner), 7, 'finds the row carrying the plan/actual pairs');
eq(guessHeaderRow([['Planned', 'Actual', 'Doer']]), 1, 'a sheet with no banner');
// Without a pair there is nothing to be confident about, so it declines rather
// than picking a row of prose.
eq(guessHeaderRow([['Name', 'Qty'], ['a', 'b']]), 0, 'declines when there is no pair');
eq(guessHeaderRow([]), 0, 'empty sheet');


section('labelledRows — the sheet labels its own rows');
// A planning sheet describes each step group above the header, and says in its
// own first column which row is which: "What" the step is, "Who" does it.
// The Doer COLUMN in the grid is usually empty — that is where the app stamps a
// name on completion, not where the plan lives.
const planning = [
  ['', '', '', '', '', '', 'Step1', '', '', '', '', 'Step2'],
  ['What', 'Sample Requirement', '', '', '', '', 'Fabric Sourced', '', '', '', '', 'Fabric Dyed'],
  ['Who', 'Ashok Ji', '', '', '', '', 'Ashok/Mamaji', '', '', '', '', 'Rahees'],
  ['When', 'Anytime', '', '', '', '', '7 days', '', '', '', '', '7 days'],
];
eq(labelledRows(planning, [6, 11]),
  { what: ['Fabric Sourced', 'Fabric Dyed'], who: ['Ashok/Mamaji', 'Rahees'] },
  'What and Who rows found by their own labels');
eq(labelledRows([['Notes', 'x']], [6]), { what: null, who: null }, 'no labelled rows');
eq(rowLabel(['', '', 'Who', '', 'Ashok'], 4), 'Who', 'the label is the first filled cell before the steps');

section('detectSteps — doer comes from the Who row');
reset();
const planCols = [
  col('Entry Date'), col('Style'), col('Item'), col('Category'), col('Qty'), col('Remark'),
  col('Planned'), col('Actual'), col('Time Delay'), col('Status', { validation: { type: 'boolean' } }), col('Doer'),
  col('Planned'), col('Actual'), col('Time Delay'), col('Status', { validation: { type: 'boolean' } }), col('Doer'),
];
const planned = detectSteps(planCols, { labelRows: planning });
eq(planned.steps.map(s => s.stepName), ['Fabric Sourced', 'Fabric Dyed'], 'names from the What row');
eq(planned.steps.map(s => s.doerLabel), ['Ashok/Mamaji', 'Rahees'], 'doer label from the Who row');
// The column is still mapped — it is where the name gets written on completion.
eq(planned.steps.map(s => s.doerNameCol), ['K', 'P'], 'the Doer column is still the write target');

console.log(`\n${fail ? '❌' : '✅'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
