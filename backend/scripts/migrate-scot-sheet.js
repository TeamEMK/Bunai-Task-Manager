// ════════════════════════════════════════════════════════════════════════
//  migrate-scot-sheet.js — makes room for a "Last Order" column on the SCOT
//  Sheet tab.
//
//    node backend/scripts/migrate-scot-sheet.js            dry run, changes nothing
//    node backend/scripts/migrate-scot-sheet.js --apply    does it
//
//  The tab's thirteen fixed columns (A to M) are followed straight away by the
//  364-day date grid, which starts in N. Last Order goes in N, so the grid has
//  to move one column right to O. Doing that with Google's own "insert
//  column" moves the grid's week bands, the merged title and the banding with
//  it, which writing the cells somewhere else would not.
//
//  Run it BEFORE the next full write of the tab with the matching code
//  (backend/scot-sheet.js, GRID_START = 14), which fills the column in and
//  rewrites the Dashboard's formulas to point at O:NN. The tab is rewritten
//  whole every day, so a run of the OLD code in between would lay the grid
//  from N again: consistent, but a column out from its bands until the new code
//  runs.
//
//  It refuses a tab that does not look exactly as expected, so a second run
//  does not insert a second column.
// ════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const path = require('path');
const config = require(path.join(__dirname, '..', 'src', 'config'));
const google = require(path.join(__dirname, '..', 'src', 'services', 'google'));

const APPLY = process.argv.includes('--apply');
const TAB = 'SCOT Sheet';
const HEADER_ROW = 4;                 // 1-based
const LAST_FIXED = 'Frequency Of Calling';   // M4, the last of the thirteen
const NEW_COL = 13;                   // N, 0-based

async function main() {
  const id = config.sheets.scot && config.sheets.scot.id;
  if (!id) throw new Error('SCOT_SHEET_ID is not set');

  const api = await google.getWriteClient();
  const meta = await api.spreadsheets.get({
    spreadsheetId: id, fields: 'sheets(properties(sheetId,title,gridProperties))',
  });
  const tab = meta.data.sheets.find(s => s.properties.title === TAB);
  if (!tab) throw new Error(`the sheet has no tab called "${TAB}"`);
  const sheetId = tab.properties.sheetId;
  const rowCount = tab.properties.gridProperties.rowCount;

  const [head] = await google.readValues(id, `${TAB}!A${HEADER_ROW}:O${HEADER_ROW}`, { fresh: true });
  const have = (head || []).map(h => String(h || '').trim());
  console.log('Sheet :', id, '| tab:', TAB, '| rows:', rowCount);
  console.log('Row 4 :', have.slice(0, 15).join(' | '));

  if (have[NEW_COL] === 'Last Order') { console.log('\nAlready has a Last Order column - nothing to do.'); return; }
  if (have[NEW_COL - 1] !== LAST_FIXED || !have[NEW_COL]) {
    console.log(`\nColumn M is not "${LAST_FIXED}", or the date grid does not start in N, so this will not touch it.`);
    process.exitCode = 1;
    return;
  }

  const col = (c, r0, r1) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c, endColumnIndex: c + 1 });
  const requests = [
    // inheritFromBefore: the new column looks like M, not like the first date
    { insertDimension: { range: { sheetId, dimension: 'COLUMNS', startIndex: NEW_COL, endIndex: NEW_COL + 1 }, inheritFromBefore: true } },
    { copyPaste: { source: col(NEW_COL - 1, HEADER_ROW - 1, HEADER_ROW), destination: col(NEW_COL, HEADER_ROW - 1, HEADER_ROW), pasteType: 'PASTE_FORMAT' } },
    { updateCells: { range: col(NEW_COL, HEADER_ROW - 1, HEADER_ROW), rows: [{ values: [{ userEnteredValue: { stringValue: 'Last Order' } }] }], fields: 'userEnteredValue' } },
    // shown the way "Customer Since" is: 8-Dec-2020
    { repeatCell: { range: col(NEW_COL, HEADER_ROW, rowCount),
      cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'd-mmm-yyyy' } } }, fields: 'userEnteredFormat.numberFormat' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: NEW_COL, endIndex: NEW_COL + 1 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } },
  ];

  console.log('\nPlan:');
  console.log('  1. insert a column at N; the date grid moves to O (week bands, banding and the title merge move with it)');
  console.log('  2. N4 = "Last Order", styled like M4; N5 down shown as d-mmm-yyyy');
  console.log('  Result: ... Frequency Of Calling | Last Order | <dates from O>');

  if (!APPLY) { console.log('\nDry run - nothing changed. Add --apply to do it.'); return; }

  await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests } });
  google.invalidateSheet(id);
  const [after] = await google.readValues(id, `${TAB}!A${HEADER_ROW}:P${HEADER_ROW}`, { fresh: true });
  const got = (after || []).map(h => String(h || '').trim());
  const ok = got[NEW_COL - 1] === LAST_FIXED && got[NEW_COL] === 'Last Order' && got[NEW_COL + 1] === have[NEW_COL];
  console.log('\nRow 4 now:', got.join(' | '));
  console.log(ok ? 'Done - Last Order is in N and the grid starts in O.' : 'WARNING - not what was expected; check the sheet.');
  if (!ok) process.exitCode = 1;
}

main().catch(e => { console.error('✗ migrate-scot-sheet:', e.message); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
