// Push the Order Confirmations tab (the truth document) back into HubSpot deals.
// Reverse of hermesMapping.js. OC is read-only here.
//
//   node --env-file=.env scripts/oc-to-hubspot.js            # dry run, no token needed
//   HUBSPOT_TOKEN=pat-... node --env-file=.env scripts/oc-to-hubspot.js --confirm
//
// Deliberately NOT written back:
//   deal_name / deal_stage — HubSpot owns pipeline identity; a blank OC cell
//     would clear a deal's stage.
//   subtotal / total / subtotal_quantity / drive_pdf_link — computed or
//     Drive-side, no HubSpot source property.
//   blank strike_* cells — blank means "never set", and HubSpot's own default
//     (embroidery/art struck) is not the same as an explicit false.
const { google } = require('googleapis');
const { COLUMNS } = require('../mo-sheet');

const SHEET_ID = process.env.MO_SHEET_ID;
const COL = Object.fromEntries(COLUMNS.map((c, i) => [c, i]));
const CONFIRM = process.argv.includes('--confirm');
const TOKEN = process.env.HUBSPOT_TOKEN || '';

const QTY_PROPS = ['k_quantity_1', 'l_quantity_2', 'm_quantity_3', 'z_quantity_4', 'z_quantity_5'];
const PRICE_PROPS = ['n_price_1', 'z_price_2', 'z_price_3', 'z_price_4', 'z_price_5'];

// "$1,234.00" / "(40.00)" -> "1234" / "-40". Blank stays blank.
const money = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const neg = /^\(|^-/.test(s);
  const n = parseFloat(s.replace(/[$,()\s]/g, ''));
  if (isNaN(n)) return '';
  return String(neg ? -Math.abs(n) : n);
};
// "Friday, September 11, 2026" -> "2026-09-11" (HubSpot date input).
const isoDate = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const str = (v) => String(v ?? '').trim();

function dealProps(row) {
  const p = {
    order_number: str(row[COL.order_number]),
    club: str(row[COL.club]),
    customer_email: str(row[COL.customer_email]),
    ship_date: isoDate(row[COL.ship_date]),
    // zf_delivered_date / zg_tracking_number are added below, and only when the
    // OC cell has a value: they are the delivered/in-transit TRIGGERS, so a blank
    // cell would disarm the automation, not merely clear a field. The OC tab
    // carries no tracking at all and only a handful of in-hand dates.
    print_background: str(row[COL.print_background]),
    payment_terms: str(row[COL.payment_terms]),
    product_page: str(row[COL.product_page]),
    za_embroidery: money(row[COL.embroidery]),
    zb_art_setup: money(row[COL.art_setup]),
    z_sample_reimbursement: money(row[COL.sample_reimbursement]),
    custom_main_label: money(row[COL.custom_label]),
    rush_fee: money(row[COL.rush_fee]),
    shipping_cost: money(row[COL.shipping]),
  };
  // Addresses: hermesMapping puts the primary block in `address` and only fills
  // `shipping_address` when a separate billing address exists. Reverse that.
  const address = str(row[COL.address]);
  const shipping = str(row[COL.shipping_address]);
  p.shippingbilling_address = shipping || address;
  p.c_billing_address = shipping ? address : '';
  const delivered = isoDate(row[COL.in_hand_date]);
  if (delivered) p.zf_delivered_date = delivered;
  const tracking = str(row[COL.tracking_number]);
  if (tracking) p.zg_tracking_number = tracking;
  // Payment links round-trip as one " / "-joined field.
  p.y_payment_link = [str(row[COL.payment_link]), str(row[COL.payment_link_2])].filter(Boolean).join(' / ');
  // Strike checkboxes: '1' true, '0' false, blank => leave HubSpot alone.
  for (const [col, prop] of [['strike_embroidery', 'strike_embroidery'], ['strike_art', 'strike_art'], ['strike_shipping', 'strike_shipping']]) {
    const v = str(row[COL[col]]);
    if (v) p[prop] = v === '1' ? 'true' : 'false';
  }
  for (let i = 0; i < 5; i++) {
    const n = i + 1;
    p[`product_${n}`] = str(row[COL[`p${n}_url`]]);
    p[`mockup_${n}`] = str(row[COL[`p${n}_mockup`]]);
    p[`product_page_${n}`] = str(row[COL[`p${n}_product_page`]]);
    p[`description_${n}`] = str(row[COL[`p${n}_desc`]]);
    p[`sizes_${n}`] = str(row[COL[`p${n}_sizes`]]);
    p[QTY_PROPS[i]] = money(row[COL[`p${n}_qty`]]);
    p[PRICE_PROPS[i]] = money(row[COL[`p${n}_price`]]);
    p[`orig_price_${n}`] = money(row[COL[`orig_price_${n}`]]);
  }
  return p;
}

async function main() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Order Confirmations!A2:CZ300' });

  const inputs = [];
  const noDealId = [];
  for (const row of res.data.values || []) {
    if (!row.length) continue;
    const id = str(row[COL.deal_id]);
    if (!id) { noDealId.push(str(row[COL.order_number])); continue; }
    inputs.push({ id, properties: dealProps(row) });
  }

  console.log(`OC rows with a deal id: ${inputs.length}`);
  if (noDealId.length) console.log(`No deal id (skipped): ${noDealId.join(', ')}`);
  const sample = inputs[0];
  console.log(`\nsample — deal ${sample.id}:`);
  for (const [k, v] of Object.entries(sample.properties)) if (v !== '') console.log(`  ${k}: ${String(v).replace(/\n/g, ' / ').slice(0, 70)}`);
  const blanks = Object.values(sample.properties).filter((v) => v === '').length;
  console.log(`  (+${blanks} properties written blank, clearing whatever HubSpot holds)`);

  if (!CONFIRM) { console.log('\nDRY RUN — re-run with HUBSPOT_TOKEN set and --confirm to write.'); return; }
  if (!TOKEN) throw new Error('HUBSPOT_TOKEN is not set');

  // Snapshot every property this run is about to touch, before touching it.
  // HubSpot has no undo and most of these are written blank on purpose.
  const props = [...new Set(inputs.flatMap((i) => Object.keys(i.properties)))];
  const backup = [];
  for (let i = 0; i < inputs.length; i += 50) {
    const r = await fetch('https://api.hubapi.com/crm/v3/objects/deals/batch/read', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: props, inputs: inputs.slice(i, i + 50).map(({ id }) => ({ id })) }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(`backup read failed ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
    backup.push(...body.results);
  }
  const file = `${process.env.TEMP || '.'}/hubspot-backup-${Date.now()}.json`;
  require('fs').writeFileSync(file, JSON.stringify(backup, null, 2));
  console.log(`backed up ${backup.length} deals -> ${file}`);

  for (let i = 0; i < inputs.length; i += 50) {
    const chunk = inputs.slice(i, i + 50);
    const r = await fetch('https://api.hubapi.com/crm/v3/objects/deals/batch/update', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: chunk }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(`HubSpot ${r.status}: ${JSON.stringify(body).slice(0, 400)}`);
    console.log(`  updated ${Math.min(i + 50, inputs.length)}/${inputs.length}`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
