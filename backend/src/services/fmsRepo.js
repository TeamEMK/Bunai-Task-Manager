// ══════════════════════════════════════════════════════
// FMS DATA ACCESS
// An FMS is a Google Sheet plus a description of which columns are the "plan"
// and "actual" dates of each step, and who the doers are.
//
// The queries here are all batched by design: the endpoints used to walk
// sheets → steps → doers with a query at every level, so one MIS page load
// issued (1 + sheets + steps) queries — typically 60-100 — before it even
// started reading spreadsheets. It is now three queries regardless of size.
// ══════════════════════════════════════════════════════
const { db } = require('../db/pool');
const { placeholders, groupBy } = require('../utils/collections');
const { colToIdx, idxToCol, detectColumnDateFormat, sheetDateToYMD, isRowDelayed, extractSpreadsheetId } = require('../utils/sheetCells');
const google = require('./google');

const SHEET_COLUMNS = 'id, fms_name, sheet_name, sheet_id, header_row, total_steps, created_by, created_at';
const STEP_COLUMNS = `id, fms_id, step_order, step_name, plan_col, actual_col, extra_input, extra_col,
                      show_cols, delay_reason_col, doer_name_col`;

const stepsForSheets = async (sheetIds) => {
  if (!sheetIds.length) return new Map();
  const rows = await db.rows(
    `SELECT ${STEP_COLUMNS} FROM fms_steps WHERE fms_id IN (${placeholders(sheetIds)}) ORDER BY step_order ASC`,
    sheetIds);
  return groupBy(rows, 'fms_id');
};

// step_id → [{ user_id, name, department }]
const doersForSteps = async (stepIds) => {
  if (!stepIds.length) return new Map();
  const rows = await db.rows(
    `SELECT fsd.step_id, fsd.user_id, u.name, u.department
       FROM fms_step_doers fsd JOIN users u ON fsd.user_id = u.id
      WHERE fsd.step_id IN (${placeholders(stepIds)})`, stepIds);
  return groupBy(rows, 'step_id');
};

const extraRowsForSteps = async (stepIds) => {
  if (!stepIds.length) return new Map();
  const rows = await db.rows(
    `SELECT id, step_id, row_label, col_letter, field_type, dropdown_options, required
       FROM fms_extra_rows WHERE step_id IN (${placeholders(stepIds)}) ORDER BY id ASC`, stepIds);
  return groupBy(rows, 'step_id');
};

const parseShowCols = (step) => {
  try { return JSON.parse(step.show_cols || '[]'); } catch (_) { return []; }
};

// Attaches doers (+ optionally extra rows) to a list of steps, in one query each.
async function decorateSteps(steps, { withExtraRows = false, viewerId = null, isAdmin = false } = {}) {
  const ids = steps.map(s => s.id);
  const [doers, extras] = await Promise.all([
    doersForSteps(ids),
    withExtraRows ? extraRowsForSteps(ids) : Promise.resolve(new Map()),
  ]);
  for (const step of steps) {
    const d = doers.get(step.id) || [];
    step.doers = d.map(x => ({ user_id: x.user_id, name: x.name, department: x.department }));
    step.doerIds = d.map(x => x.user_id);
    step.doerNames = d.map(x => x.name).join(', ');
    step.show_cols_parsed = parseShowCols(step);
    if (viewerId != null) step.isMyStep = isAdmin || step.doerIds.includes(viewerId);
    if (withExtraRows) step.extraRows = extras.get(step.id) || [];
  }
  return steps;
}

// Reads the sheet range that covers every plan/actual column the given steps
// use. Returns null when no step names a usable column.
async function readSheetGrid(sheet, steps) {
  const cols = steps.flatMap(s => [colToIdx(s.plan_col), colToIdx(s.actual_col)]).filter(x => x >= 0);
  if (!cols.length) return null;
  const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
  const tabName = sheet.sheet_name || 'Sheet1';
  const headerRowIdx = (sheet.header_row || 1) - 1;
  const range = `${tabName}!A:${idxToCol(Math.max(...cols))}`;
  const values = await google.readValues(spreadsheetId, range);
  return {
    spreadsheetId, tabName, headerRowIdx,
    headers: values[headerRowIdx] || [],
    dataRows: values.slice(headerRowIdx + 1),
  };
}

// Counts pending / done / delayed rows for one step, optionally restricted to a
// plan-date window. The column's date format is detected once per step, not per
// row — that alone removed an O(rows²) pass on wide sheets.
function stepStats(dataRows, step, { start = null, end = null } = {}) {
  const planIdx = colToIdx(step.plan_col);
  const actualIdx = colToIdx(step.actual_col);
  if (planIdx < 0 || actualIdx < 0) return null;

  const planFormat = detectColumnDateFormat(dataRows.map(r => r[planIdx]));
  let pending = 0, done = 0, delayed = 0;
  for (const row of dataRows) {
    const planVal = (row[planIdx] || '').trim();
    if (!planVal) continue;
    const actualVal = (row[actualIdx] || '').trim();
    if (start || end) {
      // When plan_col holds no date (e.g. a custom form) the filter is skipped.
      const planYMD = sheetDateToYMD(planVal, planFormat);
      if (planYMD && ((start && planYMD < start) || (end && planYMD > end))) continue;
    }
    if (actualVal) done++; else pending++;
    if (isRowDelayed(planVal, actualVal, planFormat)) delayed++;
  }
  return { pending, done, delayed, total: pending + done, planIdx, actualIdx, planFormat };
}

module.exports = {
  SHEET_COLUMNS, STEP_COLUMNS,
  stepsForSheets, doersForSteps, extraRowsForSteps, decorateSteps, parseShowCols,
  readSheetGrid, stepStats,
};
