const test = require('node:test');
const assert = require('node:assert');
const { expandHome } = require('../dist/main/paths.js');

test('expandHome: ~ and ~/x resolve against the home folder', () => {
  assert.strictEqual(expandHome('~', 'C:\\Users\\jane'), 'C:\\Users\\jane');
  assert.strictEqual(expandHome('~/CaptAIn', 'C:\\Users\\jane'), 'C:\\Users\\jane\\CaptAIn');
  assert.strictEqual(expandHome('~\\CaptAIn\\sub', 'C:\\Users\\jane\\'), 'C:\\Users\\jane\\CaptAIn\\sub');
});

test('expandHome: other paths are returned unchanged', () => {
  assert.strictEqual(expandHome('C:\\Tools\\x', 'C:\\Users\\jane'), 'C:\\Tools\\x');
  assert.strictEqual(expandHome('~user/x', 'C:\\Users\\jane'), '~user/x');
  assert.strictEqual(expandHome('', 'C:\\Users\\jane'), '');
});
