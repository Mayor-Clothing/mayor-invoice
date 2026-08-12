// One-time: physically reorder the Order Confirmations + Invoices columns into
// the HubSpot deal-card order. Pure permutation of the SAME 69 columns — no data
// added/dropped. Backs up each tab first (duplicate), then remaps every row.
//
//   node --env-file=.env scripts/reorder-sheet-columns.js            (dry run)
//   node --env-file=.env scripts/reorder-sheet-columns.js --confirm
//
// MUST run in lockstep with the mo-sheet.js COLUMNS change (same NEW order).
// Deploy the code first, then run this immediately after so the live portal
// reads the new positions from the new layout.

const { google } = require('googleapis');
const SHEET_ID = process.env.MO_SHEET_ID;
const CONFIRM = process.argv.includes('--confirm');
const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
const TABS = ['Order Confirmations', 'Invoices'];

// EXACT current live layout (mo-sheet.js COLUMNS before this change).
const OLD_ORDER = [
  'deal_id','deal_name','deal_stage','tracking_number','customer_email',
  'order_number','product_page','print_background','club','shipping_address',
  'address','ship_date','in_hand_date','payment_terms',
  'p1_url','p1_desc','p1_sizes','p1_qty','p1_price',
  'p2_url','p2_desc','p2_sizes','p2_qty','p2_price',
  'p3_url','p3_desc','p3_sizes','p3_qty','p3_price',
  'p4_url','p4_desc','p4_sizes',
  'p5_url','p5_desc','p5_sizes',
  'p4_qty','p4_price','p5_qty','p5_price',
  'subtotal_quantity','subtotal','embroidery','art_setup','sample_reimbursement',
  'custom_label','shipping','total','payment_link','payment_link_2',
  'strike_embroidery','strike_art','strike_shipping',
  'orig_price_1','orig_price_2','orig_price_3','orig_price_4','orig_price_5',
  'drive_pdf_link','rush_fee',
  'p1_product_page','p2_product_page','p3_product_page','p4_product_page','p5_product_page',
  'p1_mockup','p2_mockup','p3_mockup','p4_mockup','p5_mockup',
];

// New order = HubSpot deal-card order. deal_id/name/stage stay at front (keying),
// product_page (order-level legacy fallback) + drive_pdf_link trail at the end.
const item = (n) => [`p${n}_url`, `p${n}_mockup`, `p${n}_product_page`, `p${n}_desc`, `p${n}_sizes`, `p${n}_qty`, `orig_price_${n}`, `p${n}_price`];
const NEW_ORDER = [
  'deal_id','deal_name','deal_stage',
  'tracking_number','customer_email','order_number','club','shipping_address','address','ship_date','in_hand_date','print_background',
  ...item(1), ...item(2), ...item(3), ...item(4), ...item(5),
  'subtotal_quantity','subtotal','embroidery','art_setup','sample_reimbursement','custom_label','rush_fee','shipping','strike_embroidery','strike_art','strike_shipping','total','payment_terms','payment_link','payment_link_2',
  'product_page','drive_pdf_link',
];

const LABELS = {
  deal_id:'Deal ID', deal_name:'Deal Name', deal_stage:'Deal Stage', tracking_number:'Tracking Number',
  customer_email:'Customer Email', order_number:'Order Number', club:'Customer', shipping_address:'Shipping Address',
  address:'Billing Address', ship_date:'Ship Date', in_hand_date:'In Hand Date', print_background:'Print Background',
  subtotal_quantity:'Subtotal Quantity', subtotal:'Subtotal Price', embroidery:'Embroidery', art_setup:'Art Setup',
  sample_reimbursement:'Sample Reimbursement', custom_label:'Custom Main Label', rush_fee:'Rush Fee', shipping:'Shipping Cost',
  strike_embroidery:'Strike Embroidery', strike_art:'Strike Art', strike_shipping:'Strike Shipping', total:'Total',
  payment_terms:'Payment Terms', payment_link:'Payment Link', payment_link_2:'Payment Link 2',
  product_page:'Product Page (order-level)', drive_pdf_link:'Drive PDF Link',
};
const label = (n) => LABELS[n] || n.replace(/^p(\d)_/, (m, d) => ({ url:'Product ', mockup:'Mockup ', product_page:'Product Page ', desc:'Description ', sizes:'Sizes ', qty:'Quantity ', price:'Price ' }[n.slice(3)] || '') + d).replace(/^orig_price_(\d)$/, 'Orig Price $1');
function headerLabel(n) {
  if (LABELS[n]) return LABELS[n];
  const m = n.match(/^p(\d)_(url|mockup|product_page|desc|sizes|qty|price)$/);
  if (m) return ({ url:'Product', mockup:'Mockup', product_page:'Product Page', desc:'Description', sizes:'Sizes', qty:'Quantity', price:'Price' }[m[2]]) + ' ' + m[1];
  const o = n.match(/^orig_price_(\d)$/);
  if (o) return 'Orig Price ' + o[1];
  return n;
}

function assertPermutation() {
  const a = [...OLD_ORDER].sort(), b = [...NEW_ORDER].sort();
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) throw new Error('OLD/NEW are not the same set — refusing (would add/drop columns).');
}

async function main() {
  if (!SHEET_ID) { console.error('MO_SHEET_ID not set'); process.exit(1); }
  assertPermutation();
  const oldIdx = {}; OLD_ORDER.forEach((n, i) => { oldIdx[n] = i; });

  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets(properties(sheetId,title))' });
  const idByTitle = {}; meta.data.sheets.forEach((s) => { idByTitle[s.properties.title] = s.properties.sheetId; });

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  console.log(`${CONFIRM ? 'MIGRATING' : 'DRY RUN'} — reorder ${TABS.join(' + ')} to HubSpot layout (${NEW_ORDER.length} cols)\n`);

  for (const tab of TABS) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A:BZ` });
    const rows = res.data.values || [];
    const dataRows = rows.slice(1).filter((r) => (r || []).some((c) => c !== '' && c != null));
    console.log(`${tab}: ${dataRows.length} data rows`);
    if (!CONFIRM) continue;

    // 1) Back up (duplicate the tab).
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: { requests: [{ duplicateSheet: { sourceSheetId: idByTitle[tab], newSheetName: `BACKUP ${tab} ${stamp}` } }] },
    });
    console.log(`  backed up -> "BACKUP ${tab} ${stamp}"`);

    // 2) Remap every row (pure permutation), fresh header.
    const header = NEW_ORDER.map(headerLabel);
    const remapped = rows.slice(1).map((r) => NEW_ORDER.map((n) => {
      const v = (r || [])[oldIdx[n]];
      return v == null ? '' : v;
    }));
    const grid = [header, ...remapped];

    // 3) Write back over the original tab.
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${tab}!A1`,
      valueInputOption: 'RAW', resource: { values: grid },
    });
    console.log(`  rewrote ${grid.length} rows in new order`);
  }
  console.log(CONFIRM ? '\nDone.' : '\nRe-run with --confirm to migrate.');
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
