// ══════════════════════════════════════════════════════
// FMS — admin configuration (/api/fms/*), the doer views (/api/fms-tasks/*)
// and the pending-row dashboard.
// ══════════════════════════════════════════════════════
const express = require('express');
const { db } = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncRoute, httpError } = require('../middleware/errors');
const { placeholders, indexBy } = require('../utils/collections');
const { serverToday } = require('../utils/dates');
const {
  colToIdx, idxToCol, extractSpreadsheetId,
  detectColumnDateFormat, sheetDateToYMD, istSheetSerialNow,
} = require('../utils/sheetCells');
const google = require('../services/google');
const fmsRepo = require('../services/fmsRepo');

const router = express.Router();

// ══════════════════════════════════════════════════════
// FMS DASHBOARD — row-level pending work, like delegation/checklist.
// ══════════════════════════════════════════════════════
router.get('/fms-dashboard', requireAuth, asyncRoute(async (req, res) => {
  const uid = req.session.userId;
  const role = req.session.role;
  const isAdmin = role === 'admin' || role === 'pc';
  const isHod = role === 'hod';
  const filterEmployee = req.query.employee;
  const allEmployees = !filterEmployee || filterEmployee === 'all';
  const today = serverToday();

  // Which users' steps to show. null is never used — admin viewing everyone
  // takes the "all sheets" branch instead.
  let targetUserIds = [uid];
  if (isAdmin && !allEmployees) {
    targetUserIds = [parseInt(filterEmployee, 10)];
  } else if (isHod) {
    if (!allEmployees) {
      targetUserIds = [parseInt(filterEmployee, 10)];
    } else {
      const me = await db.one('SELECT department FROM users WHERE id=?', [uid]);
      const deptUsers = await db.rows(
        'SELECT id FROM users WHERE department=? AND role NOT IN (?,?)', [me?.department || '', 'admin', 'hod']);
      targetUserIds = deptUsers.map(u => u.id);
      if (!targetUserIds.length) return res.json({ rows: [], pendingCount: 0 });
    }
  }

  const everySheet = isAdmin && allEmployees;
  const sheets = everySheet
    ? await db.rows(`SELECT * FROM fms_sheets ORDER BY fms_name ASC`)
    : await db.rows(
      `SELECT DISTINCT fs.* FROM fms_sheets fs
         JOIN fms_steps fst ON fst.fms_id=fs.id
         JOIN fms_step_doers fsd ON fsd.step_id=fst.id
        WHERE fsd.user_id IN (${placeholders(targetUserIds)})
        ORDER BY fs.fms_name ASC`, targetUserIds);
  if (!sheets.length) return res.json({ rows: [], pendingCount: 0 });

  // Steps for every sheet, then doers for every step — two queries in total,
  // where this used to be one per sheet plus one per step.
  const stepsBySheet = await fmsRepo.stepsForSheets(sheets.map(s => s.id));
  await fmsRepo.decorateSteps(sheets.flatMap(s => stepsBySheet.get(s.id) || []));

  // Only the steps this viewer is a doer of (admins viewing everyone see all).
  const wanted = new Set(targetUserIds);
  const stepsToShow = new Map();
  for (const sheet of sheets) {
    const steps = (stepsBySheet.get(sheet.id) || [])
      .filter(s => everySheet || s.doerIds.some(id => wanted.has(id)));
    if (steps.length) stepsToShow.set(sheet.id, steps);
  }

  // Sheets are read in parallel; google.readValues de-duplicates and caches, so
  // a second dashboard within the TTL costs no Google calls at all.
  const grids = new Map();
  await Promise.all(sheets.map(async (sheet) => {
    const steps = stepsToShow.get(sheet.id);
    if (!steps) return;
    try { grids.set(sheet.id, { grid: await fmsRepo.readSheetGrid(sheet, steps), steps }); }
    catch (_) { /* skip this sheet — one bad sheet must not fail the page */ }
  }));

  const allRows = [];
  for (const sheet of sheets) {
    const entry = grids.get(sheet.id);
    if (!entry || !entry.grid) continue;
    const { grid, steps } = entry;
    const fmsName = sheet.fms_name || sheet.sheet_name;

    for (const step of steps) {
      const planIdx = colToIdx(step.plan_col);
      const actualIdx = colToIdx(step.actual_col);
      if (planIdx < 0 || actualIdx < 0) continue;
      const planFormat = detectColumnDateFormat(grid.dataRows.map(r => r[planIdx]));

      grid.dataRows.forEach((row, i) => {
        const planVal = (row[planIdx] || '').trim();
        const actualVal = (row[actualIdx] || '').trim();
        if (!planVal || actualVal) return;    // no plan, or already done

        const planDate = sheetDateToYMD(planVal, planFormat) || '';
        allRows.push({
          fmsName,
          fmsId: sheet.id,
          stepName: step.step_name,
          stepId: step.id,
          doer: step.doerNames || '—',
          planValue: planVal,
          planDate,
          isLate: !!planDate && planDate < today,
          rowNumber: grid.headerRowIdx + 1 + i + 1,
        });
      });
    }
  }

  res.json({ rows: allRows, pendingCount: allRows.length });
}));

// ══════════════════════════════════════════════════════
// FMS ADMIN
// ══════════════════════════════════════════════════════
router.get('/fms', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  res.json(await db.rows(
    `SELECT f.*,u.name AS createdByName FROM fms_sheets f
       JOIN users u ON f.created_by=u.id ORDER BY f.created_at DESC`));
}));

// IMPORTANT: must stay above /api/fms/:id, or ":id" swallows it.
// Reads one column of a sheet and matches its values against user names, so
// Step Doers can be populated from a "Doer Name" column.
router.get('/fms/sheet-column-values', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { sheetId, tabName, col, headerRow } = req.query;
  if (!sheetId || !col) return res.status(400).json({ error: 'sheetId and col required' });
  const colIdx = colToIdx(col);
  if (colIdx < 0) return res.status(400).json({ error: 'Invalid column letter' });

  const headerIdx = (parseInt(headerRow, 10) || 1) - 1;
  const [values, allUsers] = await Promise.all([
    google.readValues(extractSpreadsheetId(sheetId), `${tabName || 'Sheet1'}!${col}:${col}`),
    db.rows('SELECT id, name, email, role FROM users'),
  ]);

  const uniqueNames = [...new Set(
    values.slice(headerIdx + 1).map(r => (r[0] || '').trim()).filter(Boolean))];

  // Index the users by lowercase name ONCE — this was a linear scan of every
  // user for every distinct sheet value (O(names × users)).
  const byName = indexBy(allUsers, u => u.name.trim().toLowerCase());
  const matched = [];
  const unmatched = [];
  for (const sheetName of uniqueNames) {
    const user = byName.get(sheetName.toLowerCase());
    if (user) matched.push({ sheet_name: sheetName, user_id: user.id, user_name: user.name, email: user.email });
    else unmatched.push(sheetName);
  }

  res.json({
    total_unique: uniqueNames.length,
    matched_count: matched.length,
    unmatched_count: unmatched.length,
    matched, unmatched, all_unique: uniqueNames,
  });
}));

router.get('/fms/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const sheet = await db.one('SELECT * FROM fms_sheets WHERE id=?', [req.params.id]);
  if (!sheet) throw httpError(404, 'FMS not found');
  const steps = await db.rows(
    `SELECT ${fmsRepo.STEP_COLUMNS} FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC`, [req.params.id]);
  // Doers and extra rows for ALL steps in two queries (was two per step).
  await fmsRepo.decorateSteps(steps, { withExtraRows: true });
  res.json({ sheet, steps });
}));

// Writes the step rows of an FMS inside an open transaction. Each step's doers
// and extra rows go in as one multi-row INSERT instead of one per value.
async function writeSteps(conn, fmsId, steps) {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const [sr] = await conn.query(
      `INSERT INTO fms_steps (fms_id,step_order,step_name,plan_col,actual_col,extra_input,extra_col,show_cols,delay_reason_col,doer_name_col)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [fmsId, i + 1, s.stepName, s.planCol || '', s.actualCol || '', s.extraInput || 'no',
       s.extraCol || '', JSON.stringify(s.showCols || []), s.delayReasonCol || '', s.doerNameCol || '']);
    const stepId = sr.insertId;

    if (s.doers?.length) {
      await conn.query('INSERT INTO fms_step_doers (step_id,user_id) VALUES ?',
        [s.doers.map(uid => [stepId, uid])]);
    }
    if (s.extraInput === 'yes' && s.extraRows?.length) {
      await conn.query(
        `INSERT INTO fms_extra_rows (step_id,row_label,col_letter,field_type,dropdown_options,required) VALUES ?`,
        [s.extraRows.map(row => [
          stepId, row.label || row.col_letter || '', row.col_letter || '',
          row.field_type || 'text', row.dropdown_options || '',
          (row.required === false || row.required === 0) ? 0 : 1])]);
    }
  }
}

router.post('/fms', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { fmsName, sheetName, sheetId, headerRow, totalSteps, steps } = req.body;
    const [result] = await conn.query(
      `INSERT INTO fms_sheets (fms_name,sheet_name,sheet_id,header_row,total_steps,created_by) VALUES (?,?,?,?,?,?)`,
      [fmsName || sheetName, sheetName, sheetId, headerRow || 1, totalSteps || 1, req.session.userId]);
    await writeSteps(conn, result.insertId, steps || []);
    await conn.commit();
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally { conn.release(); }
}));

router.put('/fms/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { fmsName, sheetName, sheetId, headerRow, steps } = req.body;
    await conn.query(
      `UPDATE fms_sheets SET fms_name=?,sheet_name=?,sheet_id=?,header_row=?,total_steps=? WHERE id=?`,
      [fmsName || sheetName, sheetName, sheetId, headerRow || 1, (steps || []).length, req.params.id]);

    // Children are cleared with two set-based DELETEs rather than two per step.
    const [oldSteps] = await conn.query('SELECT id FROM fms_steps WHERE fms_id=?', [req.params.id]);
    if (oldSteps.length) {
      const ids = oldSteps.map(s => s.id);
      const ph = placeholders(ids);
      await conn.query(`DELETE FROM fms_step_doers WHERE step_id IN (${ph})`, ids);
      await conn.query(`DELETE FROM fms_extra_rows WHERE step_id IN (${ph})`, ids);
    }
    await conn.query('DELETE FROM fms_steps WHERE fms_id=?', [req.params.id]);

    await writeSteps(conn, req.params.id, steps || []);
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally { conn.release(); }
}));

router.delete('/fms/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  await db.query('DELETE FROM fms_sheets WHERE id=?', [req.params.id]);
  res.json({ success: true });
}));

// Header row only — fast even on a 10 000-row sheet.
router.post('/fms/fetch-headers', requireAuth, asyncRoute(async (req, res) => {
  const { sheetId, sheetName, headerRow } = req.body;
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });
  const api = await google.getReadClient();
  const hRow = parseInt(headerRow, 10) || 1;
  const response = await api.spreadsheets.values.get({
    spreadsheetId: extractSpreadsheetId(sheetId),
    range: sheetName ? `${sheetName}!${hRow}:${hRow}` : `${hRow}:${hRow}`,
    majorDimension: 'ROWS',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const headers = ((response.data.values || [[]])[0] || [])
    .map((h, i) => ({ name: String(h ?? '').trim() || `COL_${idxToCol(i)}`, col: idxToCol(i), index: i }))
    .filter(h => String(h.name).trim().length > 0);
  res.json({ headers });
}));

// Full sync — returns every data row so the admin screen can preview them.
router.get('/fms/:id/sync', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const sheet = await db.one('SELECT * FROM fms_sheets WHERE id=?', [req.params.id]);
  if (!sheet) throw httpError(404, 'FMS not found');
  const headerRowIdx = (sheet.header_row || 1) - 1;
  // sheet.sheet_name is the actual tab name — not a hardcoded 'Sheet1'.
  const allRows = await google.readValues(
    extractSpreadsheetId(sheet.sheet_id), sheet.sheet_name || 'Sheet1', { fresh: true });
  if (allRows.length <= headerRowIdx) {
    return res.status(400).json({ error: `Sheet has only ${allRows.length} rows but header row is set to ${sheet.header_row}` });
  }
  const headers = allRows[headerRowIdx].filter(h => h && h.trim());
  const dataRows = allRows.slice(headerRowIdx + 1);
  res.json({ success: true, headers, totalRows: dataRows.length, headerRow: sheet.header_row, sample: dataRows });
}));

// ══════════════════════════════════════════════════════
// FMS TASKS (every user)
// ══════════════════════════════════════════════════════
router.get('/fms-tasks', requireAuth, asyncRoute(async (req, res) => {
  const isAdmin = req.session.role === 'admin';
  const list = isAdmin
    ? await db.rows('SELECT * FROM fms_sheets ORDER BY created_at DESC')
    : await db.rows(
      `SELECT DISTINCT fs.* FROM fms_sheets fs
         JOIN fms_steps fst ON fst.fms_id=fs.id
         JOIN fms_step_doers fsd ON fsd.step_id=fst.id
        WHERE fsd.user_id=? ORDER BY fs.created_at DESC`, [req.session.userId]);
  res.json(list);
}));

router.get('/fms-tasks/:id', requireAuth, asyncRoute(async (req, res) => {
  const sheet = await db.one('SELECT * FROM fms_sheets WHERE id=?', [req.params.id]);
  if (!sheet) throw httpError(404, 'FMS not found');
  const steps = await db.rows(
    `SELECT ${fmsRepo.STEP_COLUMNS} FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC`, [req.params.id]);
  await fmsRepo.decorateSteps(steps, {
    withExtraRows: true,
    viewerId: req.session.userId,
    isAdmin: req.session.role === 'admin',
  });
  res.json({ sheet, steps });
}));

// Pending rows of a step (plan filled, actual empty).
router.get('/fms-tasks/:fmsId/steps/:stepId/rows', requireAuth, asyncRoute(async (req, res) => {
  const isAdmin = req.session.role === 'admin';
  const [sheet, step, currentUser] = await Promise.all([
    db.one('SELECT * FROM fms_sheets WHERE id=?', [req.params.fmsId]),
    db.one('SELECT * FROM fms_steps WHERE id=? AND fms_id=?', [req.params.stepId, req.params.fmsId]),
    db.one('SELECT name FROM users WHERE id=?', [req.session.userId]),
  ]);
  if (!sheet) throw httpError(404, 'FMS not found');
  if (!step) throw httpError(404, 'Step not found');

  const myName = (currentUser?.name || '').trim().toLowerCase();
  const planIdx = colToIdx(step.plan_col);
  const actualIdx = colToIdx(step.actual_col);
  const doerNameIdx = step.doer_name_col ? colToIdx(step.doer_name_col) : -1;
  const showCols = fmsRepo.parseShowCols(step);

  // Fetch only as far as the furthest needed column.
  const maxIdx = Math.max(planIdx, actualIdx, doerNameIdx, ...(showCols.length ? showCols : [0]));
  const allRows = await google.readValues(
    extractSpreadsheetId(sheet.sheet_id),
    `${sheet.sheet_name || 'Sheet1'}!A:${maxIdx >= 0 ? idxToCol(maxIdx) : 'Z'}`);

  const headerRowIdx = (sheet.header_row || 1) - 1;
  const headers = allRows[headerRowIdx] || [];
  const dataRows = allRows.slice(headerRowIdx + 1);

  // Non-admins see only their own rows; admins see all.
  const applyDoerFilter = !isAdmin && doerNameIdx >= 0 && !!myName;

  const matchedRows = [];
  let totalPending = 0;
  let assignedToMe = 0;
  dataRows.forEach((row, i) => {
    const planVal = planIdx >= 0 ? (row[planIdx] || '').trim() : '';
    const actualVal = actualIdx >= 0 ? (row[actualIdx] || '').trim() : '';
    if (!planVal || actualVal) return;   // not pending
    totalPending++;

    const rowDoer = doerNameIdx >= 0 ? (row[doerNameIdx] || '').trim() : '';
    const isMine = rowDoer.toLowerCase() === myName;
    if (isMine) assignedToMe++;
    if (applyDoerFilter && !isMine) return;

    let colsToShow = showCols.length ? showCols : headers.map((_, hi) => hi);
    // The plan column is mandatory, so it is always shown.
    if (planIdx >= 0 && !colsToShow.includes(planIdx)) colsToShow = [planIdx, ...colsToShow];
    const rowData = {};
    for (const ci of colsToShow) rowData[headers[ci] || `COL ${idxToCol(ci)}`] = row[ci] || '';

    matchedRows.push({
      sheetRowNumber: headerRowIdx + 1 + i + 1,
      planValue: planVal,
      actualValue: actualVal,
      rowDoerName: rowDoer,
      isMine,
      data: rowData,
    });
  });

  res.json({
    rows: matchedRows, headers,
    total: matchedRows.length, totalPending, assignedToMe,
    filtered: applyDoerFilter,
    doerColumn: step.doer_name_col || null,
    isAdmin,
  });
}));

// Mark a row done — writes the actual timestamp, the delay reason, any extra
// inputs and the doer name. All of it goes out in ONE batchUpdate instead of
// up to five sequential Sheets round trips.
router.post('/fms-tasks/:fmsId/steps/:stepId/done', requireAuth, asyncRoute(async (req, res) => {
  const { rowNumber, actualValue, delayReason, extraInputs } = req.body;
  if (!rowNumber || !actualValue) return res.status(400).json({ error: 'rowNumber and actualValue required' });

  const [sheet, step] = await Promise.all([
    db.one('SELECT * FROM fms_sheets WHERE id=?', [req.params.fmsId]),
    db.one('SELECT * FROM fms_steps WHERE id=? AND fms_id=?', [req.params.stepId, req.params.fmsId]),
  ]);
  if (!sheet) throw httpError(404, 'FMS not found');
  if (!step) throw httpError(404, 'Step not found');

  const actualCol = (step.actual_col || '').toUpperCase();
  if (!actualCol) return res.status(400).json({ error: 'Actual column not configured for this step' });

  const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
  const tabName = sheet.sheet_name || 'Sheet1';

  const data = [{ range: `${tabName}!${actualCol}${rowNumber}`, values: [[istSheetSerialNow()]] }];

  if (delayReason && step.delay_reason_col) {
    data.push({ range: `${tabName}!${step.delay_reason_col.toUpperCase()}${rowNumber}`, values: [[delayReason]] });
  }
  if (extraInputs && extraInputs.length) {
    for (const ei of extraInputs) {
      if (ei.colLetter && ei.value !== undefined && ei.value !== '') {
        data.push({ range: `${tabName}!${ei.colLetter.toUpperCase()}${rowNumber}`, values: [[ei.value]] });
      }
    }
  }
  if (step.doer_name_col) {
    const user = await db.one('SELECT name FROM users WHERE id=? LIMIT 1', [req.session.userId]);
    if (user?.name) {
      data.push({ range: `${tabName}!${step.doer_name_col.toUpperCase()}${rowNumber}`, values: [[user.name]] });
    }
  }

  const api = await google.getWriteClient();
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  // The row just changed — drop any cached read of this sheet.
  google.invalidateSheet(spreadsheetId);

  res.json({ success: true });
}));

module.exports = router;
