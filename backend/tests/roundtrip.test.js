// End-to-end through the real database: the mapping is written the way the
// save path writes it, read back through the same queries the read path uses,
// and resolved against a sheet whose columns have moved.
const path = require('path');
process.chdir(path.join(__dirname, '..', '..'));
const B = path.join(__dirname, '..', 'src') + path.sep;
const { db } = require(B + 'db/pool');
const fmsRepo = require(B + 'services/fmsRepo');
const fmsColumns = require(B + 'services/fmsColumns');

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✓ ${label}`); return; }
  fail++;
  console.log(`  ✗ ${label}\n      got  ${g}\n      want ${w}`);
};

// The sheet at save time.
const HEADERS = ['SO', 'Planned', 'Actual', 'Done By', 'Cut Qty', 'Planned', 'Actual', 'Done By', 'Stitch Notes'];

(async () => {
  const [ins] = await db.query(
    `INSERT INTO fms_sheets (fms_name, sheet_name, sheet_id, header_row, total_steps, created_by)
     VALUES ('__roundtrip_test', 'Tab', 'fake-sheet-id', 1, 2, 1)`);
  const fmsId = ins.insertId;

  try {
    // ── save, the way writeSteps does it ──
    const stepIds = [];
    for (const [i, cfg] of [
      { planCol: 'B', actualCol: 'C', doerNameCol: 'D', extra: 'E' },
      { planCol: 'F', actualCol: 'G', doerNameCol: 'H', extra: 'I' },
    ].entries()) {
      const asStep = { plan_col: cfg.planCol, actual_col: cfg.actualCol, doer_name_col: cfg.doerNameCol, delay_reason_col: '' };
      const map = fmsColumns.buildHeaderMap(asStep, [], HEADERS);
      map.show = fmsColumns.buildShowMap([], HEADERS);
      const [sr] = await db.query(
        `INSERT INTO fms_steps (fms_id, step_order, step_name, plan_col, actual_col, extra_input, extra_col, show_cols, delay_reason_col, doer_name_col, header_map)
         VALUES (?,?,?,?,?,'yes','','[]','',?,?)`,
        [fmsId, i + 1, `Step ${i + 1}`, cfg.planCol, cfg.actualCol, cfg.doerNameCol, JSON.stringify(map)]);
      stepIds.push(sr.insertId);
      const h = fmsColumns.buildRowHeader({ col_letter: cfg.extra }, HEADERS);
      await db.query(
        `INSERT INTO fms_extra_rows (step_id, row_label, col_letter, field_type, dropdown_options, required, header_name, header_occ)
         VALUES (?,?,?,'text','',0,?,?)`,
        [sr.insertId, 'x', cfg.extra, h.header_name, h.header_occ]);
    }

    // ── read back through the very columns the app selects ──
    const steps = await db.rows(
      `SELECT ${fmsRepo.STEP_COLUMNS} FROM fms_steps WHERE fms_id=? ORDER BY step_order ASC`, [fmsId]);
    eq(steps.length, 2, 'both steps read back');
    eq(!!steps[0].header_map, true, 'header_map survived the round trip');

    const extrasByStep = await fmsRepo.extraRowsForSteps(stepIds);
    const e1 = extrasByStep.get(stepIds[0]) || [];
    eq([e1[0].header_name, e1[0].header_occ], ['Cut Qty', 0], 'extra row header round-tripped');

    // ── the sheet changes: a column is inserted at position 1 ──
    const shifted = ['SO', 'Priority', 'Planned', 'Actual', 'Done By', 'Cut Qty', 'Planned', 'Actual', 'Done By', 'Stitch Notes'];
    const r1 = fmsColumns.resolveStep(steps[0], extrasByStep.get(stepIds[0]) || [], shifted);
    const r2 = fmsColumns.resolveStep(steps[1], extrasByStep.get(stepIds[1]) || [], shifted);
    eq([r1.plan, r1.actual, r1.doer, r1.extras[e1[0].id]], [2, 3, 4, 5], 'step 1 followed the inserted column');
    const e2 = extrasByStep.get(stepIds[1]) || [];
    eq([r2.plan, r2.actual, r2.doer, r2.extras[e2[0].id]], [6, 7, 8, 9], 'step 2 followed it too, using ITS OWN "Planned"');
    eq([r1.mapped, r2.mapped], [true, true], 'resolved by name, not letter');

    // ── and the write path turns those into the letters it will write to ──
    eq([fmsColumns.letterAt(r2.actual), fmsColumns.letterAt(r2.doer)], ['H', 'I'],
      'mark-done would write to the moved columns, not the saved ones');
  } finally {
    const ids = await db.rows('SELECT id FROM fms_steps WHERE fms_id=?', [fmsId]);
    if (ids.length) {
      await db.query(`DELETE FROM fms_extra_rows WHERE step_id IN (${ids.map(() => '?').join(',')})`, ids.map(i => i.id));
    }
    await db.query('DELETE FROM fms_steps WHERE fms_id=?', [fmsId]);
    await db.query('DELETE FROM fms_sheets WHERE id=?', [fmsId]);
    console.log('\n  (test rows cleaned up)');
  }

  console.log(`\n${fail ? '❌' : '✅'}  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.stack); process.exit(1); });
