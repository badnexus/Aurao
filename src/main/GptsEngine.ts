import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IEngine } from './IEngine';
import type { EngineEvent, EngineOptions, ModelChoice } from './EngineTypes';
import { assistantTerminalLines, describeTool } from './EngineTypes';
import type { ApprovalMode } from './config';
import { t } from './i18n';
import { findOnPath } from './AgyEngine';
import { StreamAccumulator } from './StreamAccumulator';
import { stripAnsi } from './LogSanitizer';

export interface ResolvedCodexBinary {
  exe: string;
  isCmdShim: boolean;
}

const DEFAULT_CODEX_MODELS: ModelChoice[] = [
  { value: 'gpt-5.4', displayName: 'GPT-5.4', description: 'Latest OpenAI flagship agentic & coding model' },
  { value: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', description: 'OpenAI flagship coding & agentic model' },
  { value: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', description: 'Balanced speed and coding reasoning' },
  { value: 'gpt-5', displayName: 'GPT-5', description: 'General-purpose reasoning and writing' },
  { value: 'o3', displayName: 'o3 Reasoning', description: 'Deep analytical and mathematical reasoning' },
  { value: 'o4-mini', displayName: 'o4-mini Fast', description: 'Low-latency everyday tasks' },
];

const SAFE_ARG = /^[\w.:/@-]+$/;

/** Normalize a Codex command (string or argv array) into a clean human-readable shell string. */
export function formatCommand(cmd: unknown): string {
  if (Array.isArray(cmd)) {
    const parts = cmd.map((p) => String(p));
    if (parts.length >= 3 && /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|zsh|sh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/i.test(parts[0]) && /^(-lc|-c|\/c|\/C|-Command)$/i.test(parts[1])) {
      return parts.slice(2).join(' ');
    }
    return parts.join(' ');
  }
  return typeof cmd === 'string' ? cmd : '';
}

/**
 * Resolve `codex` on PATH and, on Windows, unwrap npm's `.cmd`/`.bat` shim directly to the
 * underlying native Rust `codex.exe` binary when present. Spawning the native binary directly
 * avoids spawning `cmd.exe -> node.exe -> codex.exe` (saving 150-300ms startup latency and
 * preventing orphaned child processes on interrupt).
 */
export function resolveCodexBinary(customPath?: string): ResolvedCodexBinary | null {
  const found = customPath && fs.existsSync(customPath) ? customPath : findOnPath('codex');
  if (!found) return null;

  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(found)) {
    const binDir = path.dirname(found);
    const archDir = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const pkgPlatform = process.arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
    const candidates = [
      path.join(binDir, 'node_modules', '@openai', 'codex', 'vendor', archDir, 'codex', 'codex.exe'),
      path.join(binDir, 'node_modules', '@openai', 'codex', 'bin', `codex-${archDir}.exe`),
      path.join(binDir, 'node_modules', '@openai', `codex-${pkgPlatform}`, 'bin', 'codex.exe'),
      path.join(binDir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-${pkgPlatform}`, 'bin', 'codex.exe'),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) {
          return { exe: candidate, isCmdShim: false };
        }
      } catch {
        // try next candidate
      }
    }
    return { exe: found, isCmdShim: true };
  }

  return { exe: found, isCmdShim: false };
}

/** Heuristic for read-only shell commands that do not mutate files in 'safe' mode. */
export function isReadOnlyCommand(cmd: string | string[]): boolean {
  const trimmed = formatCommand(cmd).trim();
  if (!trimmed) return true;
  // Reject shell redirection, command chaining, or mutating commands
  if (/[>|&;]|rm\s|del\s|Remove-Item|mv\s|cp\s|git\s+(commit|push|reset|clean|checkout|merge|rebase)|npm\s+(install|i|publish|unpublish)|Set-Content|Out-File/i.test(trimmed)) {
    return false;
  }
  return /^(ls|dir|pwd|cat|type|head|tail|echo|Get-ChildItem|Get-Content|Get-Location|git\s+(status|diff|log|branch|show)|rg|grep|find|where|which)\b/i.test(
    trimmed,
  );
}

interface PendingRpc {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingApproval {
  rpcId?: number | string;
  toolKey: string;
  onDecision: (allow: boolean, always: boolean) => void;
}

export class GptsEngine extends EventEmitter implements IEngine {
  private stopped = false;
  private proc: ChildProcess | null = null;
  private stdoutRest = '';
  private exited = false;
  private execFallbackMode = false;

  private currentModel: string;
  private approvalMode: ApprovalMode;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private turnOpen = false;
  private turnStartMs = 0;
  private stepCount = 0;

  private responseText = '';
  private textStarted = false;
  private lastItemTextById = new Map<string, string>();
  private activeTools = new Set<string>();

  private nextRpcId = 1;
  private pendingRpc = new Map<number, PendingRpc>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private alwaysAllowedTools = new Set<string>();
  private cachedServerModels: ModelChoice[] | null = null;
  private handshakePromise: Promise<boolean> | null = null;

  readonly restartOnInterrupt = false;

  // Batch token deltas (30 ms / ~33 fps) to keep UI rendering smooth and IPC overhead low.
  private textAccumulator = new StreamAccumulator(
    (chunk) => {
      if (!this.textStarted) {
        this.textStarted = true;
        this.emitEvent({ kind: 'text_start' });
      }
      this.responseText += chunk;
      this.emitEvent({ kind: 'text_delta', text: chunk });
    },
    30,
    2048,
  );

  // Batch stderr lines (60 ms) and strip ANSI codes for the Actions view.
  private stderrAccumulator = new StreamAccumulator((chunk) => {
    const text = this.opts.sanitizeLogs !== false ? stripAnsi(chunk) : chunk;
    for (const line of text.split(/\r?\n/).filter((l) => l.trim())) {
      this.emitEvent({ kind: 'terminal', line, level: 'stderr' });
    }
  }, 60);

  constructor(private readonly opts: EngineOptions) {
    super();
    this.currentModel = opts.model || '';
    this.approvalMode = opts.approvalMode ?? (opts.skipPermissions ? 'bypass' : 'safe');
    if (opts.resumeConversationId && SAFE_ARG.test(opts.resumeConversationId)) {
      this.threadId = opts.resumeConversationId;
    }
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  isAlive(): boolean {
    if (this.execFallbackMode) return !this.stopped;
    return Boolean(this.proc) && !this.exited && Boolean(this.proc?.stdin?.writable);
  }

  emitEvent(ev: EngineEvent): void {
    if (this.stopped) return;
    this.emit('event', ev);
  }

  async start(): Promise<void> {
    this.emitEvent({
      kind: 'terminal',
      line: t('engine.starting', { agent: this.opts.agentName || 'Aurao', cwd: this.opts.cwd }),
      level: 'info',
    });

    if (!fs.existsSync(this.opts.cwd)) {
      this.emitEvent({ kind: 'error', text: t('codex.badCwd', { cwd: this.opts.cwd }) });
      return;
    }

    const bin = resolveCodexBinary();
    if (!bin) {
      this.emitEvent({ kind: 'error', text: t('codex.notFound') });
      return;
    }

    if (this.approvalMode === 'bypass') {
      this.emitEvent({
        kind: 'terminal',
        line: t(this.opts.launchedWithSkipFlag ? 'engine.skipWarning' : 'engine.bypassWarning'),
        level: 'stderr',
      });
    }

    // Spawn persistent `codex app-server` daemon so turns execute with < 1ms dispatch latency.
    const startedAppServer = await this.startAppServerDaemon(bin);
    if (!startedAppServer && !this.stopped) {
      // Older Codex CLI without `app-server`: seamlessly use `codex exec --json` per turn.
      this.execFallbackMode = true;
    }

    const modelLabel = this.currentModel ? t('engine.modelSuffix', { model: this.currentModel }) : '';
    this.emitEvent({
      kind: 'terminal',
      line: t('engine.readyCodex', { model: modelLabel, mode: this.approvalMode }),
      level: 'info',
    });

    this.emitEvent({ kind: 'ready' });
    this.emitEvent({
      kind: 'init',
      model: this.currentModel || 'gpt-5.3-codex',
      version: this.execFallbackMode ? 'codex-exec' : 'codex-app-server',
      permissionMode: this.approvalMode,
      skills: [],
      slashCommands: [],
      tools: [],
    });
  }

  private startAppServerDaemon(bin: ResolvedCodexBinary): Promise<boolean> {
    this.handshakePromise = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      try {
        this.proc = bin.isCmdShim
          ? spawn(`"${bin.exe}" app-server`, { cwd: this.opts.cwd, shell: true, windowsHide: true })
          : spawn(bin.exe, ['app-server'], { cwd: this.opts.cwd, windowsHide: true });
      } catch (err) {
        this.exited = true;
        this.emitEvent({ kind: 'error', text: t('codex.startFailed', { e: String(err) }) });
        finish(false);
        return;
      }

      this.proc.on('error', (err: NodeJS.ErrnoException) => {
        this.exited = true;
        if (!settled) {
          finish(false);
          return;
        }
        this.emitEvent({
          kind: 'error',
          text: err.code === 'ENOENT' ? t('codex.notFound') : t('codex.startFailed', { e: String(err) }),
        });
      });

      this.proc.stdout?.on('data', (data: Buffer) => {
        const lines = (this.stdoutRest + data.toString()).split(/\r?\n/);
        this.stdoutRest = lines.pop() ?? '';
        for (const line of lines) this.handleLine(line);
      });

      this.proc.stderr?.on('data', (data: Buffer) => {
        this.stderrAccumulator.add(data.toString());
      });

      this.proc.on('close', (code) => {
        this.exited = true;
        this.stderrAccumulator.flush();
        this.textAccumulator.flush();
        if (this.stdoutRest) this.handleLine(this.stdoutRest);
        this.stdoutRest = '';

        for (const [, p] of this.pendingRpc) {
          clearTimeout(p.timer);
          p.reject(new Error(`Codex exited (${code})`));
        }
        this.pendingRpc.clear();

        if (!settled) {
          finish(false);
          return;
        }

        if (!this.stopped) {
          this.emitEvent({ kind: 'status', text: t('codex.exited', { code: String(code) }) });
          if (this.turnOpen) {
            this.finishTurn(true);
          }
        }
      });

      // Perform JSON-RPC 2.0 `initialize` -> `initialized` handshake
      this.sendRpcRequest('initialize', {
        clientInfo: { name: 'aurao', title: 'Aurao', version: '0.2.0' },
        capabilities: { experimentalAPI: true },
      }, 4000)
        .then(async () => {
          this.writeJson({ jsonrpc: '2.0', method: 'initialized', params: {} });
          if (this.threadId) {
            try {
              await this.sendRpcRequest('thread/resume', { threadId: this.threadId }, 4000);
            } catch {
              // If thread/resume is unsupported or thread doesn't exist in memory yet, turn/start or thread/start handles it
            }
          }
          finish(true);
        })
        .catch(() => {
          try {
            this.proc?.kill();
          } catch {
            // ignore
          }
          this.proc = null;
          finish(false);
        });
    });

    return this.handshakePromise;
  }

  private writeJson(payload: unknown): boolean {
    const stdin = this.proc?.stdin;
    if (!stdin || !stdin.writable) return false;
    stdin.write(JSON.stringify(payload) + '\n');
    return true;
  }

  private sendRpcRequest(method: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextRpcId++;
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      this.pendingRpc.set(id, { resolve, reject, timer });
      if (!this.writeJson({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer);
        this.pendingRpc.delete(id);
        reject(new Error(t('codex.notRunning')));
      }
    });
  }

  /** Feed a raw JSONL line from either `codex app-server` or `codex exec --json`. Public for unit testing. */
  public handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const clean = this.opts.sanitizeLogs !== false ? stripAnsi(trimmed) : trimmed;
      this.emitEvent({ kind: 'terminal', line: clean, level: 'info' });
      return;
    }

    // 1. JSON-RPC 2.0 response to a client request
    if (typeof parsed.id === 'number' && ('result' in parsed || 'error' in parsed) && !parsed.method) {
      const pending = this.pendingRpc.get(parsed.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRpc.delete(parsed.id);
        if (parsed.error) {
          pending.reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
        } else {
          pending.resolve(parsed.result);
        }
      }
      return;
    }

    // 2. JSON-RPC 2.0 server-initiated request (e.g., mid-turn tool approval)
    if (parsed.id !== undefined && typeof parsed.method === 'string') {
      this.handleServerRequest(parsed.id, parsed.method, (parsed.params || {}) as Record<string, any>);
      return;
    }

    // 3. JSON-RPC 2.0 notification (`codex app-server`)
    if (typeof parsed.method === 'string') {
      this.handleAppServerNotification(parsed.method, (parsed.params || {}) as Record<string, any>);
      return;
    }

    // 4. `codex exec --json` JSONL event (`{"type": "thread.started" | "turn.started" | "item.*" | "turn.completed"}`)
    if (typeof parsed.type === 'string') {
      this.handleExecJsonEvent(parsed);
      return;
    }
  }

  private handleServerRequest(rpcId: number | string, method: string, params: Record<string, any>): void {
    const isCommandApproval =
      method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval' || method === 'approval/request';
    const isFileApproval = method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval';

    if (!isCommandApproval && !isFileApproval) {
      this.writeJson({ jsonrpc: '2.0', id: rpcId, result: { decision: 'accept' } });
      return;
    }

    const cmd = formatCommand(params.command || params.argv || params.description || '');
    const filePath = String(params.filePath || params.path || (params.changes ? Object.keys(params.changes).join(', ') : '') || '');
    const toolName = isCommandApproval ? 'Bash' : 'Edit';
    const toolKey = isCommandApproval ? `Bash:${cmd}` : `Edit:${filePath}`;
    const input: Record<string, unknown> = isCommandApproval
      ? { command: cmd, cwd: params.cwd || this.opts.cwd, description: params.reason }
      : { file_path: filePath, old_string: '', new_string: params.patch || JSON.stringify(params.changes || {}) };

    const replyRpc = (allow: boolean, always: boolean) => {
      const decision = allow ? (always ? 'acceptForSession' : 'accept') : 'decline';
      this.writeJson({ jsonrpc: '2.0', id: rpcId, result: { decision, approved: allow } });
    };

    if (this.approvalMode === 'bypass' || this.alwaysAllowedTools.has(toolName) || this.alwaysAllowedTools.has(toolKey)) {
      replyRpc(true, false);
      return;
    }

    if (this.approvalMode === 'safe' && isCommandApproval && isReadOnlyCommand(cmd)) {
      replyRpc(true, false);
      return;
    }

    this.textAccumulator.flush();
    const requestId = `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const { summary, detail } = describeTool(toolName, input);

    this.pendingApprovals.set(requestId, {
      rpcId,
      toolKey,
      onDecision: (allow, always) => replyRpc(allow, always),
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

  private handleAppServerNotification(method: string, params: Record<string, any>): void {
    switch (method) {
      case 'thread/started': {
        const tid = params.thread?.id || params.threadId;
        if (tid) this.threadId = String(tid);
        break;
      }
      case 'turn/started': {
        const turnId = params.turn?.id || params.turnId;
        if (turnId) this.activeTurnId = String(turnId);
        this.beginTurnIfNeeded();
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = typeof params.delta === 'string' ? params.delta : (params.text ?? '');
        if (delta) {
          this.beginTurnIfNeeded();
          this.textAccumulator.add(delta);
        }
        break;
      }
      case 'item/started': {
        const item = params.item || params;
        this.handleItemStarted(item);
        break;
      }
      case 'item/completed': {
        const item = params.item || params;
        this.handleItemCompleted(item);
        break;
      }
      case 'turn/completed': {
        const isError = params.turn?.status === 'failed' || params.status === 'failed' || Boolean(params.error);
        if (params.error?.message || params.turn?.error?.message) {
          this.emitEvent({ kind: 'error', text: String(params.error?.message || params.turn?.error?.message) });
        }
        this.finishTurn(isError);
        break;
      }
      case 'error': {
        const msg = params.message || params.error?.message || JSON.stringify(params);
        this.emitEvent({ kind: 'error', text: String(msg) });
        break;
      }
    }
  }

  private handleExecJsonEvent(ev: Record<string, any>): void {
    switch (ev.type) {
      case 'thread.started': {
        if (ev.thread_id) this.threadId = String(ev.thread_id);
        break;
      }
      case 'turn.started': {
        this.beginTurnIfNeeded();
        break;
      }
      case 'item.started': {
        if (ev.item) this.handleItemStarted(ev.item);
        break;
      }
      case 'item.updated': {
        if (ev.item) this.handleItemUpdated(ev.item);
        break;
      }
      case 'item.completed': {
        if (ev.item) this.handleItemCompleted(ev.item);
        break;
      }
      case 'turn.completed': {
        this.finishTurn(false);
        break;
      }
      case 'turn.failed':
      case 'error': {
        const errText = ev.error?.message || ev.message || t('engine.failed');
        this.emitEvent({ kind: 'error', text: String(errText) });
        this.finishTurn(true);
        break;
      }
    }
  }

  private beginTurnIfNeeded(): void {
    if (!this.turnOpen) {
      this.turnOpen = true;
      this.turnStartMs = Date.now();
      this.stepCount = 0;
      this.emitEvent({ kind: 'turn_start' });
    }
  }

  private mapCodexItemToTool(item: Record<string, any>): { name: string; input: Record<string, unknown> } | null {
    const rawType = String(item.type || '');
    if (rawType === 'command_execution' || rawType === 'commandExecution') {
      const cmd = formatCommand(item.command || item.argv || '');
      return { name: 'Bash', input: { command: cmd } };
    }
    if (rawType === 'file_change' || rawType === 'fileChange') {
      const changes = Array.isArray(item.changes)
        ? item.changes.map((c: any) => c.path || c.file_path).filter(Boolean).join(', ')
        : String(item.path || item.file_path || 'file');
      return { name: 'Edit', input: { file_path: changes } };
    }
    if (rawType === 'mcp_tool_call' || rawType === 'mcpToolCall') {
      const toolName = String(item.tool || item.tool_name || item.name || 'MCP');
      return { name: toolName, input: (item.arguments || item.input || {}) as Record<string, unknown> };
    }
    if (rawType === 'web_search' || rawType === 'webSearch') {
      return { name: 'WebSearch', input: { query: String(item.query || '') } };
    }
    return null;
  }

  private handleItemStarted(item: Record<string, any>): void {
    this.beginTurnIfNeeded();
    const id = String(item.id || `item-${++this.stepCount}`);
    const rawType = String(item.type || '');

    if (rawType === 'reasoning') {
      if (item.text) {
        this.emitEvent({ kind: 'terminal', line: `💭 ${String(item.text).replace(/\s+/g, ' ').slice(0, 140)}`, level: 'thinking' });
      }
      return;
    }

    const mapped = this.mapCodexItemToTool(item);
    if (mapped && !this.activeTools.has(id)) {
      this.textAccumulator.flush();
      if (this.textStarted) {
        this.emitEvent({ kind: 'text_done' });
        if (this.responseText.trim()) {
          for (const tl of assistantTerminalLines(this.responseText)) this.emitEvent(tl);
        }
        this.responseText = '';
        this.textStarted = false;
      }
      this.activeTools.add(id);
      this.stepCount++;
      const { summary } = describeTool(mapped.name, mapped.input);
      this.emitEvent({ kind: 'terminal', line: `▶ ${mapped.name}  ${summary}`, level: 'tool' });
      this.emitEvent({ kind: 'tool_use', id, name: mapped.name, summary, input: mapped.input });
    }
  }

  private handleItemUpdated(item: Record<string, any>): void {
    const id = String(item.id || 'msg');
    const rawType = String(item.type || '');
    if ((rawType === 'agent_message' || rawType === 'agentMessage') && typeof item.text === 'string') {
      const prev = this.lastItemTextById.get(id) || '';
      if (item.text.startsWith(prev)) {
        const delta = item.text.slice(prev.length);
        if (delta) this.textAccumulator.add(delta);
      } else {
        this.textAccumulator.add(item.text);
      }
      this.lastItemTextById.set(id, item.text);
    }
  }

  private handleItemCompleted(item: Record<string, any>): void {
    this.beginTurnIfNeeded();
    const id = String(item.id || `item-${this.stepCount || 1}`);
    const rawType = String(item.type || '');

    if (rawType === 'agent_message' || rawType === 'agentMessage') {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) {
        const prev = this.lastItemTextById.get(id) || '';
        // If deltas were not already streamed via item/agentMessage/delta or item.updated, emit now
        if (!this.textStarted && !this.responseText && !prev) {
          this.textAccumulator.add(text);
        } else if (prev && text.startsWith(prev) && text.length > prev.length) {
          this.textAccumulator.add(text.slice(prev.length));
        }
      }
      this.lastItemTextById.delete(id);
      this.textAccumulator.flush();
      if (this.textStarted) {
        this.emitEvent({ kind: 'text_done' });
        if (this.responseText.trim()) {
          for (const tl of assistantTerminalLines(this.responseText)) this.emitEvent(tl);
        }
        this.responseText = '';
        this.textStarted = false;
      }
      return;
    }

    const mapped = this.mapCodexItemToTool(item);
    if (mapped) {
      if (!this.activeTools.has(id)) {
        this.handleItemStarted(item);
      }
      this.activeTools.delete(id);
      const exitCode = item.exit_code ?? item.exitCode;
      const isError = item.status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0);
      const summary = isError
        ? String(item.error?.message || (exitCode !== undefined ? `Exit ${exitCode}` : t('engine.toolError')))
        : t('engine.toolOk');
      this.emitEvent({ kind: 'terminal', line: `${isError ? '✗' : '✓'} ${summary}`, level: isError ? 'stderr' : 'tool' });
      this.emitEvent({ kind: 'tool_result', id, summary, isError });
    }
  }

  private finishTurn(isError: boolean): void {
    this.textAccumulator.flush();
    if (this.textStarted) {
      this.emitEvent({ kind: 'text_done' });
      if (this.responseText.trim()) {
        for (const tl of assistantTerminalLines(this.responseText)) this.emitEvent(tl);
      }
      this.responseText = '';
      this.textStarted = false;
    }
    this.activeTools.clear();
    this.lastItemTextById.clear();

    if (!this.turnOpen && !isError) return;
    const durationMs = this.turnStartMs ? Math.max(0, Date.now() - this.turnStartMs) : 0;
    const numTurns = Math.max(1, this.stepCount || 1);
    this.turnOpen = false;
    this.activeTurnId = null;

    this.emitEvent({
      kind: 'terminal',
      line: t('engine.resultLine', {
        status: isError ? t('engine.failed') : t('engine.done'),
        s: (durationMs / 1000).toFixed(1),
        n: numTurns,
      }),
      level: 'result',
    });
    this.emitEvent({ kind: 'result', costUsd: 0, durationMs, numTurns, isError });
  }

  send(text: string): void {
    this.emitEvent({ kind: 'terminal', line: `> ${text.replace(/\s+/g, ' ').slice(0, 200)}`, level: 'info' });
    this.beginTurnIfNeeded();

    if (this.execFallbackMode) {
      if (this.approvalMode === 'ask' && !this.alwaysAllowedTools.has('CodexTurn')) {
        const requestId = `codex-${Date.now().toString(36)}`;
        this.pendingApprovals.set(requestId, {
          toolKey: 'CodexTurn',
          onDecision: (allow, always) => {
            if (always && allow) this.alwaysAllowedTools.add('CodexTurn');
            if (allow) this.runExecTurn(text);
            else this.finishTurn(true);
          },
        });
        this.emitEvent({
          kind: 'permission_request',
          requestId,
          toolName: 'Bash',
          summary: text.slice(0, 100),
          detail: text,
          input: { command: text },
          canAlways: true,
        });
        return;
      }
      this.runExecTurn(text);
      return;
    }

    void this.dispatchAppServerTurn(text);
  }

  private getCodexSecurityParams(): { approvalPolicy: string; sandbox: string } {
    if (this.approvalMode === 'bypass') {
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    }
    if (this.approvalMode === 'ask') {
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    }
    return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  }

  private async dispatchAppServerTurn(text: string): Promise<void> {
    try {
      if (this.handshakePromise) await this.handshakePromise;
      const { approvalPolicy, sandbox } = this.getCodexSecurityParams();

      if (!this.threadId) {
        const res = await this.sendRpcRequest('thread/start', {
          cwd: this.opts.cwd,
          model: this.currentModel || undefined,
          ephemeral: false,
          approvalPolicy,
          sandbox,
          developerInstructions: this.opts.systemPromptAppend || undefined,
        });
        const tid = res?.thread?.id || res?.threadId;
        if (tid) this.threadId = String(tid);
      }

      const turnRes = await this.sendRpcRequest('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
        model: this.currentModel || undefined,
        effort: this.opts.effort || undefined,
        approvalPolicy,
        sandbox,
      });
      const turnId = turnRes?.turn?.id || turnRes?.turnId;
      if (turnId) this.activeTurnId = String(turnId);
    } catch (err) {
      this.emitEvent({ kind: 'error', text: String(err instanceof Error ? err.message : err) });
      this.finishTurn(true);
    }
  }

  private runExecTurn(text: string): void {
    const bin = resolveCodexBinary();
    if (!bin) {
      this.emitEvent({ kind: 'error', text: t('codex.notFound') });
      this.finishTurn(true);
      return;
    }

    const args: string[] = ['exec'];
    if (this.threadId && SAFE_ARG.test(this.threadId)) {
      args.push('resume', this.threadId);
    }
    args.push('--json');
    if (this.currentModel && SAFE_ARG.test(this.currentModel)) {
      args.push('--model', this.currentModel);
    }
    if (this.approvalMode === 'bypass') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--full-auto');
    }
    if (this.opts.effort && SAFE_ARG.test(this.opts.effort)) {
      args.push('-c', `model_reasoning_effort="${this.opts.effort}"`);
    }
    // Read prompt from stdin ('-') so arbitrary characters/newlines never break Windows cmd quoting
    args.push('-');

    const promptPayload =
      !this.threadId && this.opts.systemPromptAppend ? `${this.opts.systemPromptAppend}\n\n${text}` : text;

    try {
      this.proc = bin.isCmdShim
        ? spawn(`"${bin.exe}" ${args.join(' ')}`, { cwd: this.opts.cwd, shell: true, windowsHide: true })
        : spawn(bin.exe, args, { cwd: this.opts.cwd, windowsHide: true });
    } catch (err) {
      this.emitEvent({ kind: 'error', text: t('codex.startFailed', { e: String(err) }) });
      this.finishTurn(true);
      return;
    }

    this.proc.stdout?.on('data', (data: Buffer) => {
      const lines = (this.stdoutRest + data.toString()).split(/\r?\n/);
      this.stdoutRest = lines.pop() ?? '';
      for (const line of lines) this.handleLine(line);
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      this.stderrAccumulator.add(data.toString());
    });

    this.proc.on('error', (err) => {
      this.emitEvent({ kind: 'error', text: t('codex.startFailed', { e: String(err) }) });
      this.finishTurn(true);
    });

    this.proc.on('close', (code) => {
      this.stderrAccumulator.flush();
      if (this.stdoutRest) this.handleLine(this.stdoutRest);
      this.stdoutRest = '';
      if (this.turnOpen) {
        this.finishTurn(code !== 0);
      }
    });

    this.proc.stdin?.write(promptPayload);
    this.proc.stdin?.end();
  }

  async interrupt(): Promise<void> {
    this.emitEvent({ kind: 'terminal', line: t('engine.interrupted'), level: 'info' });
    if (!this.execFallbackMode && this.threadId && this.isAlive()) {
      try {
        await this.sendRpcRequest(
          'turn/interrupt',
          { threadId: this.threadId, turnId: this.activeTurnId || undefined },
          2000,
        );
      } catch {
        // fallback to finishing the turn locally
      }
    } else if (this.execFallbackMode && this.proc) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
    }
    if (this.turnOpen) {
      this.finishTurn(true);
    }
  }

  answerPermission(requestId: string, allow: boolean, always: boolean): void {
    const pending = this.pendingApprovals.get(requestId);
    if (pending) {
      this.pendingApprovals.delete(requestId);
      if (always && allow && pending.toolKey) {
        this.alwaysAllowedTools.add(pending.toolKey);
      }
      pending.onDecision(allow, always);
    }
    this.emitEvent({ kind: 'permission_resolved', requestId, allowed: allow });
    this.emitEvent({
      kind: 'terminal',
      line: `${allow ? t('engine.allowed') : t('engine.denied')} (${requestId.slice(0, 8)})`,
      level: 'hook',
    });
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode;
    this.emitEvent({ kind: 'terminal', line: t('engine.approvalModeSwitched', { mode }), level: 'info' });
  }

  async listModels(): Promise<ModelChoice[]> {
    if (!this.cachedServerModels && !this.execFallbackMode && this.isAlive()) {
      try {
        const res = await this.sendRpcRequest('model/list', {}, 3000);
        const rawList = Array.isArray(res?.models) ? res.models : Array.isArray(res?.data) ? res.data : [];
        if (rawList.length > 0) {
          this.cachedServerModels = rawList
            .map((m: any) => ({
              value: String(m.id || m.model || m.value || ''),
              displayName: String(m.displayName || m.title || m.id || m.model || ''),
              description: m.description ? String(m.description) : undefined,
            }))
            .filter((m: ModelChoice) => Boolean(m.value));
        }
      } catch {
        // use curated defaults
      }
    }

    const base = this.cachedServerModels?.length ? [...this.cachedServerModels] : [...DEFAULT_CODEX_MODELS];
    const seen = new Set(base.map((m) => m.value));

    for (const custom of this.opts.availableModels ?? []) {
      if (custom && !seen.has(custom)) {
        seen.add(custom);
        base.push({ value: custom, displayName: custom });
      }
    }
    if (this.currentModel && !seen.has(this.currentModel)) {
      base.push({ value: this.currentModel, displayName: this.currentModel });
    }
    return base;
  }

  async setModel(model?: string): Promise<boolean> {
    this.currentModel = model || '';
    this.emitEvent({
      kind: 'terminal',
      line: t('engine.modelSwitched', { model: this.currentModel || t('engine.defaultModel') }),
      level: 'info',
    });
    // Both `turn/start` in app-server and `codex exec` accept per-turn model overrides live!
    return true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const [, p] of this.pendingRpc) {
      clearTimeout(p.timer);
      p.reject(new Error(t('engine.sessionEnded')));
    }
    this.pendingRpc.clear();
    for (const [, a] of this.pendingApprovals) {
      a.onDecision(false, false);
    }
    this.pendingApprovals.clear();
    this.textAccumulator.dispose();
    this.stderrAccumulator.dispose();
    try {
      this.proc?.kill();
    } catch {
      // ignore
    }
    this.proc = null;
    this.removeAllListeners();
  }
}
