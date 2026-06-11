const test = require('node:test');
const assert = require('node:assert');
const { parseCsv } = require('../src/siteImport');

test('parses CSV with flexible headers and quoted fields', () => {
  const csv = 'Site Name,Address,# of Lots,Latitude,Longitude\n' +
    '"Cedar Park, East","7 Cedar Ave",8,-36.8459,174.7512\n';
  const { sites, errors } = parseCsv(Buffer.from(csv));
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(sites.length, 1);
  assert.deepStrictEqual(sites[0], {
    name: 'Cedar Park, East', address: '7 Cedar Ave', lots: 8,
    lat: -36.8459, lng: 174.7512, contact_name: null, contact_phone: null, notes: null,
  });
});

test('reports rows with missing fields and bad numbers', () => {
  const csv = 'name,address,lots\n' +
    ',No Name St,5\n' +
    'Bad Lots,1 Bad St,many\n' +
    'Good Site,2 Good St,3\n';
  const { sites, errors } = parseCsv(Buffer.from(csv));
  assert.strictEqual(sites.length, 2); // Bad Lots kept, lots dropped
  assert.strictEqual(sites.find((s) => s.name === 'Bad Lots').lots, null);
  assert.strictEqual(errors.length, 2);
  assert.match(errors[0], /missing site name/);
  assert.match(errors[1], /not a valid lots/);
});

test('rejects files without a name column', () => {
  const { sites, errors } = parseCsv(Buffer.from('foo,bar\n1,2\n'));
  assert.strictEqual(sites.length, 0);
  assert.match(errors[0], /Site Name/);
});
