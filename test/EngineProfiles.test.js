const test = require('node:test');
const assert = require('node:assert');
const { sanitizeProfiles, applyProfileEnv } = require('../dist/main/engineProfiles.js');

test('sanitizeProfiles: keeps well-formed profiles, drops bad names and values', () => {
  const out = sanitizeProfiles({
    'Cloud A': { MY_RESOURCE: 'a', MY_REGION: null, lowercase: 'x', 'BAD-NAME': 'y', NUM: 1, FLAG: true },
    Empty: {},
    'Not an object': 'nope',
    '': { X: 'y' },
    List: ['X=1'],
  });
  assert.deepStrictEqual(out, { 'Cloud A': { MY_RESOURCE: 'a', MY_REGION: null }, Empty: {} });
});

test('sanitizeProfiles: undefined for non-objects and when nothing is left', () => {
  assert.strictEqual(sanitizeProfiles(undefined), undefined);
  assert.strictEqual(sanitizeProfiles(null), undefined);
  assert.strictEqual(sanitizeProfiles('x'), undefined);
  assert.strictEqual(sanitizeProfiles([]), undefined);
  assert.strictEqual(sanitizeProfiles({ a: 'b' }), undefined);
});

test('applyProfileEnv: overrides, removes on null, adds, leaves base untouched', () => {
  const base = { KEEP: '1', OVERRIDE: 'old', REMOVE: 'gone' };
  const env = applyProfileEnv(base, { OVERRIDE: 'new', REMOVE: null, ADDED: 'x' });
  assert.deepStrictEqual(env, { KEEP: '1', OVERRIDE: 'new', ADDED: 'x' });
  assert.deepStrictEqual(base, { KEEP: '1', OVERRIDE: 'old', REMOVE: 'gone' });
});

test('applyProfileEnv: no profile means a plain copy', () => {
  const base = { A: '1' };
  const env = applyProfileEnv(base);
  assert.deepStrictEqual(env, base);
  assert.notStrictEqual(env, base);
});
