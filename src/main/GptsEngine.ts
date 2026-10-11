import { EventEmitter } from 'node:events';
import type { IEngine } from './IEngine';
import type { EngineEvent, EngineOptions, ModelChoice } from './EngineTypes';
import { t } from './i18n';

export class GptsEngine extends EventEmitter implements IEngine {
  private stopped = false;

  constructor(private readonly opts: EngineOptions) {
    super();
  }

  emitEvent(ev: EngineEvent): void {
    if (this.stopped) return;
    this.emit('event', ev);
  }

  async start(): Promise<void> {
    this.emitEvent({ kind: 'terminal', line: t('engine.starting', { agent: this.opts.agentName || 'Gpts', cwd: this.opts.cwd }), level: 'info' });
    
    // Fake init immediately to unlock the UI
    this.emitEvent({ kind: 'ready' });
    this.emitEvent({
      kind: 'init',
      model: this.opts.model || 'gpts-default',
      version: 'gpts-cli',
      permissionMode: 'auto',
      skills: [],
      slashCommands: [],
      tools: [],
    });
    
    this.emitEvent({ kind: 'terminal', line: t('gpts.notImplemented'), level: 'stderr' });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.removeAllListeners();
  }

  send(text: string): void {
    this.emitEvent({ kind: 'terminal', line: `> ${text}`, level: 'info' });
    this.emitEvent({ kind: 'error', text: t('gpts.placeholder') });
  }

  async interrupt(): Promise<void> {
    // Stub
  }

  answerPermission(requestId: string, allow: boolean, always: boolean): void {
    this.emitEvent({ kind: 'permission_resolved', requestId, allowed: allow });
  }

  async listModels(): Promise<ModelChoice[]> {
    const models = new Set(this.opts.availableModels ?? []);
    if (this.opts.model) models.add(this.opts.model);
    return [...models].map((m) => ({ value: m, displayName: m }));
  }

  async setModel(): Promise<boolean> {
    return false;
  }
}
