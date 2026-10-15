const test = require('node:test');
const assert = require('node:assert');
const { summarizeRollingContext } = require('../dist/main/sessions.js');

test('summarizeRollingContext: replaces command stdout older than 3 turns when exit code is 0', () => {
  // Construct 5 turns (each turn has user + assistant, so 10 messages)
  const messages = [];

  // Turn 1 (oldest, 4 turns from end):
  messages.push({ role: 'user', text: 'Run build command' });
  messages.push({
    role: 'assistant',
    text: 'Command exited with code 0.\nOutput:\n' + 'Compiling module... OK\n'.repeat(50),
  });

  // Turn 2 (3 turns from end):
  messages.push({ role: 'user', text: 'Run linter' });
  messages.push({
    role: 'assistant',
    text: 'status: 0\nstdout:\nLinting 250 files... All clean!\n',
  });

  // Turn 3 (2 turns from end):
  messages.push({ role: 'user', text: 'Run failed test' });
  messages.push({
    role: 'assistant',
    text: 'Command exited with code 1.\nOutput:\nAssertionError: expected true but got false\n',
  });

  // Turn 4 (1 turn from end):
  messages.push({ role: 'user', text: 'Check recent git status' });
  messages.push({
    role: 'assistant',
    text: 'Command exited with code 0.\nOutput:\nOn branch main\nnothing to commit\n',
  });

  // Turn 5 (most recent turn):
  messages.push({ role: 'user', text: 'What is next?' });
  messages.push({ role: 'assistant', text: 'We are ready to deploy!' });

  const summarized = summarizeRollingContext(messages, 3);

  // Turn 1 (index 1): older than 3 turns, exit code 0 -> stdout should be hidden
  assert.ok(summarized[1].text.includes('[System: Command executed successfully. Output hidden.]'));
  assert.ok(!summarized[1].text.includes('Compiling module... OK'));

  // Turn 2 (index 3): 3 turns from end, exit code 0 -> stdout should be hidden
  assert.ok(summarized[3].text.includes('[System: Command executed successfully. Output hidden.]'));

  // Turn 3 (index 5): failed command (code 1) -> must NOT be hidden
  assert.ok(!summarized[5].text.includes('Output hidden'));
  assert.ok(summarized[5].text.includes('AssertionError: expected true but got false'));

  // Turn 4 (index 7): recent command (< 3 turns) -> must NOT be hidden
  assert.ok(!summarized[7].text.includes('Output hidden'));
  assert.ok(summarized[7].text.includes('On branch main'));
});
