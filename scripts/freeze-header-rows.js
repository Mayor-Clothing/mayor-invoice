// One-time: freezes row 1 (the header row) on the sheet's main tabs, so
// scrolling through orders keeps column headers visible.
//
// Run:
//   GOOGLE_SERVICE_ACCOUNT='<json>' node scripts/freeze-header-rows.js

const { google } = require('googleapis');

const SHEET_ID = process.env.MO_SHEET_ID || '152hyxQz87IwPYl2lgBCm6pKKSjYl1hoL-AuZu-wODbo';
const TABS = ['Invoices', 'Order Confirmations', 'Order Info', 'Users'];

async function getSheets() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
  if (!creds.client_email) throw new Error('GOOGLE_SERVICE_ACCOUNT env var not set (or missing client_email)');
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

async function main() {
  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const byTitle = new Map(meta.data.sheets.map(s => [s.properties.title, s.properties.sheetId]));

  const requests = [];
  for (const title of TABS) {
    const sheetId = byTitle.get(title);
    if (sheetId === undefined) { console.warn(`  ! tab not found: ${title}`); continue; }
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });
  }

  if (!requests.length) { console.log('No matching tabs found, nothing to do.'); return; }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
  console.log(`Froze row 1 on: ${TABS.filter(t => byTitle.has(t)).join(', ')}`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
