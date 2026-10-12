// Electron main process: one window, one agent engine, a thin IPC layer in between.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig, saveConfig, configIsBroken, configPath, POC_ROOT, type PocConfig, type Persona, type ApprovalMode } from './config';
import type { EngineEvent } from './EngineTypes';
import type { IEngine } from './IEngine';
import { ClaudeEngine } from './ClaudeEngine';
import { AgyEngine } from './AgyEngine';
import { GptsEngine } from './GptsEngine';
import { listWorkspaceSkills } from './skills';
import { syncWorkspace } from './workspace';
import { listDir, statPath } from './files';
import { systemPromptAppend } from './persona';
import { detectLanguage, getLanguage, setLanguage, t, type Language } from './i18n';

let win: BrowserWindow | null = null;
let engine: IEngine | null = null;
let cfg: PocConfig = loadConfig();
let workspaceSynced = false;

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
    approvalMode: effectiveApprovalMode,
    availableModels: cfg.availableModels,
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
  if (cfg.greetOnStart) engine.send(t('greeting', { agent: cfg.agentName }));
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

// --- IPC: everything the renderer may ask for --------------------------------------------

ipcMain.handle('config:get', () => ({
  ...cfg,
  approvalMode: cfg.approvalMode || (SKIP_PERMISSIONS ? 'bypass' : 'safe'),
  language: getLanguage(),
  runtime: { skipPermissions: SKIP_PERMISSIONS, configPath: configPath() },
}));
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
