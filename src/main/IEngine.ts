import { EventEmitter } from 'node:events';
import type { EngineEvent, ModelChoice } from './EngineTypes';
import type { ApprovalMode } from './config';

export interface IEngine extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(text: string): void;
  interrupt(): Promise<void>;
  answerPermission(requestId: string, allow: boolean, always: boolean): void;
  /** Set approval mode live ('ask' | 'safe' | 'bypass'). */
  setApprovalMode?(mode: ApprovalMode): void;
  /** Models the user can pick from; the current one is reported by the 'init' event. */
  listModels(): Promise<ModelChoice[]>;
  /** Switch model. Returns true if done live, false if the caller must restart the engine. */
  setModel(model?: string): Promise<boolean>;

  /** False once the backend process has died; the caller then restarts the engine before sending. */
  isAlive?(): boolean;
  /** True if interrupt() can only be done by ending the session, so the caller must restart afterwards. */
  readonly restartOnInterrupt?: boolean;

  // EventEmitter methods
  on(eventName: 'event', listener: (ev: EngineEvent) => void): this;
  once(eventName: 'event', listener: (ev: EngineEvent) => void): this;
  emit(eventName: 'event', ev: EngineEvent): boolean;
}
