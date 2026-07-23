// Regression test for the OneDrive/SharePoint Graph URL construction. The
// switch from a personal-drive UPN to a SharePoint site id means composite
// site ids like "host,<guid>,<guid>" flow into the Graph path — this locks in
// that the commas and any folder-path spaces/unicode are encoded without
// corrupting the composite id or losing the folder hierarchy. No DB / network:
// uploadFile accepts a pre-built cfg/token via ctx, and global.fetch is stubbed.

// settings.js (required transitively by onedrive.js) fails closed without a key.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-unit-tests';

const test = require('node:test');
const assert = require('node:assert');
const onedrive = require('../src/onedrive');

const SITE_ID = 'contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222';

async function withStubbedFetch(fn) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ webUrl: 'https://w', id: 'ITEM1', name: 'Docs' }) };
  };
  try { return await fn(calls); } finally { global.fetch = original; }
}

test('uploadFile builds a correct SharePoint site drive URL', async () => {
  await withStubbedFetch(async (calls) => {
    const res = await onedrive.uploadFile(
      'job-1-2026-07-23/my report (final).html', 'x', 'text/html',
      { cfg: { onedrive_site_id: SITE_ID, onedrive_folder: 'Garden Reports/Zürich café' }, token: 'TOK' });

    assert.strictEqual(calls.length, 1, 'exactly one Graph call');
    const { url, opts } = calls[0];

    // Hits /sites/{id}/drive, not the old /users/{upn}/drive.
    assert.ok(url.startsWith('https://graph.microsoft.com/v1.0/sites/'), url);
    assert.ok(url.includes('/drive/root:/'), url);
    assert.ok(url.endsWith(':/content'), url);
    assert.ok(!url.includes('/users/'), 'must not use the removed personal-drive path');

    // Composite site id commas encoded as %2C — the id stays one path segment.
    assert.ok(url.includes('contoso.sharepoint.com%2C11111111'), 'commas must be percent-encoded');
    assert.ok(!url.includes('contoso.sharepoint.com,'), 'raw comma must not survive in the id');

    // Folder hierarchy preserved (slash kept) but spaces/unicode encoded.
    assert.ok(url.includes('Garden%20Reports/Z%C3%BCrich%20caf%C3%A9'), url);
    assert.ok(url.includes('my%20report%20(final).html'), url);

    assert.strictEqual(opts.method, 'PUT');
    assert.strictEqual(opts.headers.Authorization, 'Bearer TOK');
    assert.strictEqual(opts.headers['Content-Type'], 'text/html');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.id, 'ITEM1');
  });
});
