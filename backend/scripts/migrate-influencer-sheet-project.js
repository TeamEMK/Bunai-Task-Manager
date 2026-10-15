// ════════════════════════════════════════════════════════════════════════
//  migrate-influencer-sheet-project.js — adds a Project column, with a
//  dropdown of Bunai / Mulmul / Aaheli, to the team's influencer sheet.
//
//    node backend/scripts/migrate-influencer-sheet-project.js            dry run
//    node backend/scripts/migrate-influencer-sheet-project.js --apply    does it
//
//  The column goes in front of Collaboration Type:
//    ... Message Sent on Instagram | Project | Collaboration Type | Outfit ...
//
//  Safe to run before the app that fills it is live. The app finds each field
//  by the words in its header, so a column it does not know yet is simply left
//  blank, and nothing already there is moved out from under it.
//
//  Done with Google's own insert-column, so the Collaboration Type dropdown and
//  every row's data move with their columns. Refuses a sheet whose header row is
//  not the one it expects, so a second run does not insert a second column.
// ════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const path = require('path');
const config = require(path.join(__dirname, '..', 'src', 'config'));
const google = require(path.join(__dirname, '..', 'src', 'services', 'google'));

const APPLY = process.argv.includes('--apply');
const PROJECTS = ['Bunai', 'Mulmul', 'Aaheli'];

const BEFORE = ['Influencer Name', 'Profile Link', 'Message Sent on Instagram', 'Collaboration Type', 'Outfit',
  'Shipping Address', 'Email ID', 'Phone Number', 'Shipped On', 'Received On', 'Post Date', 'Remark'];
const AFTER = ['Influencer Name', 'Profile Link', 'Message Sent on Instagram', 'Project', 'Collaboration Type', 'Outfit',
  'Shipping Address', 'Email ID', 'Phone Number', 'Shipped On', 'Received On', 'Post Date', 'Remark'];
const NEW_COL = 3;        // D, 0-based: in front of Collaboration Type

async function main() {
  const { id, gid, startRow } = config.sheets.influencer;
  if (!id) throw new Error('INFLUENCER_SHEET_ID is not set');
  const tabName = await google.resolveTabNameByGid(id, gid);
  const headerRow = Math.max(1, startRow - 1);

  const [head] = await google.readValues(id, `${tabName}!A${headerRow}:AZ${headerRow}`, { fresh: true });
  const have = (head || []).map(h => String(h || '').trim());
  console.log('Sheet :', id, '| tab:', tabName, '| header row:', headerRow);
  console.log('Header:', have.join(' | '));

  if (AFTER.every((h, i) => have[i] === h)) { console.log('\nAlready has a Project column - nothing to do.'); return; }
  const isBefore = BEFORE.every((h, i) => have[i] === h) && have.slice(BEFORE.length).every(h => !h);
  if (!isBefore) {
    console.log('\nThe header row is not the layout this script expects, so it will not touch it.');
    console.log('Expected:', BEFORE.join(' | '));
    process.exitCode = 1;
    return;
  }

  const col = (c, r0, r1) => ({ sheetId: gid, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c, endColumnIndex: c + 1 });
  const requests = [
    // inheritFromBefore: the new column looks like Message Sent, not like Collaboration Type
    { insertDimension: { range: { sheetId: gid, dimension: 'COLUMNS', startIndex: NEW_COL, endIndex: NEW_COL + 1 }, inheritFromBefore: true } },
    // it is text, and must not inherit the date format of the column before it
    { repeatCell: { range: col(NEW_COL, 1, 1000), cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } }, fields: 'userEnteredFormat.numberFormat' } },
    { setDataValidation: {
      range: col(NEW_COL, 1, 1000),
      rule: { condition: { type: 'ONE_OF_LIST', values: PROJECTS.map(t => ({ userEnteredValue: t })) }, showCustomUi: true, strict: true },
    } },
    { copyPaste: { source: col(NEW_COL + 1, 0, 1), destination: col(NEW_COL, 0, 1), pasteType: 'PASTE_FORMAT' } },
    { updateCells: { range: col(NEW_COL, 0, 1), rows: [{ values: [{ userEnteredValue: { stringValue: 'Project' } }] }], fields: 'userEnteredValue' } },
    { updateDimensionProperties: { range: { sheetId: gid, dimension: 'COLUMNS', startIndex: NEW_COL, endIndex: NEW_COL + 1 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } },
  ];

  console.log('\nPlan:');
  console.log('  1. insert a "Project" column in front of Collaboration Type (D)');
  console.log('  2. its dropdown ->', PROJECTS.join(', '));
  console.log('  Result:', AFTER.join(' | '));

  if (!APPLY) { console.log('\nDry run - nothing changed. Add --apply to do it.'); return; }

  const api = await google.getWriteClient();
  await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests } });
  google.invalidateSheet(id);

  const [after] = await google.readValues(id, `${tabName}!A${headerRow}:AZ${headerRow}`, { fresh: true });
  const got = (after || []).map(h => String(h || '').trim());
  const ok = AFTER.every((h, i) => got[i] === h) && got.length === AFTER.length;
  console.log('\nHeader now:', got.join(' | '));
  console.log(ok ? 'Done - the header row matches.' : 'WARNING - the header row is not what was expected; check the sheet.');
  if (!ok) process.exitCode = 1;
}

main().catch(e => { console.error('✗ migrate-influencer-sheet-project:', e.message); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
