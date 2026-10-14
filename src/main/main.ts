// Electron main process: one window, one agent engine, a thin IPC layer in between.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig, saveConfig, configIsBroken, configPath, POC_ROOT, type PocConfig, type Persona, type ApprovalMode } from './config';
import type { EngineEvent } from './EngineTypes';
import type { IEngine } from './IEngine';
import { ClaudeEngine } from './ClaudeEngine';
import { AgyEngine, findOnPath } from './AgyEngine';
import { GptsEngine } from './GptsEngine';
import { listWorkspaceSkills } from './skills';
import { syncWorkspace } from './workspace';
import { listDir, statPath } from './files';
import { systemPromptAppend } from './persona';
import { detectLanguage, getLanguage, setLanguage, t, type Language } from './i18n';
import { listSessions, getSessionHistory } from './sessions';

let win: BrowserWindow | null = null;
let engine: IEngine | null = null;
let cfg: PocConfig = loadConfig();
let workspaceSynced = false;
let currentConversationId: string | null = null;

/** Only via the launch argument, never persisted: every session without it shows Freigabe-Karten. */
const SKIP_PERMISSIONS = process.argv.includes('--dangerously-skip-permissions');

function sendToUi(ev: EngineEvent): void {
  // Dev aid: TERMI_LOG=<file> appends every engine event, for runs without a human at the screen.
  const devLog = process.env.TERMI_LOG;
  if (devLog) fs.appendFileSync(devLog, `${new Date().toISOString()} ${JSON.stringify(ev)}\n`, 'utf8');
  if (win && !win.isDestroyed()) win.webContents.send('engine:event', ev);
}

function logToFile(text: string): void {
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'main.log'), `${new Date().toISOString()} ${text}\n`, 'utf8');
  } catch {
    // logging must never take the app down
  }
}

function reportError(text: string): void {
  logToFile(text);
  sendToUi({ kind: 'error', text });
}

process.on('uncaughtException', (e) => reportError(t('err.unexpected', { e: e?.stack ?? String(e) })));
process.on('unhandledRejection', (e) => reportError(t('err.unexpected', { e: e instanceof Error ? (e.stack ?? String(e)) : String(e) })));

function persist(): void {
  if (!saveConfig(cfg)) sendToUi({ kind: 'terminal', line: t('err.saveConfig', { path: configPath() }), level: 'stderr' });
}

/**
 * In the packaged app the SDK's native claude.exe lives in app.asar.unpacked (see build.asarUnpack):
 * a binary inside the asar archive cannot be executed.
 */
function bundledClaudeExecutable(): string | undefined {
  if (!app.isPackaged) return undefined;
  try {
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const dir = path.dirname(pkg).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    const exe = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    return fs.existsSync(exe) ? exe : undefined;
  } catch {
    return undefined;
  }
}

/** The configured workspace if it exists, otherwise the first existing fallback folder. */
function resolveCwd(): string {
  return [cfg.workspaceRepo, cfg.workspaceRoot, app.getPath('home')].find((p) => p && fs.existsSync(p)) ?? app.getPath('home');
}

function createEngine(): IEngine {
  const cwd = resolveCwd();
  const effectiveApprovalMode = cfg.approvalMode || (SKIP_PERMISSIONS ? 'bypass' : 'safe');
  const common = {
    cwd,
    model: cfg.model,
    agentName: cfg.agentName,
    skipPermissions: SKIP_PERMISSIONS || effectiveApprovalMode === 'bypass',
    launchedWithSkipFlag: SKIP_PERMISSIONS,
    approvalMode: effectiveApprovalMode,
    availableModels: cfg.availableModels,
    resumeConversationId: currentConversationId || undefined,
  };
  if (cfg.engineType === 'agy') return new AgyEngine(common);
  if (cfg.engineType === 'gpts') return new GptsEngine(common);
  return new ClaudeEngine({
    ...common,
    systemPromptAppend: systemPromptAppend(cfg.persona, getLanguage()),
    language: getLanguage(),
    allowedTools: cfg.allowedTools,
    effort: cfg.effort,
    claudeExecutable: cfg.claudeExecutable || bundledClaudeExecutable(),
  });
}

// Restarts are chained so two quick clicks (persona, model) can never run two engines at once.
let engineChain: Promise<void> = Promise.resolve();
function restartEngine(): Promise<void> {
  engineChain = engineChain.then(async () => {
    try {
      await startEngine();
    } catch (e) {
      reportError(t('err.engineStart', { e: String(e) }));
    }
  });
  return engineChain;
}

async function startEngine(): Promise<void> {
  const old = engine;
  engine = null;
  if (old) await old.stop();

  // Once per app start, not on every restart (persona or model switch).
  if (cfg.workspaceGitUrl && !workspaceSynced) {
    workspaceSynced = true;
    if (!fs.existsSync(cfg.workspaceRepo)) sendToUi({ kind: 'terminal', line: t('workspace.cloning', { url: cfg.workspaceGitUrl }), level: 'info' });
    const r = await syncWorkspace(cfg.workspaceGitUrl, cfg.workspaceRepo);
    if (r.ok) sendToUi({ kind: 'terminal', line: r.line, level: 'info' });
    else if (fs.existsSync(cfg.workspaceRepo)) sendToUi({ kind: 'terminal', line: r.text, level: 'stderr' });
    else reportError(r.text); // no workspace at all: the user has to see this
  }

  if (configIsBroken()) {
    sendToUi({ kind: 'terminal', line: t('err.configBroken', { path: configPath() }), level: 'stderr' });
  }
  if (!fs.existsSync(cfg.workspaceRepo)) {
    sendToUi({ kind: 'terminal', line: t('err.workspaceMissing', { repo: cfg.workspaceRepo, config: configPath(), cwd: resolveCwd() }), level: 'info' });
  }

  engine = createEngine();
  engine.on('event', sendToUi);
  const devSend = process.env.TERMI_SEND;
  if (devSend) {
    // "a || b || c": a once the engine is ready, each further message after the next finished
    // answer. Assumes the workspace greets on start, so the first answer is the greeting.
    const msgs = devSend.split('||').map((m) => m.trim()).filter(Boolean);
    const sendDev = (text: string) => {
      engine?.send(text);
      win?.webContents.send('ui:echoUser', text);
    };
    let results = 0;
    let started = false; // 'init' can arrive more than once per session
    const onDevEvent = (ev: EngineEvent) => {
      if (ev.kind === 'init' && !started && msgs.length) {
        started = true;
        sendDev(msgs[0]);
      }
      if (ev.kind === 'result' && ++results < msgs.length + 1 && results >= 2) sendDev(msgs[results - 1]);
    };
    engine.on('event', onDevEvent);
  }
  await engine.start();
  if (cfg.greetOnStart && !currentConversationId) engine.send(t('greeting', { agent: cfg.agentName }));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1536,
    height: 1024,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#0b1220',
    title: t('window.title', { agent: cfg.agentName }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // Links from the agent's answers (tickets, reports) open in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  void win.loadFile(path.join(POC_ROOT, 'src', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });

  // Dev aid for checking the UI without a human at the screen:
  //   TERMI_SCREENSHOT=<file.png>           capture the chat after TERMI_SCREENSHOT_DELAY ms
  //   TERMI_SCREENSHOT_TERMINAL=<file.png>  then switch to the Terminal view and capture again
  //   TERMI_SEND=<text>                     send one message once the engine is ready
  //   TERMI_AUTOQUIT=1                      quit afterwards (pending Freigabe-Karten stay unanswered,
  //                                               so nothing is ever executed by this mode)
  const shot = process.env.TERMI_SCREENSHOT;
  if (shot) {
    const delay = Number(process.env.TERMI_SCREENSHOT_DELAY ?? '15000');
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win?.webContents.capturePage();
          if (img) fs.writeFileSync(shot, img.toPNG());
          const termShot = process.env.TERMI_SCREENSHOT_TERMINAL;
          if (termShot && win) {
            win.webContents.send('ui:showView', 'terminal');
            await sleep(800);
            const img2 = await win.webContents.capturePage();
            fs.writeFileSync(termShot, img2.toPNG());
          }
        } finally {
          if (process.env.TERMI_AUTOQUIT) app.quit();
        }
      }, delay);
    });
  }
}

function checkAgyHealth(): { ok: boolean; path?: string; message: string; tip?: string } {
  const exe = findOnPath('agy');
  if (exe) {
    return { ok: true, path: exe, message: `Google Antigravity CLI gefunden: ${exe}` };
  }
  return {
    ok: false,
    message: 'agy wurde nicht im PATH gefunden.',
    tip: 'Bitte installiere die Google Antigravity CLI im Terminal per "npm install -g antigravity-cli" oder füge ihren Pfad zum Windows-PATH hinzu.',
  };
}

function checkClaudeHealth(): { ok: boolean; provider: string; message: string; tip?: string } {
  // 1. Microsoft Foundry
  const isFoundry =
    process.env.CLAUDE_CODE_USE_FOUNDRY === '1' ||
    Boolean(process.env.ANTHROPIC_FOUNDRY_RESOURCE) ||
    Boolean(process.env.ANTHROPIC_FOUNDRY_BASE_URL) ||
    Boolean(process.env.ANTHROPIC_BASE_URL?.toLowerCase().includes('azure')) ||
    Boolean(process.env.AZURE_AI_API_KEY) ||
    Boolean(process.env.FOUNDRY_API_KEY);

  if (isFoundry) {
    const res = process.env.ANTHROPIC_FOUNDRY_RESOURCE || 'Microsoft Azure AI Foundry';
    return {
      ok: true,
      provider: 'foundry',
      message: `Bereit via Microsoft Foundry (${res})`,
    };
  }

  // 2. AWS Bedrock
  const isBedrock =
    process.env.CLAUDE_CODE_USE_BEDROCK === '1' ||
    Boolean(process.env.AWS_PROFILE) ||
    Boolean(process.env.AWS_ACCESS_KEY_ID);

  if (isBedrock) {
    const reg = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'Standard-Region';
    return {
      ok: true,
      provider: 'bedrock',
      message: `Bereit via AWS Bedrock (${reg})`,
    };
  }

  // 3. Google Cloud Vertex AI
  const isVertex =
    process.env.CLAUDE_CODE_USE_VERTEX === '1' ||
    Boolean(process.env.ANTHROPIC_VERTEX_PROJECT_ID) ||
    Boolean(process.env.CLOUD_ML_REGION);

  if (isVertex) {
    const prj = process.env.ANTHROPIC_VERTEX_PROJECT_ID || 'GCP Vertex';
    return {
      ok: true,
      provider: 'vertex',
      message: `Bereit via Google Cloud Vertex AI (${prj})`,
    };
  }

  // 4. Direct Anthropic API Key or Auth Token
  if (Boolean(process.env.ANTHROPIC_API_KEY) || Boolean(process.env.ANTHROPIC_AUTH_TOKEN)) {
    return {
      ok: true,
      provider: 'anthropic',
      message: 'Bereit via Anthropic API (Direktverbindung / API-Key)',
    };
  }

  // 5. Claude CLI Login file in user home (~/.claude.json)
  const claudeJson = path.join(app.getPath('home'), '.claude.json');
  if (fs.existsSync(claudeJson)) {
    try {
      const content = fs.readFileSync(claudeJson, 'utf8');
      if (content.includes('oauth') || content.includes('token') || content.includes('primaryApiKey')) {
        return {
          ok: true,
          provider: 'anthropic',
          message: 'Bereit via Claude CLI Login (~/.claude.json)',
        };
      }
    } catch {
      // ignore
    }
  }

  return {
    ok: false,
    provider: 'none',
    message: 'Keine aktive Claude-Authentifizierung im System gefunden.',
    tip: 'Hinweise zur Einrichtung je nach Umgebung:\n• Microsoft Foundry: Setze CLAUDE_CODE_USE_FOUNDRY=1 und ANTHROPIC_FOUNDRY_RESOURCE in den Windows-Umgebungsvariablen oder melde dich per az login an.\n• Anthropic direkt: Führe im Terminal "claude login" aus oder setze ANTHROPIC_API_KEY.\n• AWS / GCP: Setze CLAUDE_CODE_USE_BEDROCK=1 bzw. CLAUDE_CODE_USE_VERTEX=1.',
  };
}

// --- IPC: everything the renderer may ask for --------------------------------------------

ipcMain.handle('config:get', () => ({
  ...cfg,
  approvalMode: cfg.approvalMode || (SKIP_PERMISSIONS ? 'bypass' : 'safe'),
  language: getLanguage(),
  runtime: { skipPermissions: SKIP_PERMISSIONS, configPath: configPath() },
}));
ipcMain.handle('system:checkHealth', (_e, engineType?: string) => {
  const engine = engineType || cfg.engineType;
  if (engine === 'agy') return { engine: 'agy', ...checkAgyHealth() };
  if (engine === 'claude') return { engine: 'claude', ...checkClaudeHealth() };
  return { engine: 'gpts', ok: true, message: 'GPTS Engine (Vorbereitet)' };
});
ipcMain.handle('config:saveAll', async (_e, newValues: Partial<PocConfig>) => {
  const oldEngine = cfg.engineType;
  const oldModel = cfg.model;
  const oldRepo = cfg.workspaceRepo;
  const oldRoot = cfg.workspaceRoot;
  const oldPersona = cfg.persona;
  const oldName = cfg.agentName;

  cfg = { ...cfg, ...newValues };
  persist();

  if (cfg.agentName !== oldName && win) {
    win.setTitle(t('window.title', { agent: cfg.agentName }));
  }

  const needsRestart =
    cfg.engineType !== oldEngine ||
    cfg.model !== oldModel ||
    cfg.workspaceRepo !== oldRepo ||
    cfg.workspaceRoot !== oldRoot ||
    cfg.persona !== oldPersona;

  if (needsRestart) {
    await restartEngine();
  }

  return cfg;
});
ipcMain.handle('skills:list', () => listWorkspaceSkills(cfg.workspaceRepo));
ipcMain.handle('files:list', (_e, dir?: string) => listDir(dir || cfg.workspaceRoot));
ipcMain.handle('files:stat', (_e, p: string) => statPath(p));
ipcMain.handle('files:chooseFolder', async () => {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: cfg.workspaceRoot, title: t('dialog.chooseFolder') });
  if (r.canceled || r.filePaths.length === 0) return null;
  cfg = { ...cfg, workspaceRoot: r.filePaths[0] };
  persist();
  return cfg.workspaceRoot;
});
ipcMain.handle('files:chooseDir', async (_e, initialPath?: string, title?: string) => {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    defaultPath: initialPath || cfg.workspaceRoot || app.getPath('documents'),
    title: title || t('dialog.chooseFolder'),
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  return r.filePaths[0];
});
ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p));
ipcMain.handle('shell:reveal', (_e, p: string) => shell.showItemInFolder(p));
ipcMain.handle('shell:openExternal', (_e, url: string) => {
  if (/^https?:/i.test(url)) return shell.openExternal(url);
  return Promise.resolve();
});
ipcMain.on('chat:send', (_e, text: string) => {
  // A backend process that died (crash, closed externally) is restarted transparently before sending.
  if (engine && engine.isAlive && !engine.isAlive()) {
    void restartEngine().then(() => (engine ? engine.send(text) : sendToUi({ kind: 'error', text: t('err.engineNotRunning') })));
    return;
  }
  if (engine) engine.send(text);
  else sendToUi({ kind: 'error', text: t('err.engineNotRunning') });
});
ipcMain.on('chat:interrupt', () => {
  void (async () => {
    await engine?.interrupt();
    if (engine?.restartOnInterrupt) await restartEngine();
  })();
});
ipcMain.on('permission:answer', (_e, a: { requestId: string; allow: boolean; always: boolean }) =>
  engine?.answerPermission(a.requestId, a.allow, Boolean(a.always)),
);
ipcMain.handle('persona:set', async (_e, persona: Persona) => {
  cfg = { ...cfg, persona };
  persist();
  await restartEngine(); // persona lives in the system prompt, so a new session is needed
  return cfg.persona;
});
ipcMain.handle('approvals:set', (_e, mode: ApprovalMode) => {
  cfg = { ...cfg, approvalMode: mode };
  persist();
  engine?.setApprovalMode?.(mode);
  return cfg.approvalMode;
});
ipcMain.handle('engine:restart', () => restartEngine());
// Language only changes texts: new Terminal lines use it right away, no new session needed.
ipcMain.handle('language:set', (_e, language: Language) => {
  setLanguage(language);
  cfg = { ...cfg, language: getLanguage() };
  persist();
  win?.setTitle(t('window.title', { agent: cfg.agentName }));
  return getLanguage();
});
ipcMain.handle('models:list', async () => {
  try {
    return (await engine?.listModels()) ?? [];
  } catch (e) {
    sendToUi({ kind: 'terminal', line: t('err.modelList', { e: String(e) }), level: 'stderr' });
    return [];
  }
});
ipcMain.handle('models:set', async (_e, model: string) => {
  cfg = { ...cfg, model: model || undefined };
  persist();
  let live = false;
  try {
    live = Boolean(await engine?.setModel(cfg.model));
  } catch (e) {
    sendToUi({ kind: 'terminal', line: t('err.liveSwitch', { e: String(e) }), level: 'stderr' });
  }
  if (!live) await restartEngine();
  return { model: cfg.model ?? '', restarted: !live };
});

ipcMain.handle('sessions:list', async () => {
  try {
    const list = await listSessions(cfg.engineType, resolveCwd());
    return list.map((s) => ({
      ...s,
      isCurrent: s.id === currentConversationId,
    }));
  } catch (e) {
    sendToUi({ kind: 'terminal', line: `Sessions list error: ${String(e)}`, level: 'stderr' });
    return [];
  }
});
ipcMain.handle('sessions:current', () => currentConversationId);
ipcMain.handle('sessions:getHistory', async (_e, conversationId: string) => {
  try {
    return await getSessionHistory(cfg.engineType, conversationId);
  } catch (e) {
    sendToUi({ kind: 'terminal', line: `Get session history error: ${String(e)}`, level: 'stderr' });
    return [];
  }
});
ipcMain.handle('sessions:switch', async (_e, conversationId: string | null) => {
  currentConversationId = conversationId;
  await restartEngine();
  return { ok: true, currentId: currentConversationId };
});

// --- app lifecycle ------------------------------------------------------------------------

app.whenReady().then(() => {
  // app.getLocale() is only valid once Electron is ready; an explicit choice in config.json wins.
  setLanguage(cfg.language ?? detectLanguage(app.getLocale()));
  createWindow();
  win?.webContents.once('did-finish-load', () => void restartEngine());
});

app.on('window-all-closed', () => {
  void engine?.stop();
  app.quit();
});
