const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { GptsEngine, isReadOnlyCommand } = require('../dist/main/GptsEngine.js');
const { listCodexSessions, getCodexSessionHistory } = require('../dist/main/sessions.js');

function createTestEngine(overrides = {}) {
  return new GptsEngine({
    cwd: process.cwd(),
    model: 'gpt-5.4',
    agentName: 'Aurao',
    skipPermissions: false,
    launchedWithSkipFlag: false,
    approvalMode: 'safe',
    sanitizeLogs: true,
    ...overrides,
  });
}

test('isReadOnlyCommand: distinguishes safe read-only inspection commands from mutating commands', () => {
  assert.strictEqual(isReadOnlyCommand('git status'), true);
  assert.strictEqual(isReadOnlyCommand(['/bin/zsh', '-lc', 'git log -n 5']), true);
  assert.strictEqual(isReadOnlyCommand(['cmd.exe', '/c', 'dir']), true);
  assert.strictEqual(isReadOnlyCommand('rg "GptsEngine" src/main'), true);

  assert.strictEqual(isReadOnlyCommand('rm -rf dist'), false);
  assert.strictEqual(isReadOnlyCommand('git commit -m "test"'), false);
  assert.strictEqual(isReadOnlyCommand('git status && rm file.txt'), false);
  assert.strictEqual(isReadOnlyCommand('echo hello > out.txt'), false);
  assert.strictEqual(isReadOnlyCommand('npm install lodash'), false);
});

test('GptsEngine (app-server JSON-RPC): streams deltas, tool events, and turn completion', () => {
  const engine = createTestEngine();
  const events = [];
  engine.on('event', (ev) => events.push(ev));

  engine.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    method: 'thread/started',
    params: { thread: { id: 'thread_abc123' } },
  }));
  assert.strictEqual(engine.getThreadId(), 'thread_abc123');

  engine.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    method: 'turn/started',
    params: { turn: { id: 'turn_1' } },
  }));

  engine.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    method: 'item/started',
    params: {
      item: {
        id: 'item_cmd_1',
        type: 'commandExecution',
        command: ['bash', '-lc', 'git status'],
        cwd: '/repo',
      },
    },
  }));

  engine.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    method: 'item/completed',
    params: {
      item: {
        id: 'item_cmd_1',
        type: 'commandExecution',
        aggregatedOutput: 'On branch main\n',
        exitCode: 0,
      },
    },
  }));

  engine.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    method: 'item/agentMessage/delta',
    params: { itemId: 'msg_1', delta: 'Hallo ' },
  }));
  engine.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    method: 'item/agentMessage/delta',
    params: { itemId: 'msg_1', delta: 'Florian!' },
  }));

  engine.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: { turn: { id: 'turn_1', status: 'completed' } },
  }));

  const toolEvent = events.find((e) => e.kind === 'tool_use');
  assert.ok(toolEvent, 'Expected a tool_use event for commandExecution');
  assert.strictEqual(toolEvent.name, 'Bash');
  assert.strictEqual(toolEvent.input.command, 'git status');

  const toolResultEvent = events.find((e) => e.kind === 'tool_result');
  assert.ok(toolResultEvent, 'Expected a tool_result event on item/completed');
  assert.strictEqual(toolResultEvent.isError, false);

  const deltaText = events
    .filter((e) => e.kind === 'text_delta')
    .map((e) => e.text)
    .join('');
  assert.strictEqual(deltaText, 'Hallo Florian!');

  const resultEvent = events.find((e) => e.kind === 'result');
  assert.ok(resultEvent, 'Expected result event on turn/completed');
  assert.strictEqual(resultEvent.isError, false);
});

test('GptsEngine (app-server approvals): safe mode auto-approves read-only commands and prompts for mutating commands', () => {
  const engine = createTestEngine({ approvalMode: 'safe' });
  const events = [];
  const sentMessages = [];
  engine.on('event', (ev) => events.push(ev));

  // Attach a mock daemon stdin to capture JSON-RPC responses
  engine.proc = {
    killed: false,
    stdin: {
      writable: true,
      write: (chunk) => sentMessages.push(JSON.parse(chunk.trim())),
    },
  };

  // 1. Read-only command in 'safe' mode -> auto-accepted without UI permission card
  engine.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 41,
    method: 'item/commandExecution/requestApproval',
    params: {
      itemId: 'cmd_read',
      command: ['bash', '-lc', 'git status'],
      cwd: '/repo',
    },
  }));

  assert.strictEqual(events.filter((e) => e.kind === 'permission_request').length, 0);
  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].id, 41);
  assert.strictEqual(sentMessages[0].result.decision, 'accept');

  // 2. Mutating command in 'safe' mode -> emits UI permission card and waits for answerPermission
  engine.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 42,
    method: 'item/commandExecution/requestApproval',
    params: {
      itemId: 'cmd_write',
      command: ['bash', '-lc', 'npm install express'],
      cwd: '/repo',
    },
  }));

  const permEvents = events.filter((e) => e.kind === 'permission_request');
  assert.strictEqual(permEvents.length, 1);
  assert.strictEqual(permEvents[0].toolName, 'Bash');

  engine.answerPermission(permEvents[0].requestId, true, true);
  assert.strictEqual(sentMessages.length, 2);
  assert.strictEqual(sentMessages[1].id, 42);
  assert.strictEqual(sentMessages[1].result.decision, 'acceptForSession');
  assert.strictEqual(sentMessages[1].result.approved, true);
});

test('GptsEngine (exec --json fallback): parses thread.started, item.completed, and turn.completed', () => {
  const engine = createTestEngine();
  const events = [];
  engine.on('event', (ev) => events.push(ev));

  engine.handleLine(JSON.stringify({
    type: 'thread.started',
    thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53',
  }));
  assert.strictEqual(engine.getThreadId(), '0199a213-81c0-7800-8aa1-bbab2a035a53');

  engine.handleLine(JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'agent_message',
      text: 'Antwort aus codex exec --json.',
    },
  }));

  engine.handleLine(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 100, output_tokens: 25 },
  }));

  const deltaText = events
    .filter((e) => e.kind === 'text_delta')
    .map((e) => e.text)
    .join('');
  assert.strictEqual(deltaText, 'Antwort aus codex exec --json.');

  const resultEvent = events.find((e) => e.kind === 'result');
  assert.ok(resultEvent);
  assert.strictEqual(resultEvent.isError, false);
});

test('GptsEngine: listModels returns default Codex/GPT models and setModel updates live', async () => {
  const engine = createTestEngine({ model: 'gpt-5.4' });
  const models = await engine.listModels();
  assert.ok(models.some((m) => m.value === 'gpt-5.4'));
  assert.ok(models.some((m) => m.value === 'gpt-5.3-codex'));

  const switched = await engine.setModel('gpt-5.3-codex');
  assert.strictEqual(switched, true);
  await engine.stop();
});

test('listCodexSessions and getCodexSessionHistory: parses rollout JSONL files with mtime caching', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurao-codex-sessions-'));
  try {
    const dayDir = path.join(tmpDir, '2026', '10', '16');
    fs.mkdirSync(dayDir, { recursive: true });

    const sessionId = '019c9d43-49b9-7f63-91be-e7d4adeb4827';
    const rolloutFile = path.join(dayDir, `rollout-2026-10-16T21-00-00-${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        timestamp: '2026-10-16T21:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: sessionId,
          cwd: 'C:\\Users\\flori\\Documents\\Workspace\\temp\\Termi',
          timestamp: '2026-10-16T21:00:00.000Z',
        },
      }),
      JSON.stringify({
        timestamp: '2026-10-16T21:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Bitte prüfe die Codex CLI Latenz.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-10-16T21:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Der persistente app-server läuft ohne Cold-Spawn-Latenz.' }],
        },
      }),
    ];
    fs.writeFileSync(rolloutFile, lines.join('\n') + '\n', 'utf8');

    const sessions = await listCodexSessions('C:\\Users\\flori\\Documents\\Workspace\\temp\\Termi', tmpDir);
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].id, sessionId);
    assert.strictEqual(sessions[0].title, 'Bitte prüfe die Codex CLI Latenz.');

    // Second call hits mtime cache and returns identical result
    const cachedSessions = await listCodexSessions('C:\\Users\\flori\\Documents\\Workspace\\temp\\Termi', tmpDir);
    assert.strictEqual(cachedSessions.length, 1);
    assert.strictEqual(cachedSessions[0].id, sessionId);

    const history = await getCodexSessionHistory(sessionId, tmpDir);
    assert.strictEqual(history.length, 2);
    assert.deepStrictEqual(history[0], {
      role: 'user',
      text: 'Bitte prüfe die Codex CLI Latenz.',
      timestamp: '2026-10-16T21:00:01.000Z',
    });
    assert.deepStrictEqual(history[1], {
      role: 'assistant',
      text: 'Der persistente app-server läuft ohne Cold-Spawn-Latenz.',
      timestamp: '2026-10-16T21:00:03.000Z',
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
