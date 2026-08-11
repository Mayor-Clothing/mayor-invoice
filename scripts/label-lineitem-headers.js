// One-time: (1) ensure the detail tabs are wide enough for the new per-item
// columns, then (2) label the row-1 header cells (BH1:BQ1) for
// product_page/mockup, next to the existing "Rush Fee" (BG1).
//
// Why the grid widen matters: the Order Confirmations tab was only 59 columns
// wide, so a values.update of a 69-column detail row ("exceeds grid limits")
// would have FAILED once Hermes/manual writes include product_page/mockup.
// We widen to NEED_COLS (headroom for field #8) so writes + headers both fit.
// Header text itself is cosmetic — code reads columns positionally (mo-sheet.js).
//
//   node --env-file=.env scripts/label-lineitem-headers.js            (dry run)
//   node --env-file=.env scripts/label-lineitem-headers.js --confirm
//
// Columns (mo-sheet.js): BH..BL = product_page_1..5, BM..BQ = mockup_1..5.
const { google } = require('googleapis');

const SHEET_ID = process.env.MO_SHEET_ID;
const CONFIRM = process.argv.includes('--confirm');
const TABS = ['Invoices', 'Order Confirmations'];
const RANGE = 'BH1:BQ1';
const NEED_COLS = 80; // 69 live columns + headroom (field #8, etc.)
const HEADERS = [
  'Product Page 1', 'Product Page 2', 'Product Page 3', 'Product Page 4', 'Product Page 5',
  'Mockup 1', 'Mockup 2', 'Mockup 3', 'Mockup 4', 'Mockup 5',
];

async function main() {
  if (!SHEET_ID) { console.error('MO_SHEET_ID not set'); process.exit(1); }
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  // Resolve sheetId + current width for each target tab.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets(properties(sheetId,title,gridProperties(columnCount)))' });
  const byTitle = {};
  meta.data.sheets.forEach((s) => { byTitle[s.properties.title] = s.properties; });

  const widenReqs = [];
  for (const tab of TABS) {
    const p = byTitle[tab];
    if (!p) { console.error(`tab not found: ${tab}`); process.exit(1); }
    const cols = p.gridProperties.columnCount;
    console.log(`${tab}: ${cols} cols${cols < NEED_COLS ? ` -> widen to ${NEED_COLS}` : ' (wide enough)'}`);
    if (cols < NEED_COLS) {
      widenReqs.push({ updateSheetProperties: { properties: { sheetId: p.sheetId, gridProperties: { columnCount: NEED_COLS } }, fields: 'gridProperties.columnCount' } });
    }
  }
  console.log(`\n${CONFIRM ? 'WRITING' : 'DRY RUN — would write'} ${RANGE} on ${TABS.join(' + ')}:`);
  console.log('  ' + HEADERS.join(' | '));
  if (!CONFIRM) { console.log('\nRe-run with --confirm to apply.'); return; }

  if (widenReqs.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, resource: { requests: widenReqs } });
    console.log(`widened ${widenReqs.length} tab(s)`);
  }
  for (const tab of TABS) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${tab}!${RANGE}`,
      valueInputOption: 'USER_ENTERED', resource: { values: [HEADERS] },
    });
    console.log(`  wrote ${tab}!${RANGE}`);
  }
  console.log('Done.');
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
