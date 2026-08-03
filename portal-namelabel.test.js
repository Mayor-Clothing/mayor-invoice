// Mirrors the slot label rule in portal.html: the pN_url cell doubles as the
// product name when it isn't a URL, else the generic fallback. Same convention
// as hermesMapping.js. Run: node portal-namelabel.test.js
const assert = require('assert');

function nameLabel(cell) {
  const raw = (cell || '').trim();
  const isUrl = /^https?:\/\//i.test(raw);
  return (!isUrl && raw) ? raw : 'Custom Print Polo';
}

assert.strictEqual(nameLabel('Womens Print Polo'), 'Womens Print Polo'); // typed name
assert.strictEqual(nameLabel('https://x.com/a.png'), 'Custom Print Polo'); // image URL
assert.strictEqual(nameLabel('  '), 'Custom Print Polo');                  // blank
assert.strictEqual(nameLabel(''), 'Custom Print Polo');                    // empty
assert.strictEqual(nameLabel('http://x.com/p'), 'Custom Print Polo');      // http URL
console.log('ok');
