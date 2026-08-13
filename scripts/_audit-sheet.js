// Read-only data audit of the MO sheet. Reports only; changes nothing.
//   node --env-file=.env scripts/_audit-sheet.js
const { google } = require('googleapis');
const { COLUMNS } = require('../mo-sheet');

const SHEET_ID = process.env.MO_SHEET_ID;
const COL = Object.fromEntries(COLUMNS.map((c, i) => [c, i]));
const W = COLUMNS.length;
const a1 = (c) => { let s = '', n = c; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };
const norm = (v) => String(v ?? '').trim();
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[$,()\s]/g, '')); return isNaN(n) ? 0 : n; };
const neg = (v) => /^\(|^-/.test(norm(v));
const findings = [];
const add = (sev, cat, msg) => findings.push({ sev, cat, msg });

// A line that renders wider than the PDF's left column wraps; the address block
// is where that has actually bitten (Maryland GCCs I).
const ADDR_WRAP_CHARS = 46;

async function main() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const get = async (r) => (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: r })).data.values || [];
  const [oc, inv, info, users] = await Promise.all([
    get('Order Confirmations!A1:CZ300'), get('Invoices!A1:CZ300'),
    get('Order Info!A1:H300'), get('Users!A1:C300'),
  ]);

  const docTabs = [['Order Confirmations', oc], ['Invoices', inv]];

  for (const [tab, rows] of docTabs) {
    const body = rows.slice(1);
    const seenOrder = new Map(), seenDeal = new Map();
    body.forEach((r, i) => {
      if (!r.length) return;
      const rowNo = i + 2;
      const order = norm(r[COL.order_number]) || `(row ${rowNo})`;
      const where = `${tab} row ${rowNo} [${order}]`;

      // Debris past the 69-column layout.
      if (r.length > W) {
        const extra = r.slice(W).map(norm).filter(Boolean);
        if (extra.length) add('HIGH', 'stray data past the layout', `${where}: ${extra.length} cell(s) beyond column ${a1(W - 1)} — e.g. ${JSON.stringify(extra[0].slice(0, 40))}`);
      }

      // Duplicates.
      for (const [key, map, label] of [[norm(r[COL.order_number]), seenOrder, 'order number'], [norm(r[COL.deal_id]), seenDeal, 'deal id']]) {
        if (!key) continue;
        if (map.has(key)) add('HIGH', 'duplicate', `${tab}: ${label} ${JSON.stringify(key)} on rows ${map.get(key)} and ${rowNo}`);
        else map.set(key, rowNo);
      }

      // Missing essentials.
      for (const [f, label] of [['order_number', 'order number'], ['customer_email', 'customer email'], ['club', 'customer/club'], ['ship_date', 'ship date']]) {
        if (!norm(r[COL[f]])) add(f === 'ship_date' ? 'LOW' : 'MED', 'missing field', `${where}: no ${label}`);
      }

      // Addresses that will wrap in the PDF, and joined-line artefacts.
      for (const f of ['address', 'shipping_address']) {
        const block = norm(r[COL[f]]);
        if (!block) continue;
        block.split('\n').forEach((line) => {
          if (line.trim().length > ADDR_WRAP_CHARS) add('MED', 'address line wraps in the PDF', `${where}: ${f} line ${line.trim().length} chars — ${JSON.stringify(line.trim().slice(0, 52))}`);
        });
        if (/\S\/\s|\s\/\S/.test(block) && !/https?:/.test(block)) add('MED', 'address joined with a slash', `${where}: ${f} — ${JSON.stringify(block.replace(/\n/g, ' | ').slice(0, 64))}`);
      }
      // Billing and shipping that differ only trivially => both blocks print.
      const bill = norm(r[COL.address]), ship = norm(r[COL.shipping_address]);
      if (bill && ship) {
        const flat = (s) => s.replace(/[\s/,.]+/g, '').toLowerCase();
        if (bill !== ship && flat(bill) === flat(ship)) add('MED', 'near-duplicate address', `${where}: billing and shipping differ only by punctuation, so both blocks print`);
      }

      // Line-item and money consistency.
      let sum = 0, qtySum = 0;
      for (let n = 1; n <= 5; n++) {
        const q = num(r[COL[`p${n}_qty`]]), p = num(r[COL[`p${n}_price`]]);
        const nameCell = norm(r[COL[`p${n}_url`]]), desc = norm(r[COL[`p${n}_desc`]]);
        const orig = num(r[COL[`orig_price_${n}`]]);
        if (q) { sum += q * p; qtySum += q; }
        if (q && !p && !orig) add('LOW', 'zero-price item', `${where}: item ${n} qty ${q} with no price and no struck price`);
        if (orig && orig <= p) add('MED', 'struck price not above price', `${where}: item ${n} orig ${orig} vs price ${p}`);
        if (!q && (nameCell || desc)) add('LOW', 'item with no quantity', `${where}: item ${n} has text but no quantity — it will not render`);
        for (const f of [`p${n}_mockup`, `p${n}_product_page`]) {
          const u = norm(r[COL[f]]);
          if (u && !/^https:\/\//i.test(u)) add('MED', 'non-https link is dropped', `${where}: ${f} — ${JSON.stringify(u.slice(0, 48))}`);
        }
      }
      const sub = num(r[COL.subtotal]);
      if (sub && Math.abs(sub - sum) > 0.5) add('HIGH', 'subtotal mismatch', `${where}: subtotal ${sub} vs line items ${sum.toFixed(2)}`);
      const subQty = num(r[COL.subtotal_quantity]);
      if (subQty && qtySum && subQty !== qtySum) add('MED', 'quantity mismatch', `${where}: subtotal qty ${subQty} vs items ${qtySum}`);

      const struck = (f) => norm(r[COL[f]]) === '1';
      const expect = (sub || sum)
        + (struck('strike_shipping') ? 0 : num(r[COL.shipping]))
        + (struck('strike_embroidery') ? 0 : num(r[COL.embroidery]))
        + (struck('strike_art') ? 0 : (neg(r[COL.art_setup]) ? -Math.abs(num(r[COL.art_setup])) : num(r[COL.art_setup])))
        + num(r[COL.custom_label]) + num(r[COL.rush_fee]) - Math.abs(num(r[COL.sample_reimbursement]));
      const total = num(r[COL.total]);
      if (total && Math.abs(total - expect) > 0.5) add('HIGH', 'total mismatch', `${where}: total ${total} vs computed ${expect.toFixed(2)}`);
      if (!total) add('HIGH', 'missing total', `${where}: no total`);

      const link = norm(r[COL.payment_link]);
      if (link && !/^https:\/\//i.test(link)) add('HIGH', 'bad payment link', `${where}: ${JSON.stringify(link.slice(0, 48))}`);
      if (link && !/nickelpayments\.com|mayorclothing\.com/i.test(link)) add('HIGH', 'payment link on an untrusted host', `${where}: ${JSON.stringify(link.slice(0, 60))}`);
    });
  }

  // Cross-tab: every Invoices/OC row should have an Order Info row and vice versa.
  const infoBody = info.slice(1).filter((r) => r.length);
  const infoByOrder = new Map(infoBody.map((r, i) => [norm(r[0]), { row: i + 2, r }]));
  const ocOrders = new Set(oc.slice(1).filter((r) => r.length).map((r) => norm(r[COL.order_number])).filter(Boolean));
  const invOrders = new Set(inv.slice(1).filter((r) => r.length).map((r) => norm(r[COL.order_number])).filter(Boolean));
  for (const o of new Set([...ocOrders, ...invOrders])) if (!infoByOrder.has(o)) add('HIGH', 'no Order Info row', `${o} exists in the doc tabs but the portal will never list it`);
  for (const [o, { row }] of infoByOrder) if (o && !ocOrders.has(o) && !invOrders.has(o)) add('MED', 'orphan Order Info row', `${o} (row ${row}) has no confirmation or invoice`);

  const STATUSES = new Set(['awaiting approval', 'awaiting customer approval', 'awaiting payment', 'in progress', 'in transit', 'delivered']);
  const userEmails = new Set(users.slice(1).flatMap((r) => norm(r[0]).toLowerCase().split(/[,;]+/)).map((s) => s.trim()).filter(Boolean));
  infoBody.forEach((r, i) => {
    const row = i + 2, o = norm(r[0]) || `(row ${row})`;
    const st = norm(r[4]);
    if (!st) add('MED', 'missing status', `Order Info row ${row} [${o}]`);
    else if (!STATUSES.has(st.toLowerCase())) add('MED', 'unrecognised status', `Order Info row ${row} [${o}]: ${JSON.stringify(st)} — badge colour and rank both fall back`);
    if (!norm(r[7])) add('LOW', 'no deal id', `Order Info row ${row} [${o}] — matched by order number only`);
    const emails = norm(r[3]).split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!emails.length) add('HIGH', 'no customer email', `Order Info row ${row} [${o}] — nobody can log in to see it`);
    for (const e of emails) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) add('MED', 'malformed email', `Order Info row ${row} [${o}]: ${JSON.stringify(e)}`);
      else if (!userEmails.has(e.toLowerCase())) add('LOW', 'not pre-registered', `Order Info row ${row} [${o}]: ${e} has no Users row (login still self-registers)`);
    }
  });

  const seenUser = new Map();
  users.slice(1).forEach((r, i) => {
    const row = i + 2, e = norm(r[0]).toLowerCase();
    if (!e) return;
    if (seenUser.has(e)) add('MED', 'duplicate user', `Users: ${e} on rows ${seenUser.get(e)} and ${row}`);
    else seenUser.set(e, row);
    if (!norm(r[1])) add('LOW', 'user without a password', `Users row ${row}: ${e} (fine — set on first login)`);
  });

  const order = { HIGH: 0, MED: 1, LOW: 2 };
  const byCat = new Map();
  for (const f of findings) {
    const k = `${f.sev}|${f.cat}`;
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(f.msg);
  }
  console.log(`findings: ${findings.length}\n`);
  [...byCat.entries()].sort((a, b) => order[a[0].split('|')[0]] - order[b[0].split('|')[0]] || b[1].length - a[1].length)
    .forEach(([k, msgs]) => {
      const [sev, cat] = k.split('|');
      console.log(`[${sev}] ${cat} — ${msgs.length}`);
      msgs.slice(0, 8).forEach((m) => console.log(`    ${m}`));
      if (msgs.length > 8) console.log(`    ... and ${msgs.length - 8} more`);
    });
}
main().catch((e) => { console.error(e.message); process.exit(1); });
