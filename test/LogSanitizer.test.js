const test = require('node:test');
const assert = require('node:assert');
const {
  stripAnsi,
  resolveCarriageReturns,
  stripNoise,
  truncateMiddleOut,
  sanitizeForLlm,
} = require('../dist/main/LogSanitizer.js');

test('stripAnsi: removes standard and extended ANSI codes', () => {
  const input = '\u001b[31mError:\u001b[0m \u001b[1mFile not found\u001b[22m';
  assert.strictEqual(stripAnsi(input), 'Error: File not found');

  const oscInput = '\u001b]0;Terminal Title\u0007Hello World';
  assert.strictEqual(stripAnsi(oscInput), 'Hello World');
});

test('resolveCarriageReturns: collapses progress bar overwrites to the final line state', () => {
  const input = 'Downloading 10%\rDownloading 50%\rDownloading 100%\nDone!';
  assert.strictEqual(resolveCarriageReturns(input), 'Downloading 100%\nDone!');
});

test('stripNoise: removes progress bars and spinners', () => {
  const input = 'Installing packages\n[=========>    ] 65%\n⠋ Fetching dependencies\n\n\nDone!';
  const cleaned = stripNoise(input);
  assert.ok(!cleaned.includes('[=========>    ]'));
  assert.ok(!cleaned.includes('⠋'));
  assert.ok(!cleaned.includes('\n\n\n'));
  assert.ok(cleaned.includes('Installing packages'));
  assert.ok(cleaned.includes('Done!'));
});

test('truncateMiddleOut: truncates middle of long multiline outputs (10 head + 40 tail)', () => {
  const lines = [];
  for (let i = 1; i <= 100; i++) {
    lines.push(`Line ${i}: Some detailed diagnostic log output with index ${i}`);
  }
  const text = lines.join('\n');
  assert.ok(text.length > 1000);

  const truncated = truncateMiddleOut(text, { maxChars: 1000, headLines: 10, tailLines: 40 });
  const resultLines = truncated.split('\n');

  // Should have 10 head + 1 notice + 40 tail = 51 lines
  assert.strictEqual(resultLines.length, 51);
  assert.strictEqual(resultLines[0], 'Line 1: Some detailed diagnostic log output with index 1');
  assert.strictEqual(resultLines[9], 'Line 10: Some detailed diagnostic log output with index 10');
  assert.strictEqual(resultLines[10], '... [Truncated 50 lines to preserve context window] ...');
  assert.strictEqual(resultLines[resultLines.length - 1], 'Line 100: Some detailed diagnostic log output with index 100');
});

test('truncateMiddleOut: handles minified single-line payloads via character-level fallback', () => {
  const minified = 'const a=1;' + 'x'.repeat(5000) + 'const b=2;';
  const truncated = truncateMiddleOut(minified, { maxChars: 1000, headLines: 10, tailLines: 40 });

  assert.ok(truncated.length < 2000);
  assert.ok(truncated.startsWith('const a=1;'));
  assert.ok(truncated.endsWith('const b=2;'));
  assert.ok(truncated.includes('Truncated'));
  assert.ok(truncated.includes('characters to preserve context window'));
});

test('sanitizeForLlm: combines pipeline and respects enabled flag', () => {
  const raw = '\u001b[32mStarting...\u001b[0m\nStep 1\rStep 2\n[====> ] 50%\nFinished';

  // Disabled: unchanged
  assert.strictEqual(sanitizeForLlm(raw, false), raw);

  // Enabled: processed
  const sanitized = sanitizeForLlm(raw, true);
  assert.ok(!sanitized.includes('\u001b[32m'));
  assert.ok(!sanitized.includes('Step 1'));
  assert.ok(sanitized.includes('Step 2'));
  assert.ok(!sanitized.includes('[====> ]'));
  assert.ok(sanitized.includes('Finished'));
});
