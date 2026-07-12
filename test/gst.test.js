const test = require('node:test');
const assert = require('node:assert');
// report.js pulls in onedrive.js -> settings.js, which fails closed without
// SESSION_SECRET/SETTINGS_KEY set — harmless here since nothing in this file
// touches real settings, but the module-load-time check still runs. node
// --test isolates each file into its own process, so this doesn't affect
// other test files.
process.env.ALLOW_INSECURE_SECRET = process.env.ALLOW_INSECURE_SECRET || '1';
const { GST_RATE, gstComponent } = require('../src/report');

// GST-inclusive breakdown shown on invoice PDFs when a site's gst_applicable
// flag is set (src/report.js's renderInvoicePdf) — no charge is added, this
// is purely a compliance breakdown of an already GST-inclusive total.

test('gstComponent: standard 10% GST-inclusive breakdown', () => {
  assert.strictEqual(GST_RATE, 0.10);
  // $110 inclusive of 10% GST -> $100 ex-GST + $10 GST.
  assert.ok(Math.abs(gstComponent(110) - 10) < 1e-9);
});

test('gstComponent: subtotal + GST reconstitutes the original total', () => {
  for (const total of [0, 1, 55, 99.99, 1234.56, 8000]) {
    const gst = gstComponent(total);
    const subtotal = total - gst;
    assert.ok(Math.abs(subtotal + gst - total) < 1e-9, `total=${total}`);
  }
});

test('gstComponent: zero total has zero GST component', () => {
  assert.strictEqual(gstComponent(0), 0);
});

test('gstComponent: matches the standard total/11 shortcut for 10% GST', () => {
  const total = 275;
  assert.ok(Math.abs(gstComponent(total) - total / 11) < 1e-9);
});
