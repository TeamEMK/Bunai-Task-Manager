// ══════════════════════════════════════════════════════
// SHEET INTROSPECTION
// Everything the FMS auto-detector needs to know about a sheet's columns, in
// ONE spreadsheets.get: the header text, whether a column is filled by a
// formula, what number format it carries, and any data-validation rule.
//
// values.get cannot answer any of that — it returns strings. The grid read is
// bounded to the header row plus a sample of data rows and narrowed with a
// fields mask, so it stays small even on a 10 000-row sheet.
// ══════════════════════════════════════════════════════
const { idxToCol, extractSpreadsheetId } = require('../utils/sheetCells');
const google = require('./google');

// How many data rows to look at when deciding a column's nature. Enough to see
// past a few blank leading rows, small enough to keep the payload light.
const SAMPLE_ROWS = 60;

const GRID_FIELDS = [
  'sheets(properties(title,sheetId),',
  'data(startRow,startColumn,rowData(values(',
  'formattedValue,',
  'userEnteredValue,',
  'effectiveFormat/numberFormat,',
  'dataValidation',
  '))))',
].join('');

// A validation rule can name a range instead of a literal list. Reading that
// range is what turns "options live over there" into actual options.
async function resolveRangeOptions(spreadsheetId, condition) {
  const ref = condition?.values?.[0]?.userEnteredValue;
  if (!ref || !ref.startsWith('=')) return null;
  try {
    const rows = await google.readValues(spreadsheetId, ref.slice(1));
    const opts = [...new Set(rows.map(r => String(r[0] ?? '').trim()).filter(Boolean))];
    return opts.length ? opts : null;
  } catch (_) {
    return null;   // range on another (unshared) file, or a bad reference
  }
}

function validationFrom(rule) {
  const cond = rule?.condition;
  if (!cond) return null;
  if (cond.type === 'BOOLEAN') return { type: 'boolean' };
  if (cond.type === 'ONE_OF_LIST') {
    const options = (cond.values || []).map(v => String(v.userEnteredValue ?? '').trim()).filter(Boolean);
    return options.length ? { type: 'list', options } : null;
  }
  if (cond.type === 'ONE_OF_RANGE') return { type: 'range', condition: cond };
  return null;
}

// 'DATE' | 'DATE_TIME' | 'NUMBER' | 'CURRENCY' | 'PERCENT' | 'TEXT' | null
const numberFormatOf = (cell) => cell?.effectiveFormat?.numberFormat?.type || null;

const isFormulaCell = (cell) => {
  const raw = cell?.userEnteredValue?.formulaValue;
  return typeof raw === 'string' && raw.startsWith('=');
};

// Reads the header row plus a sample of data rows and reduces each column to
// one description. `headerRow` is 1-based, as it is everywhere in the UI.
async function readColumnMeta(sheetIdOrUrl, tabName, headerRow = 1, { sampleRows = SAMPLE_ROWS } = {}) {
  const spreadsheetId = extractSpreadsheetId(sheetIdOrUrl);
  const tab = tabName || 'Sheet1';
  const firstRow = Math.max(1, parseInt(headerRow, 10) || 1);
  const lastRow = firstRow + sampleRows;

  const api = await google.getReadClient();
  const resp = await api.spreadsheets.get({
    spreadsheetId,
    ranges: [`${tab}!${firstRow}:${lastRow}`],
    includeGridData: true,
    fields: GRID_FIELDS,
  });

  const grid = resp.data.sheets?.[0]?.data?.[0];
  const rowData = grid?.rowData || [];
  // A range starting at row 1 omits startRow/startColumn entirely.
  const startCol = grid?.startColumn || 0;
  const headerCells = rowData[0]?.values || [];
  const dataRows = rowData.slice(1);

  const width = rowData.reduce((w, r) => Math.max(w, (r.values || []).length), 0);

  const columns = [];
  for (let c = 0; c < width; c++) {
    const index = startCol + c;
    const name = String(headerCells[c]?.formattedValue ?? '').trim();

    let formulaCells = 0;
    let filled = 0;
    let validation = null;
    let numberFormat = null;
    const samples = [];

    for (const row of dataRows) {
      const cell = (row.values || [])[c];
      if (!cell) continue;
      if (isFormulaCell(cell)) formulaCells++;
      const text = String(cell.formattedValue ?? '').trim();
      if (text) {
        filled++;
        if (samples.length < 12) samples.push(text);
      }
      if (!validation) validation = validationFrom(cell.dataValidation);
      if (!numberFormat && text) numberFormat = numberFormatOf(cell);
    }
    // The header cell can carry the rule even when the data rows are empty.
    if (!validation) validation = validationFrom(headerCells[c]?.dataValidation);

    columns.push({
      index,
      col: idxToCol(index),
      name,
      // "The sheet fills this itself." A column is only called a formula column
      // when the formulas outnumber the hand-typed values — one stray =SUM() at
      // the bottom of a data column must not disqualify it.
      isFormula: formulaCells > 0 && formulaCells >= Math.max(1, filled) / 2,
      formulaCells,
      filled,
      sampled: dataRows.length,
      numberFormat,
      validation,
      samples,
    });
  }

  // ONE_OF_RANGE rules need a second read each; they are rare, so this only
  // fires for the columns that actually use one.
  await Promise.all(columns.map(async (col) => {
    if (col.validation?.type !== 'range') return;
    const options = await resolveRangeOptions(spreadsheetId, col.validation.condition);
    col.validation = options ? { type: 'list', options } : null;
  }));

  return {
    spreadsheetId,
    tab,
    headerRow: firstRow,
    columns,
    headers: columns.filter(c => c.name).map(c => ({ name: c.name, col: c.col, index: c.index })),
  };
}

module.exports = { readColumnMeta, SAMPLE_ROWS };
