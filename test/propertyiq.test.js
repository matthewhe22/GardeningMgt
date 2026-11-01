// Unit tests for the PropertyIQ address-matching logic. These lock in the
// hard gates that stop a completed job report (which contains the site
// address, GPS, photos and comments) from being emailed to the WRONG
// building's owners — a privacy leak. Pure functions, no network / DB.

// settings.js (required transitively) fails closed without a key.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-unit-tests';

const test = require('node:test');
const assert = require('node:assert');
const { extractStreetNumbers, matchAddress, matchQuality } = require('../src/propertyiq');

test('extractStreetNumbers', async (t) => {
  const set = (s) => [...extractStreetNumbers(s)].sort();

  await t.test('leading number', () => assert.deepStrictEqual(set('12 Smith St'), ['12']));
  await t.test('strips trailing postcode', () =>
    assert.deepStrictEqual(set('12 Park Avenue, Bondi NSW 2026'), ['12']));
  await t.test('range expands to endpoints', () =>
    assert.deepStrictEqual(set('10-12 Smith Street'), ['10', '12']));
  await t.test('unit form takes the street number after the slash', () =>
    assert.deepStrictEqual(set('Unit 5/10 Smith St'), ['10']));
  await t.test('unit + range', () =>
    assert.deepStrictEqual(set('5/10-12 Smith St'), ['10', '12']));
  await t.test('number that is not first (level prefix)', () =>
    assert.deepStrictEqual(set('Level 2, 40 King Street'), ['40']));
  await t.test('shop prefix', () =>
    assert.deepStrictEqual(set('Shop 3, 100 Main Rd'), ['100']));
  await t.test('no street number', () =>
    assert.deepStrictEqual(set('King Street'), []));
  await t.test('building streetNo field with a range', () =>
    assert.deepStrictEqual(set('10-12'), ['10', '12']));
});

test('matchAddress hard gates', async (t) => {
  await t.test('HIGH #1: different street TYPE is rejected (Park Avenue vs Park Road)', () => {
    const score = matchAddress('12 Park Avenue, Bondi NSW 2026',
      { streetNo: '12', streetName: 'Park Road', suburb: 'Manly', state: 'NSW', postcode: '2095' });
    assert.strictEqual(score, 0);
  });

  await t.test('HIGH #2: non-numeric-leading address still enforces the street-number gate', () => {
    // "Level 2, 40 King St" must NOT match a building at number 2.
    const score = matchAddress('Level 2, 40 King Street, Sydney NSW 2000',
      { streetNo: '2', streetName: 'King Street', suburb: 'Newtown' });
    assert.strictEqual(score, 0);
  });

  await t.test('the CORRECT building for a level-prefixed address matches', () => {
    const score = matchAddress('Level 2, 40 King Street, Sydney NSW 2000',
      { streetNo: '40', streetName: 'King Street', suburb: 'Sydney', postcode: '2000' });
    assert.ok(score > 0);
  });

  await t.test('MEDIUM #3: range street numbers match (10-12 vs 10-12, and vs 10)', () => {
    const b = { streetNo: '10-12', streetName: 'Smith Street', suburb: 'Carlton', postcode: '3053' };
    assert.ok(matchAddress('10-12 Smith Street, Carlton VIC 3053', b) > 0);
    assert.ok(matchAddress('10 Smith Street, Carlton VIC 3053', b) > 0);
  });

  await t.test('postcode conflict is rejected even when name + number + suburb agree', () => {
    const score = matchAddress('12 Park Road, Sydney NSW 2000',
      { streetNo: '12', streetName: 'Park Road', suburb: 'Sydney', postcode: '3000' });
    assert.strictEqual(score, 0);
  });

  await t.test('a missing postcode on either side does not block a match', () => {
    const score = matchAddress('12 Park Road, Sydney',
      { streetNo: '12', streetName: 'Park Road', suburb: 'Sydney', postcode: '2000' });
    assert.ok(score > 0);
  });

  await t.test('exact match scores highest', () => {
    const exact = matchAddress('40 King Street, Sydney NSW 2000',
      { streetNo: '40', streetName: 'King Street', suburb: 'Sydney', postcode: '2000' });
    const weaker = matchAddress('40 King Street, Sydney NSW 2000',
      { streetNo: '40', streetName: 'King Street', suburb: 'Redfern' }); // suburb differs, no postcode
    assert.ok(exact > weaker);
  });

  await t.test('a building with no street name never matches', () => {
    assert.strictEqual(matchAddress('12 Smith Street', { streetNo: '12', streetName: '' }), 0);
  });

  await t.test('wrong street number is rejected', () => {
    assert.strictEqual(matchAddress('12 Smith Street, Carlton',
      { streetNo: '99', streetName: 'Smith Street', suburb: 'Carlton' }), 0);
  });
});

test('matchQuality strong-match flag (early-exit signal)', async (t) => {
  const b = { streetNo: '40', streetName: 'King Street', suburb: 'Sydney', state: 'NSW', postcode: '2000' };

  await t.test('a complete-address match (number + street + suburb + postcode) is strong', () => {
    const q = matchQuality('40 King Street, Sydney NSW 2000', b);
    assert.ok(q.score > 0);
    assert.strictEqual(q.strong, true);
  });

  await t.test('a match missing the postcode is NOT strong (keeps scanning for a better one)', () => {
    const q = matchQuality('40 King Street, Sydney', b);
    assert.ok(q.score > 0);
    assert.strictEqual(q.strong, false);
  });

  await t.test('a match missing the suburb is NOT strong', () => {
    const q = matchQuality('40 King Street 2000', b);
    assert.ok(q.score > 0);
    assert.strictEqual(q.strong, false);
  });

  await t.test('a non-match is neither scored nor strong', () => {
    const q = matchQuality('40 King Avenue, Sydney NSW 2000', b);
    assert.strictEqual(q.score, 0);
    assert.strictEqual(q.strong, false);
  });

  await t.test('a building with no suburb/postcode can never be strong', () => {
    const q = matchQuality('12 Smith Street', { streetNo: '12', streetName: 'Smith Street' });
    assert.ok(q.score > 0);
    assert.strictEqual(q.strong, false);
  });
});
