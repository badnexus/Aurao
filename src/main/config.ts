// App configuration: where the agent workspace lives, what the Datei-Explorer shows, which persona.
// Dev: config.json next to package.json. Packaged app: the bundled config.json (read-only in app.asar) plus
// the user's own choices in %APPDATA%/<productName>/config.json (see USER_KEYS).
// Missing or invalid keys fall back to the defaults below.
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LANGUAGES, type Language } from './i18n';

export type Persona = 'standard' | 'soft';
export type EngineType = 'claude' | 'agy' | 'gpts';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export type ApprovalMode = 'ask' | 'safe' | 'bypass';
const APPROVAL_MODES: ApprovalMode[] = ['ask', 'safe', 'bypass'];

export interface PocConfig {
  /** The backend engine to use ('claude' for Claude SDK, 'agy' for Antigravity, 'gpts' for GPTS). */
  engineType: EngineType;
  /** Name of the agent displayed in the UI. Defaults to 'Assistant'. */
  agentName: string;
  /** Path to the workspace (CLAUDE.md, .claude/skills, project-map/, connectors/). */
  workspaceRepo: string;
  /** Optional git URL of the workspace: cloned into workspaceRepo on first start, fast-forwarded on every start. */
  workspaceGitUrl?: string;
  /** Folder shown in the Datei-Explorer when the app opens. */
  workspaceRoot: string;
  /**
   * Send "Hallo {agentName}" at start. Normally unnecessary: the workspace's SessionStart
   * hook already opens the session with the welcome menu. Turn on only if that hook is absent.
   */
  greetOnStart: boolean;
  /** 'standard' = the agent as in the CLI; 'soft' = fewer technical terms, shorter sentences. */
  persona: Persona;
  /** UI language. Omit to follow the OS language (German locale -> 'de', otherwise 'en'). Set by the DE|EN switch. */
  language?: Language;
  /** Approval mode ('ask' | 'safe' | 'bypass'). Defaults to 'safe'. */
  approvalMode?: ApprovalMode;
  /** Optional model override (alias or full id). Omit to use the CLI default. Set by the model picker. */
  model?: string;
  /** Models offered in the picker for engines that cannot list them (agy, gpts). */
  availableModels?: string[];
  /**
   * Tool rules allowed without an approval card, e.g. "Bash(python tools/report.py *)" (Claude engine).
   * Set by whoever ships the app, not by the workspace: a freshly cloned workspace is not trusted,
   * so the CLI ignores the allow list in its own .claude/settings.json. Workspace hooks still run
   * first, so a hook answering "ask" keeps its approval card.
   */
  allowedTools?: string[];
  /**
   * Optional reasoning effort (Claude engine): 'low' | 'medium' | 'high' | 'xhigh' | 'max'. With models that
   * think adaptively (Opus 4.6+), lower effort means less thinking on simple steps: faster and steadier
   * answers. Omit for the model's default. Models without effort support ignore it.
   */
  effort?: Effort;
  /** Optional path to a Claude Code executable; omit to use the one bundled with the SDK. */
  claudeExecutable?: string;
}

// dist/main/config.js -> ../.. = POC root (inside app.asar when packaged)
export const POC_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLED_CONFIG = path.join(POC_ROOT, 'config.json');
const CONFIG_PATH = app.isPackaged ? path.join(app.getPath('userData'), 'config.json') : BUNDLED_CONFIG;

const DEFAULTS: PocConfig = {
  engineType: 'claude',
  agentName: 'Assistant',
  workspaceRepo: path.join(app.getPath('home'), '.my-agent-skills'),
  workspaceRoot: app.isPackaged ? app.getPath('documents') : path.resolve(POC_ROOT, '..'),
  greetOnStart: false,
  persona: 'standard',
};

const ENGINE_TYPES: EngineType[] = ['claude', 'agy', 'gpts'];
const PERSONAS: Persona[] = ['standard', 'soft'];

function readJson(file: string): Partial<PocConfig> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Partial<PocConfig>) : null;
  } catch {
    return null;
  }
}

export const USER_KEYS = [
  'engineType',
  'agentName',
  'workspaceRepo',
  'workspaceGitUrl',
  'workspaceRoot',
  'greetOnStart',
  'persona',
  'language',
  'approvalMode',
  'model',
  'availableModels',
  'allowedTools',
  'effort',
  'claudeExecutable',
] as const;

function userOverrides(cfg: Partial<PocConfig>, bundled: Partial<PocConfig>): Partial<PocConfig> {
  const out: Record<string, unknown> = {};
  // Compare by content: lists (allowedTools, availableModels) are never `===` to the bundled ones, so they
  // were always saved and then froze the user on that release's list.
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const k of USER_KEYS) if (cfg[k] !== undefined && !same(cfg[k], bundled[k])) out[k] = cfg[k];
  return out as Partial<PocConfig>;
}

export function loadConfig(): PocConfig {
  const user = readJson(CONFIG_PATH);
  // Older versions saved the whole config; only the user's own choices are taken from it.
  const raw = app.isPackaged
    ? { ...(readJson(BUNDLED_CONFIG) ?? {}), ...(user ? userOverrides(user, {}) : {}) }
    : (user ?? {});
  // Handle migration from captainRepo to workspaceRepo for existing configs
  if ('captainRepo' in raw && !raw.workspaceRepo) {
    raw.workspaceRepo = (raw as { captainRepo?: string }).captainRepo;
  }
  // Legacy persona name
  if ((raw as { persona?: string }).persona === 'captain') raw.persona = 'standard';
  const cfg: PocConfig = { ...DEFAULTS, ...raw };
  if (!ENGINE_TYPES.includes(cfg.engineType)) cfg.engineType = DEFAULTS.engineType;
  if (!PERSONAS.includes(cfg.persona)) cfg.persona = DEFAULTS.persona;
  if (cfg.language !== undefined && !LANGUAGES.includes(cfg.language)) delete cfg.language;
  if (cfg.approvalMode !== undefined && !APPROVAL_MODES.includes(cfg.approvalMode)) delete cfg.approvalMode;
  if (typeof cfg.agentName !== 'string' || !cfg.agentName.trim()) cfg.agentName = DEFAULTS.agentName;
  if (typeof cfg.workspaceRepo !== 'string') cfg.workspaceRepo = DEFAULTS.workspaceRepo;
  if (typeof cfg.workspaceRoot !== 'string') cfg.workspaceRoot = DEFAULTS.workspaceRoot;
  if (typeof cfg.greetOnStart !== 'boolean') cfg.greetOnStart = DEFAULTS.greetOnStart;
  if (cfg.workspaceGitUrl !== undefined && (typeof cfg.workspaceGitUrl !== 'string' || !cfg.workspaceGitUrl.trim())) delete cfg.workspaceGitUrl;
  if (cfg.availableModels !== undefined && !Array.isArray(cfg.availableModels)) delete cfg.availableModels;
  if (cfg.effort !== undefined && !EFFORTS.includes(cfg.effort)) delete cfg.effort;
  if (cfg.allowedTools !== undefined && !(Array.isArray(cfg.allowedTools) && cfg.allowedTools.every((r) => typeof r === 'string'))) delete cfg.allowedTools;
  if (cfg.claudeExecutable !== undefined && (typeof cfg.claudeExecutable !== 'string' || !cfg.claudeExecutable.trim())) delete cfg.claudeExecutable;
  return cfg;
}

/** Returns false if the file could not be written (read-only location, locked file …). */
export function saveConfig(cfg: PocConfig): boolean {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    // A hand-edited file with a syntax error would be overwritten by defaults: keep a copy first.
    if (fs.existsSync(CONFIG_PATH) && readJson(CONFIG_PATH) === null) fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
    const data = app.isPackaged ? userOverrides(cfg, readJson(BUNDLED_CONFIG) ?? {}) : cfg;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** True if config.json exists but could not be parsed (defaults are used; a .bak copy is kept on save). */
export function configIsBroken(): boolean {
  return fs.existsSync(CONFIG_PATH) && readJson(CONFIG_PATH) === null;
}

export function configPath(): string {
  return CONFIG_PATH;
}
