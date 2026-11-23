const test = require('node:test');
const assert = require('node:assert');
const ticket = require('../src/uploadTicket');

test('upload ticket round-trips its fields', () => {
  const tk = ticket.issue({ f: 'a.jpg', v: 7, u: 3, c: null, t: 9 });
  const got = ticket.verify(tk);
  assert.strictEqual(got.f, 'a.jpg');
  assert.strictEqual(got.t, 9);
});

test('expired, tampered or junk tickets are refused', () => {
  const now = Date.now();
  const tk = ticket.issue({ f: 'a.jpg', v: 7, u: 3 }, now);
  assert.strictEqual(ticket.verify(tk, now + ticket.TTL_MS + 1), null);
  const [p, sig] = tk.split('.');
  const other = Buffer.from(JSON.stringify({ f: 'b.jpg', v: 7, u: 3, exp: now + 1e6 })).toString('base64url');
  assert.strictEqual(ticket.verify(`${other}.${sig}`), null);
  assert.strictEqual(ticket.verify(`${p}.`), null);
  assert.strictEqual(ticket.verify('nonsense'), null);
  assert.strictEqual(ticket.verify(undefined), null);
});
