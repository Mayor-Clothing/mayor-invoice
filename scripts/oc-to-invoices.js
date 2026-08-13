// Mirror the Order Confirmations tab (the truth document) into Invoices.
// OC is read-only here. Each Invoices row keeps its OWN Drive PDF Link — that
// file is the invoice, not the confirmation — everything else is overwritten.
// Rows with no Invoices counterpart are reported, never created: a new Invoices
// row makes the portal offer an invoice PDF for an order that has none.
//
//   node --env-file=.env scripts/oc-to-invoices.js            # dry run
//   node --env-file=.env scripts/oc-to-invoices.js --confirm
const { google } = require('googleapis');
const { COLUMNS } = require('../mo-sheet');

const SHEET_ID = process.env.MO_SHEET_ID;
const COL = Object.fromEntries(COLUMNS.map((c, i) => [c, i]));
const CONFIRM = process.argv.includes('--confirm');
// Invoice-only fields: an OC row never carries them, so copying its blank would
// destroy the invoice's PDF and (worse) its pay button.
const KEEP = ['drive_pdf_link', 'payment_link', 'payment_link_2'];
const a1 = (c) => { let s = '', n = c; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };
const norm = (v) => String(v || '').trim().replace(/\s+/g, ' ');

async function main() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const width = COLUMNS.length;
  const range = `!A1:${a1(width - 1)}300`;

  const [ocRes, invRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `Order Confirmations${range}` }),
    sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `Invoices${range}` }),
  ]);
  const ocRows = (ocRes.data.values || []).slice(1);
  const invRows = (invRes.data.values || []).slice(1);

  const data = [];
  const missing = [];
  let changedCells = 0;
  for (const oc of ocRows) {
    if (!oc.length) continue;
    const dealId = norm(oc[COL.deal_id]);
    const orderNumber = norm(oc[COL.order_number]);
    const i = invRows.findIndex((r) => (dealId && norm(r[COL.deal_id]) === dealId) || (!dealId && norm(r[COL.order_number]) === orderNumber));
    if (i < 0) { missing.push(orderNumber || dealId); continue; }
    const inv = invRows[i];
    const row = invRes.data.values.indexOf(inv) + 1;
    const next = [];
    for (let c = 0; c < width; c++) {
      const keep = KEEP.includes(COLUMNS[c]);
      next[c] = keep ? (inv[c] ?? '') : (oc[c] ?? '');
      if (String(next[c] ?? '') !== String(inv[c] ?? '')) changedCells++;
    }
    if (next.every((v, c) => String(v ?? '') === String(inv[c] ?? ''))) continue;
    data.push({ range: `Invoices!A${row}:${a1(width - 1)}${row}`, values: [next] });
  }

  console.log(`OC rows: ${ocRows.length} | Invoices rows to rewrite: ${data.length} | cells changed: ${changedCells}`);
  if (missing.length) console.log(`No Invoices row (skipped, not created): ${missing.join(', ')}`);
  if (!CONFIRM) { console.log('\nDRY RUN — re-run with --confirm to write.'); return; }

  // Chunked so one oversized request can't fail the whole mirror.
  for (let i = 0; i < data.length; i += 25) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: { valueInputOption: 'RAW', data: data.slice(i, i + 25) },
    });
    console.log(`  wrote ${Math.min(i + 25, data.length)}/${data.length}`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
