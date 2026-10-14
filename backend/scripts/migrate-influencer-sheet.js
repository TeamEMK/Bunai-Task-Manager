// ════════════════════════════════════════════════════════════════════════
//  migrate-influencer-sheet.js — brings the team's influencer sheet in line
//  with the form: no Status, an Outfit column, a Remark column.
//
//    node backend/scripts/migrate-influencer-sheet.js            dry run, changes nothing
//    node backend/scripts/migrate-influencer-sheet.js --apply    does it
//
//  BEFORE:  Influencer Name | Profile Link | Status | Message Sent on Instagram |
//           Collaboration Type | Shipping Address | Email ID | Phone Number |
//           Shipped On | Received On | Post Date
//  AFTER:   Influencer Name | Profile Link | Message Sent on Instagram |
//           Collaboration Type | Outfit | Shipping Address | Email ID |
//           Phone Number | Shipped On | Received On | Post Date | Remark
//
//  Run it only AFTER the app that writes by header name is live. The app that
//  came before wrote by position, and would put values under the wrong
//  headings the moment a column left.
//
//  It refuses to touch a sheet whose header row is not exactly the BEFORE
//  above, so a second run, or a sheet somebody has already rearranged, is left
//  alone rather than cut a second time.
//
//  Deleting a column and inserting one are done as Google does them, so every
//  row's data, the column widths and the dropdowns move with their columns.
//  The Collaboration Type dropdown is replaced with the five types the form
//  offers, because the old list would flag "Non Collab" and "PR" as invalid.
// ════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const path = require('path');
const config = require(path.join(__dirname, '..', 'src', 'config'));
const google = require(path.join(__dirname, '..', 'src', 'services', 'google'));

const APPLY = process.argv.includes('--apply');

const BEFORE = ['Influencer Name', 'Profile Link', 'Status', 'Message Sent on Instagram', 'Collaboration Type',
  'Shipping Address', 'Email ID', 'Phone Number', 'Shipped On', 'Received On', 'Post Date'];
const AFTER = ['Influencer Name', 'Profile Link', 'Message Sent on Instagram', 'Collaboration Type', 'Outfit',
  'Shipping Address', 'Email ID', 'Phone Number', 'Shipped On', 'Received On', 'Post Date', 'Remark'];
const TYPES = ['Barter', 'Paid', 'Sourcing', 'Non Collab', 'PR'];

const STATUS_COL = 2;       // C  - goes
const OUTFIT_COL = 4;       // E  - comes, once Status has gone: Collaboration Type is then D
const REMARK_COL = 11;      // L  - comes, at the end
const TYPE_COL = 3;         // D  - Collaboration Type, once Status has gone
const POST_DATE_COL = 10;   // K  - the formatting the two new headers copy

async function main() {
  const { id, gid, startRow } = config.sheets.influencer;
  if (!id) throw new Error('INFLUENCER_SHEET_ID is not set');
  const tabName = await google.resolveTabNameByGid(id, gid);
  const headerRow = Math.max(1, startRow - 1);

  const [head] = await google.readValues(id, `${tabName}!A${headerRow}:AZ${headerRow}`, { fresh: true });
  const have = (head || []).map(h => String(h || '').trim());
  console.log('Sheet :', id, '| tab:', tabName, '| header row:', headerRow);
  console.log('Header:', have.join(' | '));

  const alreadyDone = AFTER.every((h, i) => have[i] === h);
  if (alreadyDone) { console.log('\nAlready in the new layout - nothing to do.'); return; }
  const isBefore = BEFORE.every((h, i) => have[i] === h) && have.slice(BEFORE.length).every(h => !h);
  if (!isBefore) {
    console.log('\nThe header row is not the layout this script expects, so it will not touch it.');
    console.log('Expected:', BEFORE.join(' | '));
    process.exitCode = 1;
    return;
  }

  const lastRow = 1000;
  const rng = (col, r0, r1) => ({ sheetId: gid, startRowIndex: r0, endRowIndex: r1, startColumnIndex: col, endColumnIndex: col + 1 });
  const requests = [
    { deleteDimension: { range: { sheetId: gid, dimension: 'COLUMNS', startIndex: STATUS_COL, endIndex: STATUS_COL + 1 } } },
    { insertDimension: { range: { sheetId: gid, dimension: 'COLUMNS', startIndex: OUTFIT_COL, endIndex: OUTFIT_COL + 1 }, inheritFromBefore: true } },
    // the new column must not inherit the Collaboration Type dropdown beside it
    { setDataValidation: { range: rng(OUTFIT_COL, 1, lastRow) } },
    { setDataValidation: {
      range: rng(TYPE_COL, 1, lastRow),
      rule: { condition: { type: 'ONE_OF_LIST', values: TYPES.map(t => ({ userEnteredValue: t })) }, showCustomUi: true, strict: true },
    } },
    // headers: same look as the "Post Date" header beside them
    { copyPaste: { source: rng(POST_DATE_COL, 0, 1), destination: rng(OUTFIT_COL, 0, 1), pasteType: 'PASTE_FORMAT' } },
    { copyPaste: { source: rng(POST_DATE_COL, 0, 1), destination: rng(REMARK_COL, 0, 1), pasteType: 'PASTE_FORMAT' } },
    { updateCells: { range: rng(OUTFIT_COL, 0, 1), rows: [{ values: [{ userEnteredValue: { stringValue: 'Outfit' } }] }], fields: 'userEnteredValue' } },
    { updateCells: { range: rng(REMARK_COL, 0, 1), rows: [{ values: [{ userEnteredValue: { stringValue: 'Remark' } }] }], fields: 'userEnteredValue' } },
    { updateDimensionProperties: { range: { sheetId: gid, dimension: 'COLUMNS', startIndex: OUTFIT_COL, endIndex: OUTFIT_COL + 1 }, properties: { pixelSize: 260 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: gid, dimension: 'COLUMNS', startIndex: REMARK_COL, endIndex: REMARK_COL + 1 }, properties: { pixelSize: 300 }, fields: 'pixelSize' } },
  ];

  console.log('\nPlan:');
  console.log('  1. delete column C (Status), and its dropdown, with whatever is in it');
  console.log('  2. insert "Outfit" after Collaboration Type, with no dropdown');
  console.log('  3. Collaboration Type dropdown ->', TYPES.join(', '));
  console.log('  4. add "Remark" as the last column');
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

main().catch(e => { console.error('✗ migrate-influencer-sheet:', e.message); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
