const test = require('node:test');
const assert = require('node:assert');
const { StreamAccumulator } = require('../dist/main/StreamAccumulator.js');

test('StreamAccumulator: debounces multiple chunks and flushes combined text', async () => {
  const flushed = [];
  const accumulator = new StreamAccumulator((chunk) => {
    flushed.push(chunk);
  }, 50);

  accumulator.add('chunk1 ');
  accumulator.add('chunk2 ');
  accumulator.add('chunk3');

  assert.strictEqual(flushed.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.strictEqual(flushed.length, 1);
  assert.strictEqual(flushed[0], 'chunk1 chunk2 chunk3');
  accumulator.dispose();
});

test('StreamAccumulator: flushes immediately when maxBufferSize is reached', () => {
  const flushed = [];
  const accumulator = new StreamAccumulator((chunk) => {
    flushed.push(chunk);
  }, 1000, 20); // 20 chars max buffer

  accumulator.add('Hello World 123456'); // 18 chars (under 20)
  assert.strictEqual(flushed.length, 0);

  accumulator.add('7890'); // exceeds 20 chars
  assert.strictEqual(flushed.length, 1);
  assert.strictEqual(flushed[0], 'Hello World 1234567890');

  accumulator.dispose();
});

test('StreamAccumulator: manual flush and dispose', () => {
  const flushed = [];
  const accumulator = new StreamAccumulator((chunk) => {
    flushed.push(chunk);
  }, 500);

  accumulator.add('instant flush text');
  accumulator.flush();

  assert.strictEqual(flushed.length, 1);
  assert.strictEqual(flushed[0], 'instant flush text');

  accumulator.add('dispose flush text');
  accumulator.dispose();

  assert.strictEqual(flushed.length, 2);
  assert.strictEqual(flushed[1], 'dispose flush text');
});
