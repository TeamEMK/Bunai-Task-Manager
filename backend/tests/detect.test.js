// Fixture tests for the FMS step detector — no network, no database.
const path = require('path');
const ROOT = require('path').join(__dirname, '..', 'src', 'services') + require('path').sep;
const { detectSteps, classify, fieldTypeFor, stepNameFrom } = require(ROOT + 'fmsDetect.js');

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

console.log(`\n${fail ? '❌' : '✅'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
