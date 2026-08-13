// Delete the AUDIT test rows. Dry run by default; --confirm to delete.
//   node --env-file=.env scripts/_cleanup-audit.js [--confirm]
const { google } = require('googleapis');

const SHEET_ID = process.env.MO_SHEET_ID;
const ORDERS = ['AUDIT-20260812A', 'AUDIT-20260812B', 'AUDIT-20260813C'];
const TABS = [['Order Confirmations', 5], ['Invoices', 5], ['Order Info', 0]];
const CONFIRM = process.argv.includes('--confirm');

async function main() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const idByTitle = new Map(meta.data.sheets.map(s => [s.properties.title, s.properties.sheetId]));

  for (const [tab, col] of TABS) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:CZ300` });
    const rows = r.data.values || [];
    // Match the order-number cell exactly — never a row that merely mentions it.
    const hits = rows.map((row, i) => [i, row]).filter(([i, row]) => i > 0 && ORDERS.includes(String(row[col] || '').trim()));
    if (!hits.length) { console.log(`${tab}: none`); continue; }
    for (const [i, row] of hits) console.log(`${tab} row ${i + 1}: ${String(row[col])}`);
    if (!CONFIRM) continue;
    for (const [i] of hits.slice().reverse()) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        resource: { requests: [{ deleteDimension: { range: { sheetId: idByTitle.get(tab), dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } }] },
      });
      console.log(`  deleted ${tab} row ${i + 1}`);
    }
  }
  if (!CONFIRM) console.log('\nDRY RUN — re-run with --confirm to delete.');
}
main().catch(e => { console.error(e.message); process.exit(1); });
