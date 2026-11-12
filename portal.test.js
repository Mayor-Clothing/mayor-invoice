// Runnable check for swatchUrlFor (print_background backfill). `node portal.test.js`.
// Needs JWT_SECRET set — portal.js refuses to load without it (see line ~60).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-for-prod';
process.env.GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT || '{}';
process.env.MO_SHEET_ID = process.env.MO_SHEET_ID || 'test-sheet-id';

const assert = require('assert');
const { swatchUrlFor, invoiceFileName } = require('./portal');

// Real committed swatch file: swatches/Fox Hopyard Country Club I.png
assert.strictEqual(swatchUrlFor('Fox Hopyard Country Club I'), '/swatches/Fox Hopyard Country Club I');
// No matching file => blank, not an error
assert.strictEqual(swatchUrlFor('No Such Order 999'), '');
assert.strictEqual(swatchUrlFor(''), '');
assert.strictEqual(swatchUrlFor(undefined), '');
// Path traversal attempt => basename strips it, no throw, no match
assert.strictEqual(swatchUrlFor('../../../etc/passwd'), '');

// Invoice download name: "Mayor - Invoice - <order> - <Customer>", or without the customer when the
// order name already contains it.
const NAME_CASES = [
  ['9336', 'Brownson Country Club', 'Mayor - Invoice - 9336 - Brownson Country Club.pdf'],
  ['Brownson Country Club I', 'Brownson Country Club', 'Mayor - Invoice - Brownson Country Club I.pdf'],
  ['brownson country club ii', 'Brownson Country Club', 'Mayor - Invoice - brownson country club ii.pdf'],
  ['MGT I', 'MGT', 'Mayor - Invoice - MGT I.pdf'],
  ['BCGolf1012', 'Turn 2 Sports', 'Mayor - Invoice - BCGolf1012 - Turn 2 Sports.pdf'],
  ['12381-47994', 'Morgan Corp. / Palmetto Rock', 'Mayor - Invoice - 12381-47994 - Morgan Corp. & Palmetto Rock.pdf'],
  ['8949 Reorder', 'Green Oaks Country Club', 'Mayor - Invoice - 8949 Reorder - Green Oaks Country Club.pdf'],
  ['9336', '', 'Mayor - Invoice - 9336.pdf'],
  ['9336', undefined, 'Mayor - Invoice - 9336.pdf'],
  ['A/B: C', 'X*Y', 'Mayor - Invoice - A-B- C - XY.pdf'],
];
for (const [order, club, want] of NAME_CASES) assert.strictEqual(invoiceFileName(order, club), want, `invoiceFileName(${order}, ${club})`);
// portal.html's copy (the one the Download button uses) must give identical answers.
const html = require('fs').readFileSync(require('path').join(__dirname, 'portal.html'), 'utf8');
const m = html.match(/\/\/ BEGIN invoiceFileName\n([\s\S]*?)\/\/ END invoiceFileName/);
assert.ok(m, 'portal.html has the invoiceFileName copy');
const htmlFn = new Function(m[1] + '\nreturn invoiceFileName;')();
for (const [order, club, want] of NAME_CASES) assert.strictEqual(htmlFn(order, club), want, `portal.html invoiceFileName(${order}, ${club})`);

console.log('portal.test.js: all assertions passed');
