// The Claude engine: one long-lived Claude Agent SDK session over the agent workspace.
//
// Same engine as the CLI: CLAUDE.md, .claude/skills, hooks and settings are loaded from the
// workspace (settingSources default = user + project + local). The only differences to the
// terminal are the surfaces: permission prompts become Freigabe-Karten (canUseTool -> UI),
// and every message the SDK streams is turned into a small UI event for the chat and the
// Terminal-Sichtfenster.
import { EventEmitter } from 'node:events';
import type { EngineEvent, EngineOptions, ModelChoice } from './EngineTypes';
import type { IEngine } from './IEngine';
import { assistantTerminalLines, describeTool, summarizeToolResult } from './EngineTypes';
import type { ApprovalMode } from './config';
import { t } from './i18n';
import { StreamAccumulator } from './StreamAccumulator';
import { sanitizeForLlm } from './LogSanitizer';
import type {
  CanUseTool,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };

/** Push-based async iterable: the SDK pulls user messages from it as they arrive. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(m: SDKUserMessage): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.items.push(m);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters) w({ value: undefined as unknown as SDKUserMessage, done: true });
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

interface PendingPermission {
  resolve: (r: PermissionResult) => void;
  suggestions?: PermissionUpdate[];
}

export class ClaudeEngine extends EventEmitter implements IEngine {
  private queue = new MessageQueue();
  private query: Query | null = null;
  private pending = new Map<string, PendingPermission>();
  private streamedMessageIds = new Set<string>();
  private blockTypes = new Map<number, string>();
  /** Text of the block being streamed, mirrored to the Terminal view when the block ends. */
  private streamedText = '';
  private stopped = false;
  private turnActive = false;
  private approvalMode: ApprovalMode = 'safe';

  private stderrAccumulator = new StreamAccumulator((chunk) => {
    this.emitEvent({ kind: 'terminal_chunk', chunk, level: 'stderr' });
    for (const line of chunk.split(/\r?\n/).filter((l) => l.trim())) {
      this.emitEvent({ kind: 'terminal', line, level: 'stderr' });
    }
  }, 60);

  constructor(private readonly opts: EngineOptions) {
    super();
    this.approvalMode = opts.approvalMode ?? (opts.skipPermissions ? 'bypass' : 'safe');
  }

  emitEvent(ev: EngineEvent): void {
    if (this.stopped) return; // a replaced session must not write into the new one's UI
    this.emit('event', ev);
  }

  async start(): Promise<void> {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const options: Options = {
      cwd: this.opts.cwd,
      permissionMode: 'default',
      canUseTool: this.canUseTool,
      allowDangerouslySkipPermissions: true,
      ...(this.opts.allowedTools?.length ? { allowedTools: this.opts.allowedTools } : {}),
      includePartialMessages: true,
      // Lets the workspace's hooks (e.g. a SessionStart welcome) adapt to this surface:
      // TERMI_SURFACE says chat UI with skill buttons instead of a terminal, TERMI_LANGUAGE the UI language.
      env: { ...process.env, TERMI_SURFACE: 'termi', TERMI_LANGUAGE: this.opts.language ?? 'en' },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.opts.systemPromptAppend },
      stderr: (data: string) => {
        this.stderrAccumulator.add(data);
      },
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.effort ? { effort: this.opts.effort } : {}),
      ...(this.opts.claudeExecutable ? { pathToClaudeCodeExecutable: this.opts.claudeExecutable } : {}),
      ...(this.opts.resumeConversationId ? { resume: this.opts.resumeConversationId } : {}),
      ...(this.opts.continueLatest ? { continue: true } : {}),
    };
    this.emitEvent({ kind: 'terminal', line: t('engine.starting', { agent: this.opts.agentName || 'Agent', cwd: this.opts.cwd }), level: 'info' });
    if (this.approvalMode === 'bypass') this.emitEvent({ kind: 'terminal', line: t(this.opts.launchedWithSkipFlag ? 'engine.skipWarning' : 'engine.bypassWarning'), level: 'stderr' });
    this.query = sdk.query({ prompt: this.queue, options });
    void this.consume(this.query);
    // The CLI sends its 'init' message only with the first answer, so the UI would wait forever
    // for it before letting the user type. The control handshake completes without a prompt.
    this.query
      .initializationResult()
      .then(() => this.emitEvent({ kind: 'ready' }))
      .catch((e) => this.emitEvent({ kind: 'error', text: t(/auth|login|credential|api key|ENOENT/i.test(String(e)) ? 'engine.claudeAuth' : 'engine.startFailed', { e: String(e) }) }));
  }

  send(text: string): void {
    this.turnActive = true;
    this.emitEvent({ kind: 'terminal', line: `> ${text.replace(/\s+/g, ' ').slice(0, 200)}`, level: 'info' });
    const sanitized = sanitizeForLlm(text, this.opts.sanitizeLogs !== false);
    this.queue.push({ type: 'user', message: { role: 'user', content: sanitized }, parent_tool_use_id: null });
  }

  async interrupt(): Promise<void> {
    if (!this.query) return;
    try {
      await this.query.interrupt();
      this.emitEvent({ kind: 'terminal', line: t('engine.interrupted'), level: 'info' });
    } catch (e) {
      this.emitEvent({ kind: 'error', text: t('engine.interruptFailed', { e: String(e) }) });
    }
  }

  answerPermission(requestId: string, allow: boolean, always: boolean): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (allow) {
      p.resolve({
        behavior: 'allow',
        ...(always && p.suggestions ? { updatedPermissions: p.suggestions } : {}),
      });
    } else {
      p.resolve({ behavior: 'deny', message: t('engine.deniedByUser') });
    }
    this.emitEvent({ kind: 'permission_resolved', requestId, allowed: allow });
    this.emitEvent({ kind: 'terminal', line: `${allow ? t('engine.allowed') : t('engine.denied')} (${requestId.slice(0, 8)})`, level: 'hook' });
  }

  async listModels(): Promise<ModelChoice[]> {
    if (!this.query) return [];
    const models = await this.query.supportedModels();
    return models.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description }));
  }

  async setModel(model?: string): Promise<boolean> {
    if (!this.query) return false;
    await this.query.setModel(model);
    this.emitEvent({ kind: 'terminal', line: t('engine.modelSwitched', { model: model || t('engine.defaultModel') }), level: 'info' });
    return true;
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode;
    this.emitEvent({ kind: 'terminal', line: t('engine.approvalModeSwitched', { mode }), level: 'info' });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: t('engine.sessionEnded') });
      this.pending.delete(id);
    }
    this.queue.close();
    this.stderrAccumulator.dispose();
    try {
      await this.query?.interrupt();
    } catch {
      // already gone
    }
    this.removeAllListeners();
  }

  // --- permission callback -> Freigabe-Karte --------------------------------------------

  private isReadOnlyTool(toolName: string): boolean {
    const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'View', 'FileRead', 'view_file', 'read_url_content', 'search_web', 'list_directory']);
    return READ_ONLY.has(toolName);
  }

  private canUseTool: CanUseTool = (toolName, input, options) => {
    if (this.approvalMode === 'bypass') {
      return Promise.resolve({ behavior: 'allow' });
    }
    if (this.approvalMode === 'safe' && this.isReadOnlyTool(toolName)) {
      return Promise.resolve({ behavior: 'allow' });
    }
    const requestId = options.toolUseID;
    const { summary, detail } = describeTool(toolName, input);
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, suggestions: options.suggestions });
      options.signal.addEventListener('abort', () => {
        if (this.pending.delete(requestId)) {
          resolve({ behavior: 'deny', message: t('engine.aborted') });
          this.emitEvent({ kind: 'permission_resolved', requestId, allowed: false });
        }
      });
      this.emitEvent({ kind: 'terminal', line: t('engine.approvalAsk', { tool: toolName, summary }), level: 'hook' });
      this.emitEvent({
        kind: 'permission_request',
        requestId,
        toolName,
        summary,
        detail,
        input,
        canAlways: Boolean(options.suggestions && options.suggestions.length > 0),
      });
    });
  };

  // --- SDK message stream -> UI events -------------------------------------------------

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.handle(msg);
      if (!this.stopped) this.emitEvent({ kind: 'status', text: t('engine.sessionEnded') });
    } catch (e) {
      if (!this.stopped) this.emitEvent({ kind: 'error', text: t('engine.error', { e: String(e) }) });
    }
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          this.emitEvent({
            kind: 'init',
            model: msg.model,
            version: msg.claude_code_version,
            permissionMode: msg.permissionMode,
            skills: msg.skills ?? [],
            slashCommands: msg.slash_commands ?? [],
            tools: msg.tools ?? [],
          });
          this.emitEvent({
            kind: 'terminal',
            line: t('engine.readyClaude', { version: msg.claude_code_version, model: msg.model, mode: msg.permissionMode, n: msg.skills?.length ?? 0 }),
            level: 'info',
          });
          if (!this.turnActive) {
            this.turnActive = true;
            this.emitEvent({ kind: 'turn_start' });
          }
        } else if ((msg as { subtype?: string }).subtype !== 'thinking_tokens') {
          // thinking_tokens arrives hundreds of times per answer; '… denkt nach' already covers it.
          this.emitEvent({ kind: 'terminal', line: `system/${(msg as { subtype?: string }).subtype ?? '?'}`, level: 'info' });
        }
        return;
      }
      case 'stream_event': {
        if (msg.parent_tool_use_id) return; // subagent text is mirrored from the 'assistant' message
        const ev = msg.event as { type: string; index?: number; message?: { id: string }; content_block?: { type: string }; delta?: { type: string; text?: string } };
        if (ev.type === 'message_start' && ev.message) {
          this.streamedMessageIds.add(ev.message.id);
          this.blockTypes.clear();
        } else if (ev.type === 'content_block_start' && ev.content_block && ev.index !== undefined) {
          this.blockTypes.set(ev.index, ev.content_block.type);
          if (ev.content_block.type === 'text') {
            this.streamedText = '';
            this.emitEvent({ kind: 'text_start' });
          } else if (ev.content_block.type === 'thinking' || ev.content_block.type === 'redacted_thinking') {
            this.emitEvent({ kind: 'terminal', line: t('engine.thinking'), level: 'thinking' });
          }
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          this.streamedText += ev.delta.text;
          this.emitEvent({ kind: 'text_delta', text: ev.delta.text });
        } else if (ev.type === 'content_block_stop' && ev.index !== undefined) {
          if (this.blockTypes.get(ev.index) === 'text') {
            this.emitEvent({ kind: 'text_done' });
            if (this.streamedText.trim()) for (const t of assistantTerminalLines(this.streamedText)) this.emitEvent(t);
            this.streamedText = '';
          }
        }
        return;
      }
      case 'assistant': {
        const content = (msg.message.content ?? []) as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
        const streamed = this.streamedMessageIds.has(msg.message.id);
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            if (msg.parent_tool_use_id) {
              for (const t of assistantTerminalLines(block.text, '  ↳ ')) this.emitEvent(t);
              continue;
            }
            if (!streamed) {
              this.emitEvent({ kind: 'text_start' });
              this.emitEvent({ kind: 'text_delta', text: block.text });
              this.emitEvent({ kind: 'text_done' });
              for (const t of assistantTerminalLines(block.text)) this.emitEvent(t);
            }
          } else if (block.type === 'tool_use' && block.id && block.name) {
            const input = (block.input ?? {}) as Record<string, unknown>;
            const { summary } = describeTool(block.name, input);
            const prefix = msg.parent_tool_use_id ? '  ↳ ' : '';
            this.emitEvent({ kind: 'terminal', line: `${prefix}▶ ${block.name}  ${summary}`, level: 'tool' });
            if (!msg.parent_tool_use_id) this.emitEvent({ kind: 'tool_use', id: block.id, name: block.name, summary, input });
          }
        }
        return;
      }
      case 'user': {
        const content = msg.message.content;
        if (!Array.isArray(content)) return; // our own prompt echoed back
        for (const block of content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const summary = summarizeToolResult(block.content);
          const prefix = msg.parent_tool_use_id ? '  ↳ ' : '';
          this.emitEvent({ kind: 'terminal', line: `${prefix}${block.is_error ? '✗' : '✓'} ${summary}`, level: block.is_error ? 'stderr' : 'tool' });
          if (!msg.parent_tool_use_id) this.emitEvent({ kind: 'tool_result', id: block.tool_use_id, summary, isError: Boolean(block.is_error) });
        }
        return;
      }
      case 'result': {
        this.turnActive = false;
        const isError = msg.subtype !== 'success';
        this.emitEvent({ kind: 'result', costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, numTurns: msg.num_turns, isError });
        this.emitEvent({
          kind: 'terminal',
          line:
            t('engine.resultLine', { status: isError ? '✗ ' + msg.subtype : t('engine.done'), s: (msg.duration_ms / 1000).toFixed(1), n: msg.num_turns }) +
            t('engine.costSuffix', { cost: msg.total_cost_usd.toFixed(3) }),
          level: 'result',
        });
        return;
      }
      case 'tool_progress': {
        if (msg.heartbeat) return;
        this.emitEvent({ kind: 'terminal', line: t('engine.toolRunning', { tool: msg.tool_name, s: Math.round(msg.elapsed_time_seconds) }), level: 'tool' });
        return;
      }
      default: {
        // Everything else (hooks, status, tasks, compaction …) is shown compactly in the Terminal.
        const m = msg as { type: string; subtype?: string; status?: string; hook_name?: string };
        const extra = [m.subtype, m.status, m.hook_name].filter(Boolean).join(' ');
        this.emitEvent({ kind: 'terminal', line: `${m.type}${extra ? ' ' + extra : ''}`, level: m.type.startsWith('hook') ? 'hook' : 'info' });
      }
    }
  }
}

