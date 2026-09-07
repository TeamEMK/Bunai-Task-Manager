// Tests sheetIntrospect against a canned response shaped exactly like the
// Sheets API's spreadsheets.get with includeGridData — the part the fixture
// tests for detection cannot reach, and where a wrong field mask or a missed
// optional key would break everything at runtime.
const path = require('path');
process.chdir(path.join(__dirname, '..', '..'));
const B = path.join(__dirname, '..', 'src') + path.sep;
const google = require(B + 'services/google');

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.log(`  ✗ ${label}\n      got  ${g}\n      want ${w}`);
};

// A cell as the API returns it.
const cell = (v, extra = {}) => ({ formattedValue: v, ...extra });
const fmt = (t) => ({ effectiveFormat: { numberFormat: { type: t } } });
const formula = (f) => ({ userEnteredValue: { formulaValue: f } });
const list = (...opts) => ({ dataValidation: { condition: { type: 'ONE_OF_LIST', values: opts.map(o => ({ userEnteredValue: o })) } } });
const boolRule = { dataValidation: { condition: { type: 'BOOLEAN' } } };
const rangeRule = { dataValidation: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: '=Lists!A1:A3' }] } } };

const RESPONSE = {
  data: {
    sheets: [{
      properties: { title: 'FMS', sheetId: 0 },
      data: [{
        // startRow / startColumn are omitted by the API when they are zero.
        rowData: [
          { values: [cell('SO'), cell('Planned'), cell('Actual'), cell('Qty'), cell('Status'), cell('Days'), cell('QC'), cell('Grade')] },
          { values: [
            cell('1001'),
            cell('01/08/2026', fmt('DATE')),
            cell('03/08/2026', fmt('DATE')),
            cell('120', fmt('NUMBER')),
            cell('Inhouse', list('Inhouse', 'Raise PO', 'Material Issue')),
            cell('2', { ...fmt('NUMBER'), ...formula('=C2-B2') }),
            cell('TRUE', boolRule),
            cell('A', rangeRule),
          ] },
          { values: [
            cell('1002'),
            cell('05/08/2026', fmt('DATE')),
            cell(''),
            cell('80', fmt('NUMBER')),
            cell('Raise PO'),
            cell('', formula('=C3-B3')),
            cell('FALSE'),
            cell('B'),
          ] },
        ],
      }],
    }],
  },
};

// Stand in for the Sheets client and for the range read a ONE_OF_RANGE needs.
google.getReadClient = async () => ({ spreadsheets: { get: async () => RESPONSE } });
const realReadValues = google.readValues;
google.readValues = async (_id, range) => {
  if (String(range).includes('Lists!A1:A3')) return [['A'], ['B'], ['C']];
  return realReadValues(_id, range);
};

const introspect = require(B + 'services/sheetIntrospect');
const { detectSteps } = require(B + 'services/fmsDetect');

(async () => {
  const meta = await introspect.readColumnMeta('someSheetId', 'FMS', 1);
  const by = Object.fromEntries(meta.columns.map(c => [c.name, c]));

  eq(meta.columns.length, 8, 'every column parsed');
  eq(meta.headers.map(h => h.name), ['SO', 'Planned', 'Actual', 'Qty', 'Status', 'Days', 'QC', 'Grade'], 'headers read from row 1');
  eq(meta.columns.map(c => c.col).slice(0, 4), ['A', 'B', 'C', 'D'], 'letters derived from position');

  eq(by.Planned.numberFormat, 'DATE', 'date format detected');
  eq(by.Qty.numberFormat, 'NUMBER', 'number format detected');
  eq(by.Status.validation, { type: 'list', options: ['Inhouse', 'Raise PO', 'Material Issue'] }, 'dropdown options lifted from the sheet');
  eq(by.QC.validation, { type: 'boolean' }, 'checkbox rule detected');
  eq(by.Grade.validation, { type: 'list', options: ['A', 'B', 'C'] }, 'ONE_OF_RANGE resolved by reading the range');

  // Both data cells of "Days" are formulas, so it is the sheet's column, not a doer's.
  eq(by.Days.isFormula, true, 'formula column flagged');
  eq(by.Qty.isFormula, false, 'a hand-typed column is not');
  eq(by.Actual.filled, 1, 'blank cells are not counted as filled');

  // And the detector, fed the real parse, leaves out what the sheet owns.
  const out = detectSteps(meta.columns);
  eq(out.steps.length, 1, 'one step');
  const [s] = out.steps;
  eq([s.planCol, s.actualCol], ['B', 'C'], 'plan/actual');
  eq(s.extraRows.map(r => [r.col_letter, r.field_type]), [['D', 'number'], ['E', 'dropdown'], ['H', 'dropdown']], 'extras typed from the sheet');
  eq(out.skipped.map(k => [k.col, k.reason]), [['F', 'formula column'], ['G', 'checkbox column']], 'formula and checkbox left out');

  console.log(`\n${fail ? '❌' : '✅'}  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.stack); process.exit(1); });
