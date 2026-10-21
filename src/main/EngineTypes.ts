import { t } from './i18n';
import type { ProfileEnv } from './engineProfiles';
import type { ApprovalMode } from './config';

export type TerminalLevel = 'info' | 'tool' | 'stderr' | 'hook' | 'result' | 'assistant' | 'thinking';

export type EngineEvent =
  | { kind: 'init'; model: string; version: string; permissionMode: string; skills: string[]; slashCommands: string[]; tools: string[] }
  /** Engine accepts messages; 'init' (model, skills) may only follow the first message. */
  | { kind: 'ready' }
  /** An active turn has started (autonomous workspace hook or user prompt). */
  | { kind: 'turn_start' }
  | { kind: 'text_start' }
  | { kind: 'text_delta'; text: string }
  | { kind: 'text_done' }
  | { kind: 'tool_use'; id: string; name: string; summary: string; input: unknown }
  | { kind: 'tool_result'; id: string; summary: string; isError: boolean }
  | { kind: 'permission_request'; requestId: string; toolName: string; summary: string; detail: string; input: Record<string, unknown>; canAlways: boolean }
  | { kind: 'permission_resolved'; requestId: string; allowed: boolean }
  | { kind: 'result'; costUsd: number; durationMs: number; numTurns: number; isError: boolean }
  | { kind: 'terminal'; line: string; level: TerminalLevel }
  | { kind: 'status'; text: string }
  | { kind: 'error'; text: string };

export interface EngineOptions {
  cwd: string;
  agentName?: string;
  systemPromptAppend?: string;
  model?: string;
  claudeExecutable?: string;
  /** Set only by the --dangerously-skip-permissions launch flag: no Freigabe-Karten at all. */
  skipPermissions?: boolean;
  /** True only when the app was started with --dangerously-skip-permissions (not when bypass was picked in the UI). */
  launchedWithSkipFlag?: boolean;
  /** Approval mode ('ask' | 'safe' | 'bypass'). Defaults to 'safe' unless skipPermissions is set. */
  approvalMode?: ApprovalMode;
  /** Models offered in the picker for engines that cannot list them themselves (agy, gpts). */
  availableModels?: string[];
  /** Reasoning effort (config.effort). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Tool rules allowed without an approval card (config.allowedTools). */
  allowedTools?: string[];
  /** UI language, passed to the workspace's hooks as TERMI_LANGUAGE. */
  language?: string;
  /** Resume an existing conversation/session by ID. */
  resumeConversationId?: string;
  /** Continue the most recent conversation automatically. */
  continueLatest?: boolean;
  /** Strip ANSI colour codes from the engine's stderr before it is shown in the Terminal view. */
  sanitizeLogs?: boolean;
  /** Extra environment for the engine process (the chosen engine profile), applied after process.env; null removes a variable. */
  env?: ProfileEnv;
  /** Name of the chosen engine profile, for the Terminal view. */
  envProfileName?: string;
}

export interface HistoricalMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  preview: string;
  lastModified: string;
  stepCount: number;
  workspace?: string;
  matchesCwd?: boolean;
  isCurrent?: boolean;
}

export interface ModelChoice {
  value: string;
  displayName: string;
  description?: string;
}

/** Mirror a block of assistant text into the Terminal view, one event per line. */
export function assistantTerminalLines(text: string, prefix = ''): EngineEvent[] {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  return lines.map((line, i) => ({ kind: 'terminal', line: `${prefix}${i === 0 ? '◀ ' : '  '}${line}`, level: 'assistant' }));
}

/** Plain-language one-liner + detail text for a tool call (deterministic, no model call). */
export function describeTool(toolName: string, input: Record<string, unknown>): { summary: string; detail: string } {
  const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
  switch (toolName) {
    case 'Bash':
    case 'run_command': {
      const cmd = s(input.CommandLine || input.command);
      const desc = s(input.toolSummary || input.description || input.toolAction);
      return { summary: desc || cmd.slice(0, 120), detail: cmd };
    }
    case 'Write':
    case 'write_to_file': {
      const content = s(input.CodeContent || input.content);
      const filePath = s(input.TargetFile || input.file_path);
      return { summary: t('tool.write', { path: filePath }), detail: content.length > 1200 ? content.slice(0, 1200) + '\n…' : content };
    }
    case 'Edit':
    case 'replace_file_content': {
      const filePath = s(input.TargetFile || input.file_path);
      const oldStr = s(input.TargetContent || input.old_string).slice(0, 600);
      const newStr = s(input.ReplacementContent || input.new_string).slice(0, 600);
      return { summary: t('tool.edit', { path: filePath }), detail: t('tool.editDetail', { old: oldStr, new: newStr }) };
    }
    case 'Read':
    case 'view_file': {
      const filePath = s(input.AbsolutePath || input.file_path);
      return { summary: t('tool.read', { path: filePath }), detail: filePath };
    }
    case 'Glob':
    case 'Grep':
      return { summary: t('tool.search', { pattern: s(input.pattern) }), detail: JSON.stringify(input, null, 2) };
    case 'WebFetch':
      return { summary: t('tool.webFetch', { url: s(input.url) }), detail: s(input.url) };
    case 'WebSearch':
      return { summary: t('tool.webSearch', { query: s(input.query) }), detail: s(input.query) };
    case 'Skill':
      return { summary: `Skill: ${s(input.skill)} ${s(input.args)}`.trim(), detail: JSON.stringify(input, null, 2) };
    case 'Agent':
    case 'Task':
      return { summary: t('tool.agent', { desc: s(input.description) }), detail: s(input.prompt).slice(0, 1200) };
    default: {
      const json = JSON.stringify(input);
      return { summary: json.length > 140 ? json.slice(0, 140) + '…' : json, detail: JSON.stringify(input, null, 2) };
    }
  }
}

export function summarizeToolResult(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join(' ');
  } else if (content !== undefined) text = JSON.stringify(content);
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 160 ? text.slice(0, 160) + '…' : text || t('tool.emptyResult');
}
