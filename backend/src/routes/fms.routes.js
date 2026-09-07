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
const fmsColumns = require('../services/fmsColumns');
const fmsDetect = require('../services/fmsDetect');
const sheetIntrospect = require('../services/sheetIntrospect');
const multer = require('multer');

// A file field's value in the sheet is a Drive link, so the upload happens
// before the row is written. Kept in memory: the deployment targets have
// read-only or ephemeral filesystems.
const fmsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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

// IMPORTANT: must stay above /api/fms/:id.
// Reads the sheet and proposes the whole step configuration — names, plan and
// actual columns, doers, and each step's remaining columns as typed extra
// inputs. Nothing is saved: the admin sees the suggestion on the same screen
// and corrects it before saving, which is why every rule here prefers an empty
// field over a confident guess.
router.post('/fms/detect-steps', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const { sheetId, sheetName, headerRow } = req.body;
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });

  // Sheet failures are the common case here — wrong tab name, or the file never
  // shared with the identity this server actually signs as. The generic handler
  // turns those into a bare "Sheet not found", which leaves the admin staring
  // at an empty screen with nothing to act on. So they are answered properly.
  try {
    return await runDetection(req, res);
  } catch (err) {
    const status = err.code === 403 || err.code === 404 ? 400 : 500;
    const account = google.serviceAccountEmail();
    const hint = err.code === 403
      ? `This server reads sheets as ${account || 'its service account'}. Share the sheet with that address (Viewer is enough).`
      : err.code === 404
        ? 'Check the Sheet ID and that the tab name matches exactly, including spaces.'
        : '';
    console.error('  ❌ detect-steps:', err.code || '', err.message);
    return res.status(status).json({
      error: `${err.message}${hint ? ' — ' + hint : ''}`,
      serviceAccount: account,
      googleCode: err.code || null,
    });
  }
}));

async function runDetection(req, res) {
  const { sheetId, sheetName, headerRow } = req.body;
  const askedRow = Math.max(1, parseInt(headerRow, 10) || 1);
  let usedRow = askedRow;
  let meta = await sheetIntrospect.readColumnMeta(sheetId, sheetName, usedRow);
  let detected = fmsDetect.detectSteps(meta.columns, { labelRows: meta.labelRows });

  // A sheet often opens with a banner block — a timestamp, a legend, the step
  // names — and the real header row sits below it. Rather than showing an empty
  // screen and leaving the admin to guess the number, find the row that carries
  // the plan/actual pairs and use that, saying so in the response.
  if (!detected.steps.length) {
    const firstRows = await google.readValues(
      extractSpreadsheetId(sheetId), `${sheetName || 'Sheet1'}!1:20`);
    const guess = fmsDetect.guessHeaderRow(firstRows);
    if (guess && guess !== usedRow) {
      usedRow = guess;
      meta = await sheetIntrospect.readColumnMeta(sheetId, sheetName, usedRow);
      detected = fmsDetect.detectSteps(meta.columns, { labelRows: meta.labelRows });
    }
  }

  // ── Doers, matched against the app's user list ──
  // Read each distinct doer column in full rather than trusting the sample: a
  // name that appears only on row 200 should still be matched.
  const doerCols = [...new Set(detected.steps.map(s => s.doerNameCol).filter(Boolean))];
  const users = await db.rows('SELECT id, name FROM users');
  // Two people with the same name cannot be told apart, so that name matches
  // nobody — assigning either one would be a coin flip on someone's work.
  const byName = new Map();
  for (const u of users) {
    const key = u.name.trim().toLowerCase();
    byName.set(key, byName.has(key) ? null : u);
  }

  const columnNames = new Map();
  await Promise.all(doerCols.map(async (col) => {
    try {
      const vals = await google.readValues(meta.spreadsheetId, `${meta.tab}!${col}:${col}`);
      const skip = usedRow;
      columnNames.set(col, [...new Set(
        vals.slice(skip).map(r => String(r[0] ?? '').trim()).filter(Boolean))]);
    } catch (_) { columnNames.set(col, []); }
  }));

  for (const step of detected.steps) {
    if (!step.doerNameCol) continue;
    const names = columnNames.get(step.doerNameCol) || [];
    const matched = [];
    const unmatched = [];
    for (const n of names) {
      const u = byName.get(n.toLowerCase());
      if (u) matched.push({ id: u.id, name: u.name, sheetName: n });
      else unmatched.push(n);          // ambiguous or unknown — left unassigned
    }
    step.doers = matched.map(m => m.id);
    step.doerMatches = matched;
    step.doerUnmatched = unmatched;
  }

  res.json({
    headers: meta.headers,
    steps: detected.steps,
    leadingColumns: detected.leadingColumns,
    // Columns deliberately left out, with the reason, so nothing disappears
    // without the admin being told.
    // The row the columns were actually read from, and whether that differs
    // from what was typed — the screen updates its field to match.
    headerRow: usedRow,
    headerRowAdjusted: usedRow !== askedRow,
    skipped: detected.skipped,
    // Columns that were mapped but come with a caveat — a formula the app would
    // overwrite, say. Shown, never acted on silently.
    warnings: detected.steps.flatMap((st, i) => (st.warnings || []).map(w => ({ ...w, step: i + 1 }))),
    detectedSteps: detected.steps.length,
  });
}

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
async function writeSteps(conn, fmsId, steps, headers = []) {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    // Every letter the admin picked is recorded alongside the header NAME it
    // pointed at. The letter is only a fallback from here on; the name is what
    // survives someone inserting a column in the sheet.
    const asStep = {
      plan_col: s.planCol || '', actual_col: s.actualCol || '',
      doer_name_col: s.doerNameCol || '', delay_reason_col: s.delayReasonCol || '',
    };
    const headerMap = fmsColumns.buildHeaderMap(asStep, [], headers);
    headerMap.show = fmsColumns.buildShowMap(s.showCols || [], headers);

    const [sr] = await conn.query(
      `INSERT INTO fms_steps (fms_id,step_order,step_name,plan_col,actual_col,extra_input,extra_col,show_cols,delay_reason_col,doer_name_col,header_map)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [fmsId, i + 1, s.stepName, s.planCol || '', s.actualCol || '', s.extraInput || 'no',
       s.extraCol || '', JSON.stringify(s.showCols || []), s.delayReasonCol || '', s.doerNameCol || '',
       JSON.stringify(headerMap)]);
    const stepId = sr.insertId;

    if (s.doers?.length) {
      await conn.query('INSERT INTO fms_step_doers (step_id,user_id) VALUES ?',
        [s.doers.map(uid => [stepId, uid])]);
    }
    if (s.extraInput === 'yes' && s.extraRows?.length) {
      await conn.query(
        `INSERT INTO fms_extra_rows (step_id,row_label,col_letter,field_type,dropdown_options,required,header_name,header_occ) VALUES ?`,
        [s.extraRows.map(row => {
          const h = fmsColumns.buildRowHeader(row, headers);
          return [
            stepId, row.label || row.col_letter || '', row.col_letter || '',
            row.field_type || 'text', row.dropdown_options || '',
            (row.required === false || row.required === 0) ? 0 : 1,
            h.header_name, h.header_occ];
        })]);
    }
  }
}

// The header row as it stands right now. Saving an FMS reads it once so the
// mapping is recorded against what the sheet actually says today.
async function currentHeaders(sheetId, sheetName, headerRow) {
  try {
    const row = Math.max(1, parseInt(headerRow, 10) || 1);
    const values = await google.readValues(
      extractSpreadsheetId(sheetId), `${sheetName || 'Sheet1'}!${row}:${row}`, { fresh: true });
    return (values[0] || []).map(h => String(h ?? '').trim());
  } catch (e) {
    // A sheet that cannot be read must not block saving the configuration —
    // the letters still work, and the mapping fills in on the next save.
    console.warn('  ⚠️ FMS save: header row unreadable —', e.message);
    return [];
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
    await writeSteps(conn, result.insertId, steps || [], await currentHeaders(sheetId, sheetName, headerRow));
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

    await writeSteps(conn, req.params.id, steps || [], await currentHeaders(sheetId, sheetName, headerRow));
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

// One-time, fire-and-forget: gives a pre-mapping step its header names. It runs
// on a read, so a failure must never affect the response — the letters keep
// working either way and the next read tries again.
function backfillHeaderMap(step, extraRows, headers) {
  (async () => {
    const map = fmsColumns.buildHeaderMap(step, extraRows, headers);
    map.show = fmsColumns.buildShowMap(fmsRepo.parseShowCols(step), headers);
    await db.query('UPDATE fms_steps SET header_map=? WHERE id=?', [JSON.stringify(map), step.id]);
    for (const row of extraRows) {
      const h = fmsColumns.buildRowHeader(row, headers);
      if (!h.header_name) continue;
      await db.query('UPDATE fms_extra_rows SET header_name=?, header_occ=? WHERE id=?',
        [h.header_name, h.header_occ, row.id]);
    }
    console.log(`  ✅ FMS step ${step.id}: column mapping backfilled from header names`);
  })().catch(e => console.warn('  ⚠️ FMS header-map backfill:', e.message));
}

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
  const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
  const tabName = sheet.sheet_name || 'Sheet1';
  const headerRowIdx = (sheet.header_row || 1) - 1;

  // Resolve the step's columns against the header row BEFORE deciding what to
  // read. Sizing the range from the stored letters would read the old
  // positions, which is the bug this mapping exists to prevent.
  const extraRows = await db.rows(
    `SELECT id, col_letter, header_name, header_occ FROM fms_extra_rows WHERE step_id=? ORDER BY id ASC`,
    [step.id]);
  const headerOnly = await google.readValues(spreadsheetId, `${tabName}!${headerRowIdx + 1}:${headerRowIdx + 1}`);
  const headerRowValues = headerOnly[0] || [];
  let cols = fmsColumns.resolveStep(step, extraRows, headerRowValues);
  // An FMS configured before header mapping existed has letters only. The
  // letters still point at the right columns TODAY, so this is the moment to
  // record what they are called — after which the mapping survives a move.
  if (!cols.mapped && headerRowValues.length) backfillHeaderMap(step, extraRows, headerRowValues);

  const planIdx = cols.plan;
  const actualIdx = cols.actual;
  const doerNameIdx = cols.doer;
  const showCols = cols.show;

  // Fetch only as far as the furthest needed column.
  const maxIdx = Math.max(planIdx, actualIdx, doerNameIdx, ...(showCols.length ? showCols : [0]));
  const allRows = await google.readValues(
    spreadsheetId, `${tabName}!A:${maxIdx >= 0 ? idxToCol(maxIdx) : 'Z'}`);

  const headers = allRows[headerRowIdx] || headerOnly[0] || [];
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
    doerColumn: doerNameIdx >= 0 ? idxToCol(doerNameIdx) : null,
    // Non-empty when a mapped header no longer exists in the sheet. The screen
    // can say so instead of quietly showing the wrong column.
    unresolved: cols.unresolved,
    isAdmin,
  });
}));

// Uploads one file for a `file` extra input and returns the link to store.
router.post('/fms-tasks/upload', requireAuth, fmsUpload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A file is required' });
  const url = await google.uploadToDrive(req.file.buffer, req.file.originalname, req.file.mimetype, 'FMS');
  res.json({ url });
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

  const spreadsheetId = extractSpreadsheetId(sheet.sheet_id);
  const tabName = sheet.sheet_name || 'Sheet1';
  const headerRowIdx = (sheet.header_row || 1) - 1;

  // Writing is where a stale column does real damage: it puts a timestamp on
  // somebody else's step. So the target is resolved from the header row here
  // too, exactly as on the read path — never from the letter the browser sent.
  const extraRows = await db.rows(
    `SELECT id, col_letter, header_name, header_occ FROM fms_extra_rows WHERE step_id=? ORDER BY id ASC`,
    [step.id]);
  const headerOnly = await google.readValues(
    spreadsheetId, `${tabName}!${headerRowIdx + 1}:${headerRowIdx + 1}`, { fresh: true });
  const cols = fmsColumns.resolveStep(step, extraRows, headerOnly[0] || []);

  const actualCol = fmsColumns.letterAt(cols.actual);
  if (!actualCol) return res.status(400).json({ error: 'Actual column not configured for this step' });

  const data = [{ range: `${tabName}!${actualCol}${rowNumber}`, values: [[istSheetSerialNow()]] }];

  const delayCol = fmsColumns.letterAt(cols.delay);
  if (delayReason && delayCol) {
    data.push({ range: `${tabName}!${delayCol}${rowNumber}`, values: [[delayReason]] });
  }
  if (extraInputs && extraInputs.length) {
    // Match on the row id, not the letter. The browser holds the configuration
    // it was handed when the page loaded; the sheet may have moved since.
    const byId = new Map(extraRows.map(r => [String(r.id), r]));
    for (const ei of extraInputs) {
      if (ei.value === undefined || ei.value === '') continue;
      const row = ei.rowId != null ? byId.get(String(ei.rowId)) : null;
      const letter = row
        ? fmsColumns.letterAt(cols.extras[row.id])
        : (ei.colLetter || '').toUpperCase();   // older client — fall back to what it sent
      if (letter) data.push({ range: `${tabName}!${letter}${rowNumber}`, values: [[ei.value]] });
    }
  }
  const doerCol = fmsColumns.letterAt(cols.doer);
  if (doerCol) {
    const user = await db.one('SELECT name FROM users WHERE id=? LIMIT 1', [req.session.userId]);
    if (user?.name) {
      data.push({ range: `${tabName}!${doerCol}${rowNumber}`, values: [[user.name]] });
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
