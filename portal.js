// portal.js — Mayor customer portal routes
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { trackPackage } = require('./ups');
const { COL } = require('./mo-sheet');
const router = express.Router();

// Mirrors index.js's SWATCH_DIR/SWATCH_EXTENSIONS + /swatches/:orderNumber route —
// keep in lockstep if that route's naming convention changes. No HubSpot property
// for print_background exists yet (see hermesMapping.js), so the sheet's own
// column stays blank; this backfills it from the file-based swatch convention
// mayor-invoice already serves the portal background from.
const SWATCH_DIR = path.join(__dirname, 'swatches');
const SWATCH_EXTENSIONS = ['.png', '.jpg', '.jpeg'];
function swatchUrlFor(orderNumber) {
  const base = path.basename(String(orderNumber || '')).replace(/\.[^.]+$/, '');
  if (!base) return '';
  for (const ext of SWATCH_EXTENSIONS) {
    if (fs.existsSync(path.join(SWATCH_DIR, base + ext))) return `/swatches/${orderNumber}`;
  }
  return '';
}
router.use(express.json());
const escHtml = (v) => String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

// Neutralize spreadsheet formula injection on any user value we write.
function sheetSafe(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

// Order numbers are the lookup key everywhere below. A stray leading/trailing space
// on one sheet row (e.g. a copy-paste error) makes it fail every === comparison
// silently instead of erroring — normalize on every read/compare so that class of
// bug can't hide a duplicate/orphaned row again.
function normalizeOrderNumber(v) {
  return String(v || '').trim().replace(/\s+/g, ' ');
}

// Minimal in-memory rate limiter (per client IP + route). Fail-open on restart is fine.
const _rlBuckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip || 'x'}:${req.path}`;
    const now = Date.now();
    const rec = _rlBuckets.get(key);
    if (!rec || now > rec.reset) { _rlBuckets.set(key, { count: 1, reset: now + windowMs }); return next(); }
    if (++rec.count > max) return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
    next();
  };
}

// No fallback: '152hyxQz…' is the DEAD pre-reorg sheet. Refuse to start rather
// than silently serve/write the wrong sheet (same fail-loud stance as JWT_SECRET).
const SHEET_ID = process.env.MO_SHEET_ID;
if (!SHEET_ID) {
  throw new Error('MO_SHEET_ID is not set. Refusing to start against the dead fallback sheet — set MO_SHEET_ID in the environment.');
}
// JWT_SECRET must be set in the environment. The fallback exists only for local dev;
// if it is ever used while NODE_ENV=production, log a loud warning so it gets caught.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Refusing to start the portal with an insecure default — set JWT_SECRET in the environment.');
}
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const BASE_URL = process.env.BASE_URL || 'https://orders.mayorclothing.com';

// Admin users see EVERY order (Matt's all-orders view), not just their own.
// Admin = email listed in PORTAL_ADMIN_EMAILS, or a Users-row whose club is "ADMIN".
const ADMIN_EMAILS = (process.env.PORTAL_ADMIN_EMAILS || 'mayor@mayorclothing.com')
  .toLowerCase().split(/[,;]+/).map((sV) => sV.trim()).filter(Boolean);
function isAdminUser(user) {
  if (!user) return false;
  if (ADMIN_EMAILS.includes(String(user.email || '').toLowerCase())) return true;
  if (String(user.club || '').trim().toLowerCase() === 'admin') return true;
  return false;
}

// ── GOOGLE SHEETS ──
// Every order-detail read pulls whole tabs, so a handful of quick clicks used to
// trip Google's per-minute read quota and the portal 500s. Cache the big
// read-only tabs for a few seconds; Users is never cached (a fresh signup must
// be visible to the very next login attempt).
const CACHE_TTL_MS = 15000;
const _rangeCache = new Map();
async function readRange(sheets, range) {
  const hit = _rangeCache.get(range);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const rows = res.data.values || [];
  _rangeCache.set(range, { t: Date.now(), v: rows });
  return rows;
}

async function getSheets() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Order Info column D can contain multiple emails separated by commas/semicolons —
// each registered customer should see the order if their email is anywhere in that list.
function emailInList(cellValue, email) {
  if (!cellValue) return false;
  return cellValue.toLowerCase().split(/[,;]+/).map(s => s.trim()).includes(email.toLowerCase());
}

async function getOrdersFromSheet(email) {
  const sheets = await getSheets();
  const rows = await readRange(sheets, 'Order Info!A:H');
  return rows.slice(1)
    .filter(r => emailInList(r[3], email))
    .map(r => ({
      order_number:    normalizeOrderNumber(r[0]),
      club:            r[1] || '',
      ship_date:       r[2] || '',
      email:           r[3] || '',
      status:          r[4] || 'Awaiting Customer Approval',
      tracking_number: r[5] || '',
      date_delivered:  r[6] || '',
    }));
}

// Every order in the sheet — used for the admin (all-orders) view. Also flags
// data-integrity issues an admin should know about: duplicate order numbers
// (see the "Oklahoma City Golf & Country Club I" incident), missing tracking
// on shipped orders, and missing customer email (blocks that order from ever
// showing up for a customer login).
async function getAllOrdersFromSheet() {
  const sheets = await getSheets();
  const rows = await readRange(sheets, 'Order Info!A:H');
  const orders = rows.slice(1)
    .filter(r => r[0])
    .map(r => ({
      order_number:    normalizeOrderNumber(r[0]),
      club:            r[1] || '',
      ship_date:       r[2] || '',
      email:           r[3] || '',
      status:          r[4] || 'Awaiting Customer Approval',
      tracking_number: r[5] || '',
      date_delivered:  r[6] || '',
    }));

  const counts = new Map();
  orders.forEach(o => counts.set(o.order_number, (counts.get(o.order_number) || 0) + 1));
  const shippedStatuses = ['shipped', 'delivered'];
  orders.forEach(o => {
    o.duplicate = counts.get(o.order_number) > 1;
    o.missing_tracking = shippedStatuses.includes(String(o.status).toLowerCase()) && !o.tracking_number;
    o.missing_email = !o.email;
  });
  return orders;
}

async function getUserFromSheet(email) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Users!A:C',
  });
  const rows = res.data.values || [];
  const row = rows.find(r => r[0] && r[0].toLowerCase() === email.toLowerCase());
  if (!row) return null;
  return { email: row[0], passwordHash: row[1], club: row[2] };
}

async function upsertUser(email, passwordHash, club) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Users!A:C',
  });
  const rows = res.data.values || [];
  const rowIdx = rows.findIndex(r => r[0] && r[0].toLowerCase() === email.toLowerCase());
  if (rowIdx === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Users!A:C',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[email, passwordHash, club].map(sheetSafe)] }
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Users!A${rowIdx + 1}:C${rowIdx + 1}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[email, passwordHash, club].map(sheetSafe)] }
    });
  }
}

// Check if email has orders in Order Info, Order Confirmations, or Invoices
async function emailHasOrders(email) {
  const sheets = await getSheets();
  // Check Order Info first (fastest)
  const rows = await readRange(sheets, 'Order Info!A:D');
  return rows.some(r => emailInList(r[3], email));
}

// Parse row data (columns A-BA) into structured invoice/confirmation object
// Parse a cell value that may be stored as "$1,776.00", "1776", "$NaN", etc.
function parseCurrency(val) {
  if (!val) return 0;
  const n = parseFloat(String(val).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function parseSheetRow(row) {
  if (!row) return null;
  // Column positions come from mo-sheet.js COL (shared with both writers) so the
  // reader can't drift out of lockstep with the layout (F7).
  const items = [];
  const slots = [
    ['p1_url', 'p1_desc', 'p1_sizes', 'p1_qty', 'p1_price', 'orig_price_1', 'p1_product_page', 'p1_mockup'],
    ['p2_url', 'p2_desc', 'p2_sizes', 'p2_qty', 'p2_price', 'orig_price_2', 'p2_product_page', 'p2_mockup'],
    ['p3_url', 'p3_desc', 'p3_sizes', 'p3_qty', 'p3_price', 'orig_price_3', 'p3_product_page', 'p3_mockup'],
    ['p4_url', 'p4_desc', 'p4_sizes', 'p4_qty', 'p4_price', 'orig_price_4', 'p4_product_page', 'p4_mockup'],
    ['p5_url', 'p5_desc', 'p5_sizes', 'p5_qty', 'p5_price', 'orig_price_5', 'p5_product_page', 'p5_mockup'],
  ];
  for (const [u, d, s, q, p, o, pp, mk] of slots) {
    const qty   = parseCurrency(row[COL[q]]);
    const price = parseCurrency(row[COL[p]]);
    if (qty > 0) {
      items.push({
        // The Product cell is name-or-URL (see portal.html nameLabel). Hardcoding
        // the generic label here meant a PDF built from the sheet lost every
        // product name Matt typed in.
        product:    (!/^https?:\/\//i.test(String(row[COL[u]] || '').trim()) && String(row[COL[u]] || '').trim()) || 'Custom Print Polo',
        url:        row[COL[u]] || '',
        description: row[COL[d]] || '',
        sizes:      row[COL[s]] || '',
        quantity:   qty,
        price:      price,
        orig_price: row[COL[o]] ? parseCurrency(row[COL[o]]) : null,
        product_page: row[COL[pp]] || '',   // per-item "Additional Details" link
        mockup:     row[COL[mk]] || '',      // per-item mockup image
        amount:     qty * price
      });
    }
  }

  const artRaw = row[COL.art_setup] || null;
  const artNum = artRaw ? parseCurrency(artRaw) : null;
  const strikeCell = (name, dflt) => (row[COL[name]] !== undefined && row[COL[name]] !== '' ? row[COL[name]] === '1' : dflt);

  return {
    deal_id:           row[COL.deal_id]  || '',
    deal_name:         row[COL.deal_name]  || '',
    deal_stage:        row[COL.deal_stage]  || '',
    tracking_number:   row[COL.tracking_number]  || '',
    order_number:      normalizeOrderNumber(row[COL.order_number]),
    product_page:      row[COL.product_page]  || '',
    print_background:  row[COL.print_background]  || '',
    club:              row[COL.club]  || '',
    shipping_address:  row[COL.shipping_address]  || '',
    address:           row[COL.address] || '',
    ship_date:         row[COL.ship_date] || '',
    in_hand_date:      row[COL.in_hand_date] || '',
    payment_terms:     row[COL.payment_terms] || '',
    customer_email:    row[COL.customer_email]  || '',
    line_items:        items,
    subtotal:          parseCurrency(row[COL.subtotal]),
    embroidery:        parseCurrency(row[COL.embroidery]),
    art_setup:         artNum,
    sample_reimbursement: row[COL.sample_reimbursement] || null,
    custom_label:      row[COL.custom_label] ? parseCurrency(row[COL.custom_label]) : null,
    rush_fee:          row[COL.rush_fee] ? parseCurrency(row[COL.rush_fee]) : null,
    shipping:          parseCurrency(row[COL.shipping]),
    total:             parseCurrency(row[COL.total]),
    payment_link:      row[COL.payment_link] || '',
    payment_link_2:    row[COL.payment_link_2] || '',
    // Blank strike cell => waived for emb/art, charged for shipping (the standing
    // default; matches Hermes writing '1' for waived fees).
    strike_embroidery: strikeCell('strike_embroidery', true),
    strike_art:        strikeCell('strike_art', true),
    strike_shipping:   strikeCell('strike_shipping', false),
  };
}

// Get invoice data — checks Invoices first, then Order Confirmations. Always
// reads both tabs (rather than short-circuiting once one row is found) because
// print_background in particular is often only filled in on whichever tab the
// order started on and never copied to the other — an order invoiced after
// Matt/Marcus pasted its swatch into Order Confirmations would otherwise lose
// that background entirely once its (blank-print_background) Invoices row wins.
async function getOrderDetailData(order_number) {
  const sheets = await getSheets();
  const target = normalizeOrderNumber(order_number);

  const [invRows, confRows] = await Promise.all([
    readRange(sheets, 'Invoices!A:BZ'),
    readRange(sheets, 'Order Confirmations!A:BZ'),
  ]);
  const invRow = invRows.find(r => r[5] && normalizeOrderNumber(r[5]) === target);
  const confRow = confRows.find(r => r[5] && normalizeOrderNumber(r[5]) === target);

  const primaryRow = invRow || confRow;
  if (!primaryRow) return null;

  const detail = parseSheetRow(primaryRow);
  const otherRow = primaryRow === invRow ? confRow : invRow;
  detail.print_background = detail.print_background
    || (otherRow ? parseSheetRow(otherRow).print_background : '')
    || swatchUrlFor(detail.order_number);
  return { ...detail, source: invRow ? 'invoice' : 'confirmation' };
}

// ── EMAIL ──
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) { console.log('No Resend key — skipping email to', to); return; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: 'Mayor Clothing <noreply@mayorclothing.com>', to, subject, html })
  });
  if (!res.ok) console.error('Resend error:', await res.text());
}

async function sendResetEmail(email, token) {
  const link = `${BASE_URL}/orders?action=reset-password&token=${token}`;
  await sendEmail(email, 'Reset your Mayor portal password',
    `<p>Click the link below to reset your password. This link expires in 1 hour.</p>
     <p><a href="${link}" style="background:#1a1a18;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Reset password</a></p>
     <p style="color:#888;font-size:12px;">If you didn't request this, ignore this email.</p>
     <p>— Mayor Clothing</p>`
  );
}

async function sendReorderEmail(data) {
  await sendEmail('mayor@mayorclothing.com', `Reorder Request — ${data.club}`,
    `<p><strong>Club:</strong> ${escHtml(data.club)}</p>
     <p><strong>Original order:</strong> ${escHtml(data.order_number)}</p>
     <p><strong>Contact:</strong> ${escHtml(data.email)}</p>
     <p><strong>Notes:</strong></p>
     <p style="white-space:pre-wrap;">${escHtml(data.notes || 'No notes provided')}</p>`
  );
}

// ── AUTH MIDDLEWARE ──
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.mayor_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Session expired, please sign in again' });
  }
}

// ── ROUTES ──

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'portal.html'));
});

router.post('/login', rateLimit(10, 60000), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    let user = await getUserFromSheet(email);
    if (!user || !user.passwordHash) {
      // Backup path: Users pre-registration (Hermes sync, manual entry, etc.) can fail
      // or lag behind -- don't let that lock out someone who genuinely has an order
      // under this email. Treat this login attempt as an implicit account creation
      // (same rule as /create-account: allowed only if there's a real order, and only
      // when there's no password already set) instead of rejecting it outright.
      const hasOrders = await emailHasOrders(email);
      if (!hasOrders) return res.status(401).json({ error: 'Invalid email or password' });
      const orders = await getOrdersFromSheet(email);
      const hash = await bcrypt.hash(password, 10);
      await upsertUser(email, hash, orders[0]?.club || '');
      user = await getUserFromSheet(email);
    } else {
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    }
    const admin = isAdminUser(user);
    const token = jwt.sign({ email: user.email, club: user.club, admin }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('mayor_token', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7*24*60*60*1000 });
    res.json({ email: user.email, club: user.club, admin });
  } catch(e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Lets the page restore a session after a plain refresh instead of bouncing to login.
router.get('/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email, club: req.user.club, admin: !!req.user.admin });
});

router.post('/logout', (req, res) => {
  res.clearCookie('mayor_token');
  res.json({ ok: true });
});

router.post('/forgot-password', rateLimit(5, 60000), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const user = await getUserFromSheet(email);
    if (user) {
      const token = jwt.sign({ email, action: 'reset' }, JWT_SECRET, { expiresIn: '1h' });
      await sendResetEmail(email, token);
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('Forgot password error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/set-password', rateLimit(10, 60000), async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.action !== 'reset') return res.status(400).json({ error: 'Invalid or expired link' });
    const hash = await bcrypt.hash(password, 10);
    const orders = await getOrdersFromSheet(payload.email);
    const club = orders.length ? orders[0].club : '';
    await upsertUser(payload.email, hash, club);
    res.json({ ok: true });
  } catch(e) {
    console.error('Set password error:', e);
    res.status(400).json({ error: 'Invalid or expired link' });
  }
});

// Create account — allowed if email has any order in Order Info
router.post('/create-account', rateLimit(5, 60000), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const hasOrders = await emailHasOrders(email);
    const existing = await getUserFromSheet(email);
    if (!hasOrders || (existing && existing.passwordHash)) {
      return res.status(400).json({ error: 'We couldn\u2019t create an account with those details. If you already have one, use Forgot password; otherwise contact Mayor Clothing.' });
    }
    const orders = await getOrdersFromSheet(email);
    const hash = await bcrypt.hash(password, 10);
    await upsertUser(email, hash, orders[0]?.club || '');
    res.json({ ok: true });
  } catch(e) {
    console.error('Create account error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get orders list
router.get('/orders', requireAuth, async (req, res) => {
  try {
    const orders = req.user.admin ? await getAllOrdersFromSheet() : await getOrdersFromSheet(req.user.email);
    res.json({ orders, admin: !!req.user.admin });
  } catch(e) {
    console.error('Orders error:', e);
    res.status(500).json({ error: 'Could not load orders' });
  }
});

// Get full order detail (confirmation or invoice data)
router.get('/order-detail/:order_number', requireAuth, async (req, res) => {
  try {
    if (!req.user.admin) {
      const orders = await getOrdersFromSheet(req.user.email);
      if (!orders.find(o => o.order_number === normalizeOrderNumber(req.params.order_number))) return res.status(403).json({ error: 'Not authorized' });
    }
    const detail = await getOrderDetailData(req.params.order_number);
    if (!detail) return res.status(404).json({ error: 'Order details not available yet' });
    res.json(detail);
  } catch(e) {
    console.error('Order detail error:', e);
    res.status(500).json({ error: 'Could not load order details' });
  }
});

// Live UPS tracking status for an order's package
router.get('/tracking/:order_number', requireAuth, async (req, res) => {
  try {
    const orders = req.user.admin ? await getAllOrdersFromSheet() : await getOrdersFromSheet(req.user.email);
    const order = orders.find(o => o.order_number === normalizeOrderNumber(req.params.order_number));
    if (!order) return res.status(403).json({ error: 'Not authorized' });
    if (!order.tracking_number) return res.status(404).json({ error: 'No tracking number yet' });

    const info = await trackPackage(order.tracking_number);
    if (!info) return res.status(404).json({ error: 'No tracking data yet' });
    res.json(info);
  } catch (e) {
    console.error('UPS tracking error:', e);
    res.status(502).json({ error: 'Could not reach UPS' });
  }
});

// Download order confirmation PDF
router.get('/confirmation/:order_number', requireAuth, async (req, res) => {
  try {
    if (!req.user.admin) {
      const orders = await getOrdersFromSheet(req.user.email);
      if (!orders.find(o => o.order_number === normalizeOrderNumber(req.params.order_number))) return res.status(403).json({ error: 'Not authorized' });
    }

    const sheets = await getSheets();
    // Full range through BZ — parseSheetRow reads fields (embroidery, payment_terms,
    // sizes, orig_price, drive_pdf_link, etc.) from columns well past the line
    // items; a narrower range silently dropped them from the PDF.
    const confRows = await readRange(sheets, 'Order Confirmations!A:BZ');
    const confRow = confRows.find(r => r[5] && normalizeOrderNumber(r[5]) === normalizeOrderNumber(req.params.order_number));
    if (!confRow) return res.status(404).json({ error: 'Order confirmation not available.' });

    const confData = parseSheetRow(confRow);
    const generateRes = await fetch('https://mayor-invoice.onrender.com/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...confData, type: 'confirmation', skip_logging: true })
    });
    if (!generateRes.ok) throw new Error('PDF generation failed: ' + await generateRes.text());
    const buffer = Buffer.from(await generateRes.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Mayor-Order-Confirmation-${req.params.order_number}.pdf"`);
    res.send(buffer);
  } catch(e) {
    console.error('Confirmation download error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Download invoice PDF — only works if invoice exists
router.get('/invoice/:order_number', requireAuth, async (req, res) => {
  try {
    if (!req.user.admin) {
      const orders = await getOrdersFromSheet(req.user.email);
      if (!orders.find(o => o.order_number === normalizeOrderNumber(req.params.order_number))) return res.status(403).json({ error: 'Not authorized' });
    }

    // Only generate PDF from Invoices sheet (not confirmations)
    const sheets = await getSheets();
    // see comment on the Order Confirmations read above
    const invRows = await readRange(sheets, 'Invoices!A:BZ');
    const invRow = invRows.find(r => r[5] && normalizeOrderNumber(r[5]) === normalizeOrderNumber(req.params.order_number));
    if (!invRow) return res.status(404).json({ error: 'Invoice not available yet. Your order confirmation is still being reviewed.' });

    const invoiceData = parseSheetRow(invRow);
    const generateRes = await fetch('https://mayor-invoice.onrender.com/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...invoiceData, skip_logging: true })
    });
    if (!generateRes.ok) throw new Error('PDF generation failed: ' + await generateRes.text());
    const buffer = Buffer.from(await generateRes.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Mayor-Invoice-${req.params.order_number}.pdf"`);
    res.send(buffer);
  } catch(e) {
    console.error('Invoice download error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Reorder
router.post('/reorder', requireAuth, async (req, res) => {
  try {
    const { order_number, club, notes } = req.body;
    await sendReorderEmail({ email: req.user.email, order_number, club, notes });
    res.json({ ok: true });
  } catch(e) {
    console.error('Reorder error:', e);
    res.status(500).json({ error: 'Could not submit reorder' });
  }
});

module.exports = { router, getOrdersFromSheet, swatchUrlFor };
