// One-off: give three run-on address blocks real line breaks. Splits only —
// no wording changes. Dry run by default; --confirm to write.
//   node --env-file=.env scripts/_fix-addresses.js [--confirm]
const { google } = require('googleapis');
const { COLUMNS } = require('../mo-sheet');

const SHEET_ID = process.env.MO_SHEET_ID;
const COL = Object.fromEntries(COLUMNS.map((c, i) => [c, i]));
const a1 = (c) => { let s = '', n = c; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };
const CONFIRM = process.argv.includes('--confirm');

// order number -> [run-on line, replacement lines]
const SPLITS = {
  '28986': [
    'Professional Shop Hawks Ridge Golf Club 1100 Hawks Club Drive',
    ['Professional Shop', 'Hawks Ridge Golf Club', '1100 Hawks Club Drive'],
  ],
  'Harford Mutual Insurance Group IV': [
    'Harford Mutual Insurance Group Sandi Taylor 200 North Main Street',
    ['Harford Mutual Insurance Group', 'Sandi Taylor', '200 North Main Street'],
  ],
};

// The Lakes separates its parts with a vertical tab + slash instead of newlines.
const unVerticalTab = (block) => block
  .split(/[\n\v\r\u2028\u2029]+/)
  .map((s) => s.trim().replace(/^\/\s*/, '').trim())
  .filter(Boolean)
  .join('\n');

function fixBlock(order, block) {
  let out = unVerticalTab(block);
  const split = SPLITS[order];
  if (split && out.includes(split[0])) out = out.replace(split[0], split[1].join('\n'));
  return out;
}

async function main() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const targets = ['28986', 'Harford Mutual Insurance Group IV', 'The Lakes Golf Club I'];

  const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Order Confirmations!A2:CZ300' })).data.values || [];
  const data = [];
  for (const order of targets) {
    const i = rows.findIndex((r) => String(r[COL.order_number] || '').trim() === order);
    if (i < 0) { console.log(`${order}: no OC row`); continue; }
    const r = rows[i];
    for (const field of ['address', 'shipping_address']) {
      const before = String(r[COL[field]] || '');
      if (!before.trim()) continue;
      const after = fixBlock(order, before);
      if (after === before.trim()) continue;
      console.log(`\n${order} — ${field} (deal ${r[COL.deal_id]}), OC row ${i + 2}`);
      console.log('  before: ' + JSON.stringify(before));
      console.log('  after:  ' + JSON.stringify(after));
      data.push({ range: `Order Confirmations!${a1(COL[field])}${i + 2}`, values: [[after]] });
    }
  }
  if (!data.length) { console.log('\nnothing to change'); return; }
  if (!CONFIRM) { console.log('\nDRY RUN — re-run with --confirm to write.'); return; }
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SHEET_ID, resource: { valueInputOption: 'RAW', data } });
  console.log(`\nwrote ${data.length} cell(s) to Order Confirmations`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
