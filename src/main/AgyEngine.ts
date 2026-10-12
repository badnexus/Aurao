import { EventEmitter } from 'node:events';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IEngine } from './IEngine';
import type { EngineEvent, EngineOptions, ModelChoice } from './EngineTypes';
import { assistantTerminalLines, describeTool } from './EngineTypes';
import type { ApprovalMode } from './config';
import { t } from './i18n';

export class AgyEngine extends EventEmitter implements IEngine {
  private stopped = false;
  private proc: ChildProcess | null = null;
  /** stdout arrives in arbitrary chunks; keep the unfinished last line until its newline comes. */
  private stdoutRest = '';
  /** Agent text of the current response, mirrored to the Terminal view when it is done. */
  private responseText = '';
  private toolNames = new Map<string, string>();
  /** A message was sent and its 'result' has not arrived yet. */
  private turnOpen = false;
  private exited = false;
  readonly restartOnInterrupt = true;

  private hookServer: http.Server | null = null;
  private hookPort = 0;
  private hookInstalled = false;
  private pendingHooks = new Map<string, { toolName: string; resolve: (res: { decision: 'allow' | 'deny'; reason?: string }) => void }>();
  private alwaysAllowedTools = new Set<string>();
  private approvalMode: ApprovalMode = 'safe';

  isAlive(): boolean {
    return Boolean(this.proc) && !this.exited && Boolean(this.proc?.stdin?.writable);
  }

  constructor(private readonly opts: EngineOptions) {
    super();
    this.approvalMode = opts.approvalMode ?? (opts.skipPermissions ? 'bypass' : 'safe');
  }

  emitEvent(ev: EngineEvent): void {
    if (this.stopped) return;
    this.emit('event', ev);
  }

  async start(): Promise<void> {
    this.emitEvent({ kind: 'terminal', line: t('engine.starting', { agent: this.opts.agentName || 'Agy', cwd: this.opts.cwd }), level: 'info' });

    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    // In headless stream-json mode, agy auto-denies interactive tools unless --dangerously-skip-permissions is passed.
    // When permissions are enabled, our PreToolUse hook server intercepts every dangerous tool call, displays
    // the Approval Card in Termi, and holds the hook response until the user approves or denies.
    args.push('--dangerously-skip-permissions');
    await this.setupHookServer();
    if (this.approvalMode === 'bypass') {
      this.emitEvent({ kind: 'terminal', line: t('engine.skipWarning'), level: 'stderr' });
    }
    if (this.opts.model) {
      if (!SAFE_ARG.test(this.opts.model)) {
        this.emitEvent({ kind: 'error', text: t('agy.invalidModel', { model: this.opts.model }) });
        return;
      }
      args.push('--model', this.opts.model);
    }

    const exe = findOnPath('agy');
    if (!exe) {
      this.emitEvent({ kind: 'error', text: t('agy.notFound') });
      return;
    }
    // A .cmd/.bat wrapper (npm installs agy that way on Windows) can only run through cmd.exe;
    // all arguments are fixed flags or SAFE_ARG-checked, so the joined command line is safe.
    this.proc = /\.(cmd|bat)$/i.test(exe)
      ? spawn(`"${exe}" ${args.join(' ')}`, { cwd: this.opts.cwd, shell: true, windowsHide: true })
      : spawn(exe, args, { cwd: this.opts.cwd, windowsHide: true });

    this.proc.on('error', (err: NodeJS.ErrnoException) => {
      this.exited = true;
      this.emitEvent({ kind: 'error', text: err.code === 'ENOENT' ? (fs.existsSync(this.opts.cwd) ? t('agy.notFound') : t('agy.badCwd', { cwd: this.opts.cwd })) : t('agy.startFailed', { e: String(err) }) });
    });
    this.proc.stdin?.on('error', (err) => {
      this.emitEvent({ kind: 'terminal', line: `stdin: ${String(err)}`, level: 'stderr' });
    });

    this.proc.stdout?.on('data', (data: Buffer) => {
      const lines = (this.stdoutRest + data.toString()).split(/\r?\n/);
      this.stdoutRest = lines.pop() ?? '';
      for (const line of lines) this.handleLine(line);
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split(/\r?\n/).filter((l) => l.trim())) {
        this.emitEvent({ kind: 'terminal', line, level: 'stderr' });
      }
    });

    this.proc.on('close', (code) => {
      this.exited = true;
      if (this.stdoutRest) this.handleLine(this.stdoutRest);
      this.stdoutRest = '';
      this.emitEvent({ kind: 'status', text: t('agy.exited', { code: String(code) }) });
      // Unlock the UI if the process died mid-turn.
      if (this.turnOpen) this.emitEvent({ kind: 'result', costUsd: 0, durationMs: 0, numTurns: 0, isError: true });
      this.turnOpen = false;
    });

    // agy has no init handshake we wait for; the UI may send as soon as the process is spawned.
    this.emitEvent({ kind: 'ready' });
    this.emitEvent({
      kind: 'init',
      model: this.opts.model || 'default',
      version: 'agy-cli',
      permissionMode: this.opts.skipPermissions ? 'bypassPermissions' : 'default',
      skills: [],
      slashCommands: [],
      tools: [],
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // plain-text output (warnings, banners) – show it instead of dropping it
      this.emitEvent({ kind: 'terminal', line, level: 'info' });
      return;
    }
    this.handleAgyEvent(parsed as AgyEvent);
  }

  private handleAgyEvent(ev: AgyEvent): void {
    if (ev.event === 'init') {
      this.emitEvent({ kind: 'terminal', line: t('engine.readyAgy', { model: ev.model ? t('engine.modelSuffix', { model: ev.model }) : '' }), level: 'info' });
    } else if (ev.event === 'step_update' && ev.step_update) {
      const step = ev.step_update;

      if (step.step_type === 'agent_response') {
        if (step.text_delta) {
          if (!this.responseText) this.emitEvent({ kind: 'text_start' });
          this.responseText += step.text_delta;
          this.emitEvent({ kind: 'text_delta', text: step.text_delta });
        }
        if (step.state === 'DONE') {
          this.emitEvent({ kind: 'text_done' });
          if (this.responseText.trim()) for (const t of assistantTerminalLines(this.responseText)) this.emitEvent(t);
          this.responseText = '';
        }
      } else if (step.step_type === 'tool') {
        const id = `step-${step.step_index}`;
        if (step.state === 'ACTIVE') {
          if (this.toolNames.has(id)) return; // repeated ACTIVE updates for the same step
          const name = step.tool_name || 'Tool';
          const input = (step.tool_info?.parameters || {}) as Record<string, unknown>;
          const { summary } = describeTool(name, input);
          this.toolNames.set(id, name);
          this.emitEvent({ kind: 'terminal', line: `▶ ${name}  ${summary}`, level: 'tool' });
          this.emitEvent({ kind: 'tool_use', id, name, summary, input });
        } else if (step.state === 'DONE' || step.state === 'ERROR') {
          const isError = step.state === 'ERROR';
          const summary = step.tool_info?.error?.message || (isError ? t('engine.toolError') : t('engine.toolOk'));
          this.toolNames.delete(id);
          this.emitEvent({ kind: 'terminal', line: `${isError ? '✗' : '✓'} ${summary}`, level: isError ? 'stderr' : 'tool' });
          this.emitEvent({ kind: 'tool_result', id, summary, isError });
        }
      } else {
        this.emitEvent({ kind: 'terminal', line: `${step.step_type ?? 'step'} ${step.state ?? ''}`.trim(), level: 'info' });
      }
    } else if (ev.event === 'permission_request' && ev.request_id) {
      // Assumed shape – verify against agy's real stream-json output (see README).
      const toolName = ev.tool_name || 'Tool';
      const input = (ev.parameters || {}) as Record<string, unknown>;
      const { summary, detail } = describeTool(toolName, input);
      this.emitEvent({ kind: 'terminal', line: t('engine.approvalAsk', { tool: toolName, summary }), level: 'hook' });
      this.emitEvent({ kind: 'permission_request', requestId: ev.request_id, toolName, summary, detail, input, canAlways: false });
    } else if (ev.event === 'result') {
      const durationMs = (ev.result?.duration_seconds || 0) * 1000;
      const numTurns = ev.result?.num_turns || 0;
      const isError = ev.result?.status === 'ERROR';
      this.emitEvent({
        kind: 'terminal',
        line: t('engine.resultLine', { status: isError ? t('engine.failed') : t('engine.done'), s: (durationMs / 1000).toFixed(1), n: numTurns }),
        level: 'result',
      });
      this.turnOpen = false;
      this.emitEvent({ kind: 'result', costUsd: 0, durationMs, numTurns, isError });
    } else {
      // Unknown event types are shown, never silently dropped.
      this.emitEvent({ kind: 'terminal', line: `agy/${ev.event ?? '?'}`, level: 'info' });
    }
  }

  private write(msg: unknown): boolean {
    const stdin = this.proc?.stdin;
    if (!stdin || !stdin.writable) return false;
    stdin.write(JSON.stringify(msg) + '\n');
    return true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const [, p] of this.pendingHooks) {
      p.resolve({ decision: 'deny', reason: t('engine.sessionEnded') });
    }
    this.pendingHooks.clear();
    if (this.hookServer) {
      this.hookServer.close();
      this.hookServer = null;
    }
    this.cleanUpHookFiles();
    this.proc?.kill();
    this.removeAllListeners();
  }

  send(text: string): void {
    this.emitEvent({ kind: 'terminal', line: `> ${text.replace(/\s+/g, ' ').slice(0, 200)}`, level: 'info' });
    if (this.write({ event: 'user', message: { content: text } })) this.turnOpen = true;
    else {
      this.emitEvent({ kind: 'error', text: t('agy.notRunning') });
    }
  }

  async interrupt(): Promise<void> {
    // agy's stream-json input has no known interrupt event; ending the process is the only reliable stop.
    // The caller restarts the engine afterwards (restartOnInterrupt); here the UI is unlocked first.
    this.emitEvent({ kind: 'terminal', line: t('agy.noInterrupt'), level: 'info' });
    if (this.turnOpen) {
      this.turnOpen = false;
      this.emitEvent({ kind: 'result', costUsd: 0, durationMs: 0, numTurns: 0, isError: true });
    }
  }

  answerPermission(requestId: string, allow: boolean, always: boolean): void {
    const pendingHook = this.pendingHooks.get(requestId);
    if (pendingHook) {
      this.pendingHooks.delete(requestId);
      if (always && allow && pendingHook.toolName) {
        this.alwaysAllowedTools.add(pendingHook.toolName);
      }
      pendingHook.resolve({
        decision: allow ? 'allow' : 'deny',
        reason: allow ? undefined : t('engine.deniedByUser'),
      });
    }

    // Also write to process stdin if applicable
    this.write({ event: 'permission_resolved', request_id: requestId, allowed: allow, always });
    this.emitEvent({ kind: 'permission_resolved', requestId, allowed: allow });
    this.emitEvent({ kind: 'terminal', line: `${allow ? t('engine.allowed') : t('engine.denied')} (${requestId.slice(0, 8)})`, level: 'hook' });
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode;
    this.emitEvent({ kind: 'terminal', line: t('engine.approvalModeSwitched', { mode }), level: 'info' });
  }

  private setupHookServer(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.hookServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/check-tool') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const data = JSON.parse(body) as Record<string, unknown>;
              this.handleHookCheck(data, res);
            } catch {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ decision: 'allow' }));
            }
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.hookServer.on('error', (err) => {
        this.emitEvent({ kind: 'terminal', line: `Hook server error: ${String(err)}`, level: 'stderr' });
        resolve();
      });

      this.hookServer.listen(0, '127.0.0.1', () => {
        const addr = this.hookServer?.address() as AddressInfo;
        if (addr && addr.port) {
          this.hookPort = addr.port;
          this.installHookFiles();
        }
        resolve();
      });
    });
  }

  private installHookFiles(): void {
    try {
      const agentsDir = path.join(this.opts.cwd, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });

      const scriptContent = `const http = require('http');
const fs = require('fs');
try {
  const stdin = fs.readFileSync(0, 'utf8');
  const req = http.request({
    hostname: '127.0.0.1',
    port: ${this.hookPort},
    path: '/check-tool',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 300000
  }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      process.stdout.write(body || JSON.stringify({ decision: 'allow' }));
      process.exit(0);
    });
  });
  req.on('error', () => {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    process.exit(0);
  });
  req.write(stdin);
  req.end();
} catch {
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
  process.exit(0);
}
`;
      fs.writeFileSync(path.join(agentsDir, 'termi-hook.js'), scriptContent, 'utf8');

      const hooksPath = path.join(agentsDir, 'hooks.json');
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(hooksPath)) {
        try {
          existing = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
        } catch {
          existing = {};
        }
      }
      existing['termi-gate'] = {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                command: 'node termi-hook.js'
              }
            ]
          }
        ]
      };
      fs.writeFileSync(hooksPath, JSON.stringify(existing, null, 2), 'utf8');
      this.hookInstalled = true;
    } catch (err) {
      this.emitEvent({ kind: 'terminal', line: `Hook file creation warning: ${String(err)}`, level: 'stderr' });
    }
  }

  private handleHookCheck(data: Record<string, unknown>, res: http.ServerResponse): void {
    const toolCall = (data.toolCall || {}) as { name?: string; args?: Record<string, unknown> };
    const toolName = toolCall.name || 'Tool';
    const input = toolCall.args || {};

    const READ_ONLY_TOOLS = new Set([
      'view_file',
      'read_url_content',
      'search_web',
      'list_directory',
      'list_dir',
      'describe_task',
      'list_tasks',
      'status',
      'fetch_web_page',
    ]);

    if (this.approvalMode === 'bypass' || this.alwaysAllowedTools.has(toolName)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decision: 'allow' }));
      return;
    }

    if (this.approvalMode === 'safe' && READ_ONLY_TOOLS.has(toolName)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decision: 'allow' }));
      return;
    }

    const requestId = 'agy-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const { summary, detail } = describeTool(toolName, input);

    this.pendingHooks.set(requestId, {
      toolName,
      resolve: (decision) => {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(decision));
        } catch {
          // already ended
        }
      },
    });

    this.emitEvent({ kind: 'terminal', line: t('engine.approvalAsk', { tool: toolName, summary }), level: 'hook' });
    this.emitEvent({
      kind: 'permission_request',
      requestId,
      toolName,
      summary,
      detail,
      input,
      canAlways: true,
    });
  }

  private cleanUpHookFiles(): void {
    if (!this.hookInstalled) return;
    this.hookInstalled = false;
    try {
      const agentsDir = path.join(this.opts.cwd, '.agents');
      const scriptPath = path.join(agentsDir, 'termi-hook.js');
      if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);

      const hooksPath = path.join(agentsDir, 'hooks.json');
      if (fs.existsSync(hooksPath)) {
        let existing: Record<string, unknown> = {};
        try {
          existing = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
        } catch {
          existing = {};
        }
        delete existing['termi-gate'];
        if (Object.keys(existing).length === 0) {
          fs.unlinkSync(hooksPath);
        } else {
          fs.writeFileSync(hooksPath, JSON.stringify(existing, null, 2), 'utf8');
        }
      }
    } catch {
      // ignore
    }
  }

  private modelCache: ModelChoice[] | null = null;

  /** `agy models` prints "<id>\t<Display Name>" per line on stdout (progress text goes to stderr). */
  private fetchAgyModels(): Promise<ModelChoice[]> {
    if (this.modelCache) return Promise.resolve(this.modelCache);
    const exe = findOnPath('agy');
    if (!exe) return Promise.resolve([]);
    return new Promise((resolve) => {
      const cb = (err: Error | null, stdout: string) => {
        if (err) {
          this.emitEvent({ kind: 'terminal', line: t('agy.modelListFailed', { e: String(err) }), level: 'stderr' });
          resolve([]);
          return;
        }
        this.modelCache = parseAgyModels(stdout);
        resolve(this.modelCache);
      };
      const opts = { cwd: this.opts.cwd, timeout: 15000, windowsHide: true };
      if (/\.(cmd|bat)$/i.test(exe)) execFile(`"${exe}" models`, [], { ...opts, shell: true }, (e, out) => cb(e, String(out)));
      else execFile(exe, ['models'], opts, (e, out) => cb(e, String(out)));
    });
  }

  async listModels(): Promise<ModelChoice[]> {
    const found = await this.fetchAgyModels();
    const list = found.length ? [...found] : (this.opts.availableModels ?? []).map((m) => ({ value: m, displayName: m }));
    if (this.opts.model && !list.some((m) => m.value === this.opts.model)) list.push({ value: this.opts.model, displayName: this.opts.model });
    return list;
  }


  async setModel(): Promise<boolean> {
    return false; // --model is a launch argument: the caller restarts the engine
  }
}

/** Model names like "gemini-3-pro", "models/gemini:latest" – nothing a shell could interpret. */
const SAFE_ARG = /^[\w.:/@-]+$/;

/** Parse `agy models` stdout: "<id>\t<Display Name>" per line; lines without a safe id are skipped. */
export function parseAgyModels(stdout: string): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [id, ...rest] = line.trim().split(/\t+/);
    if (!id || !SAFE_ARG.test(id)) continue;
    out.push({ value: id, displayName: rest.join(' ').trim() || id });
  }
  return out;
}

/** Locate a command the way the shell would (PATH × PATHEXT on Windows). */
export function findOnPath(cmd: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir.replace(/^"|"$/g, ''), cmd + ext.toLowerCase());
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // not here
      }
    }
  }
  return null;
}

interface AgyEvent {
  event?: string;
  model?: string;
  request_id?: string;
  tool_name?: string;
  parameters?: unknown;
  step_update?: {
    step_type?: string;
    step_index?: number;
    state?: string;
    text_delta?: string;
    tool_name?: string;
    tool_info?: { parameters?: unknown; error?: { message?: string } };
  };
  result?: { duration_seconds?: number; num_turns?: number; status?: string };
}
