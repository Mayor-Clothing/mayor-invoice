const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { renderInvoicePdf } = require('./doc-render');
const { buildRow, INFO_DEAL_COL, matchRowIndex, firstEmptyRow } = require('./mo-sheet');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { router: portalRouter, getOrdersFromSheet } = require('./portal');
const app = express();
app.set('trust proxy', 1);

// Restrict cross-origin requests to Mayor's own front-ends. The invoice generator
// (GitHub Pages) and the orders portal POST here from the browser; everything else
// is blocked. Add new front-end origins to this list if they're introduced.
const ALLOWED_ORIGINS = [
  'https://mayorclothing.github.io',
  'https://orders.mayorclothing.com',
  'https://mayor-invoice.onrender.com',
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin / non-browser requests (no Origin header) and allowlisted origins.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
}));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use('/portal', portalRouter);
app.get('/', (req, res) => res.redirect('/orders'));
app.get('/mayor-logo.png', (req, res) => res.sendFile(path.join(__dirname, 'Mayor_Logo_transparent.png')));
app.get('/auth-bg-1.png', (req, res) => res.sendFile(path.join(__dirname, 'auth-bg-1.png')));
app.get('/auth-bg-2.png', (req, res) => res.sendFile(path.join(__dirname, 'auth-bg-2.png')));
app.get('/auth-bg-3.png', (req, res) => res.sendFile(path.join(__dirname, 'auth-bg-3.png')));

// Per-order print swatch, used as the order-detail page background when one exists.
// Filename = the order number exactly (path.basename strips any traversal attempt),
// tried against a fixed extension list rather than trusting a client-supplied one.
const SWATCH_DIR = path.join(__dirname, 'swatches');
const SWATCH_EXTENSIONS = ['.png', '.jpg', '.jpeg'];
app.get('/swatches/:orderNumber', (req, res) => {
  const base = path.basename(req.params.orderNumber).replace(/\.[^.]+$/, '');
  for (const ext of SWATCH_EXTENSIONS) {
    const file = path.join(SWATCH_DIR, base + ext);
    if (fs.existsSync(file)) return res.sendFile(file);
  }
  res.status(404).end();
});
app.get('/orders', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'portal.html'));
});

// No fallback (the old id is the dead pre-reorg sheet). portal.js — required
// above — already hard-fails on a missing MO_SHEET_ID before we get here.
const SHEET_ID = process.env.MO_SHEET_ID;
const SHEET_CREDS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
const LOGO_PATH = __dirname + '/Mayor_Logo_transparent.png';

// ---- /generate hardening (this endpoint is browser-reachable and writes to the sheet) ----
function sheetSafe(v) { if (typeof v !== 'string') return v; return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; }
// See matching comment in portal.js — order numbers are the lookup key for every
// sheet write below; normalize so a stray space can't create a duplicate row.
function normalizeOrderNumber(v) { return String(v || '').trim().replace(/\s+/g, ' '); }
// Strike cell: '1' struck, '0' explicitly not struck, '' the caller never said.
const strikeCell = (v) => (v == null ? '' : (v ? '1' : '0'));
// Payment links must be on a trusted host (blocks payment-link fraud). Extend as needed.
const TRUSTED_PAYMENT_HOSTS = (process.env.TRUSTED_PAYMENT_HOSTS || 'nickelpayments.com,mayorclothing.com')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
function trustedPaymentLink(u) {
  try { const url = new URL(String(u)); if (url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase();
    return TRUSTED_PAYMENT_HOSTS.some((h) => host === h || host.endsWith('.' + h)) ? url.toString() : '';
  } catch (e) { return ''; }
}
function httpsUrlOrEmpty(u) { try { const url = new URL(String(u)); return url.protocol === 'https:' ? url.toString() : ''; } catch (e) { return ''; } }
function sanitizeGeneratePayload(data) {
  const d = { ...(data || {}) };
  d.payment_link = trustedPaymentLink(d.payment_link);
  d.payment_link_2 = trustedPaymentLink(d.payment_link_2);
  d.product_page = httpsUrlOrEmpty(d.product_page);
  d.line_items = (Array.isArray(d.line_items) ? d.line_items : []).slice(0, 10).map((it) => ({ ...(it || {}), url: httpsUrlOrEmpty(it && it.url), product_page: httpsUrlOrEmpty(it && it.product_page), mockup: httpsUrlOrEmpty(it && it.mockup) }));
  return d;
}

// Ensure a customer's email exists in the Users sheet (A=email, B=passwordHash, C=club)
// so they're pre-registered and can later log in / set a password via the portal.
async function upsertUserEmail(sheets, email, club) {
  if (!email) return;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Users!A:C' });
    const rows = res.data.values || [];
    const idx = rows.findIndex(r => r[0] && r[0].toLowerCase() === email.toLowerCase());
    if (idx === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: 'Users!A:C', valueInputOption: 'USER_ENTERED',
        resource: { values: [[email, '', club || ''].map(v => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v))] }
      });
      console.log('Customer email added to Users sheet:', email);
    } else if (!rows[idx][2] && club) {
      // Existing user row but missing club — fill it in
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `Users!C${idx + 1}`, valueInputOption: 'USER_ENTERED',
        resource: { values: [[club]] }
      });
    }
  } catch(e) {
    console.error('upsertUserEmail failed:', e.message);
  }
}

async function appendOrderToSheet(data) {
  try {
    if (!SHEET_CREDS.client_email) return;
    const auth = new google.auth.GoogleAuth({
      credentials: SHEET_CREDS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const isConfirmation = data.type === 'confirmation';

    const items = data.line_items || [];
    const get = (i, key) => items[i] ? (items[i][key] || '') : '';
    const subtotalQty = data.subtotal_quantity != null ? data.subtotal_quantity : items.reduce((s, li) => s + (Number(li.quantity) || 0), 0);
    const dealId = data.deal_id || '';
    // Column order lives in mo-sheet.js (shared with portal.js reader + the
    // backend writer) — reference cells by name, never by position (F7).
    const rowData = buildRow({
      deal_id: data.deal_id || '', deal_name: data.deal_name || '', deal_stage: data.deal_stage || '', tracking_number: data.tracking_number || '',
      customer_email: data.customer_email || '', order_number: data.order_number || '', product_page: data.product_page || '',
      print_background: data.print_background || '',
      club: data.club || '', shipping_address: data.shipping_address || '', address: data.address || '',
      ship_date: data.ship_date || '', in_hand_date: data.in_hand_date || '', payment_terms: data.payment_terms || '',
      p1_url: get(0,'url'), p1_desc: get(0,'description'), p1_sizes: get(0,'sizes'), p1_qty: get(0,'quantity'), p1_price: get(0,'price'),
      p2_url: get(1,'url'), p2_desc: get(1,'description'), p2_sizes: get(1,'sizes'), p2_qty: get(1,'quantity'), p2_price: get(1,'price'),
      p3_url: get(2,'url'), p3_desc: get(2,'description'), p3_sizes: get(2,'sizes'), p3_qty: get(2,'quantity'), p3_price: get(2,'price'),
      p4_url: get(3,'url'), p4_desc: get(3,'description'), p4_sizes: get(3,'sizes'),
      p5_url: get(4,'url'), p5_desc: get(4,'description'), p5_sizes: get(4,'sizes'),
      p4_qty: get(3,'quantity'), p4_price: get(3,'price'), p5_qty: get(4,'quantity'), p5_price: get(4,'price'),
      subtotal_quantity: subtotalQty || '', subtotal: data.subtotal || '',
      embroidery: data.embroidery || '',
      art_setup: (data.art_setup != null ? parseFloat(String(data.art_setup).replace(/[$,\s]/g,'')) || '' : ''),
      sample_reimbursement: data.sample_reimbursement || '', custom_label: data.custom_label || '', shipping: data.shipping || '', total: data.total || '',
      payment_link: data.payment_link || '', payment_link_2: data.payment_link_2 || '',
      // '1' struck, '0' explicitly not struck, blank = caller never said (portal
      // falls back to the legacy default, portal.js strikeCell). Collapsing false
      // into blank made an unstruck fee render struck while the total charged it.
      strike_embroidery: strikeCell(data.strike_embroidery), strike_art: strikeCell(data.strike_art), strike_shipping: strikeCell(data.strike_shipping),
      orig_price_1: get(0,'orig_price'), orig_price_2: get(1,'orig_price'), orig_price_3: get(2,'orig_price'), orig_price_4: get(3,'orig_price'), orig_price_5: get(4,'orig_price'),
      drive_pdf_link: '', // set by the backend's Drive upload; blank when written here
      rush_fee: data.rush_fee || '',
      p1_product_page: get(0,'product_page'), p2_product_page: get(1,'product_page'), p3_product_page: get(2,'product_page'), p4_product_page: get(3,'product_page'), p5_product_page: get(4,'product_page'),
      p1_mockup: get(0,'mockup'), p2_mockup: get(1,'mockup'), p3_mockup: get(2,'mockup'), p4_mockup: get(3,'mockup'), p5_mockup: get(4,'mockup'),
    });

    // Upsert keyed on the stable deal_id (fallback order_number), so a renamed
    // order updates its row instead of orphaning it (F10). deal_id col: A on
    // OC/Invoices, H on Order Info; order_number col: F on OC/Invoices, A on Order Info.
    async function writeToSheet(tabName, orderNumber, rowData) {
      const isInfo = tabName === 'Order Info';
      const dealIdx = isInfo ? INFO_DEAL_COL : 0;
      const orderIdx = isInfo ? 0 : 5;
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tabName}!A:H` });
      const rows = res.data.values || [];
      const idx = matchRowIndex(rows, dealIdx, orderIdx, dealId, normalizeOrderNumber(orderNumber));
      const targetRow = idx > 0 ? idx + 1 : firstEmptyRow(rows, orderIdx);
      console.log(`${tabName} ${idx > 0 ? 'updating' : 'inserting'} row ${targetRow} for:`, orderNumber);
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${tabName}!A${targetRow}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [rowData.map(sheetSafe)] }
      });
      return targetRow;
    }

    if (isConfirmation) {
      // Seed the Order Info row if this order isn't there yet (keyed on deal_id
      // so a rename doesn't seed a duplicate). deal_id goes in col H.
      const infoRes = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Order Info!A:H' });
      const infoRows = infoRes.data.values || [];
      const infoIdx = matchRowIndex(infoRows, INFO_DEAL_COL, 0, dealId, normalizeOrderNumber(data.order_number));
      if (infoIdx < 1) {
        await writeToSheet('Order Info',  data.order_number,
          [data.order_number || '', data.club || '', data.ship_date || '',
           data.customer_email || '', 'Awaiting Customer Approval', '', '', dealId].map(sheetSafe));
      } else if (normalizeOrderNumber((infoRows[infoIdx] || [])[0]) !== normalizeOrderNumber(data.order_number)) {
        // Rename: update order_number (A) in place on the deal_id-matched row.
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID, range: `Order Info!A${infoIdx + 1}`,
          valueInputOption: 'USER_ENTERED', resource: { values: [[sheetSafe(data.order_number)]] }
        });
      }

      // Make sure each customer's email is registered in the Users sheet
      const emails = (data.customer_emails && data.customer_emails.length)
        ? data.customer_emails
        : (data.customer_email || '').split(/[\n;,]+/).map(e => e.trim()).filter(Boolean);
      for (const e of emails) {
        await upsertUserEmail(sheets, e, data.club);
      }

      await writeToSheet('Order Confirmations', data.order_number, rowData);

    } else {
      await writeToSheet('Invoices', data.order_number, rowData);
      // Status is manual now (HubSpot "Order Status" dropdown, or edited directly
      // on the sheet). Generating an invoice no longer auto-advances it to
      // Awaiting Payment.
    }
  } catch(e) {
    console.error('Sheet write failed:', e.message);
  }
}

app.post('/generate', async (req, res) => {
  try {
    const data = sanitizeGeneratePayload(req.body);

    const pdf = await renderInvoicePdf(data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="mayor-invoice.pdf"');
    res.send(pdf);

    // Log order to Google Sheet (non-blocking) — setup email sent manually.
    // Intentionally open: the GitHub-Pages invoice generator (unlisted; used only
    // by Matt/Marcus) writes through here with no key, and it must keep working as
    // a fallback. Residual risk (anyone who learns the endpoint + an order number
    // could overwrite that order's non-payment fields) is accepted; payment links
    // are still host-validated in sanitizeGeneratePayload.
    if (!data.skip_logging) appendOrderToSheet(data);

  } catch(e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});


app.get('/health', (req, res) => res.json({ status: 'ok' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Mayor invoice server running on port', PORT));
