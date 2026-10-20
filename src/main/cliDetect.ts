// Zero-config CLI auto-detection for first-run experience.
// Checks PATH and standard global npm/user binary directories for 'claude', 'codex', and 'agy'
// using pure filesystem lookups (never spawns visible console shells on Windows).
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { EngineType } from './config';

export interface DetectedEngines {
  claude: boolean;
  gpts: boolean;
  agy: boolean;
  recommended: EngineType;
}

export interface DetectOptions {
  envPath?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  appDataDir?: string;
  localAppDataDir?: string;
}

function getCandidateDirs(opts: DetectOptions = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const envPath = opts.envPath ?? process.env.PATH ?? '';
  const homeDir = opts.homeDir ?? os.homedir();
  const appDataDir = opts.appDataDir ?? process.env.APPDATA ?? '';
  const localAppDataDir = opts.localAppDataDir ?? process.env.LOCALAPPDATA ?? '';

  const sep = platform === 'win32' ? ';' : ':';
  const fromPath = envPath
    .split(sep)
    .map((p) => p.trim().replace(/^"+|"+$/g, ''))
    .filter(Boolean);

  const extraDirs: string[] = [];
  if (platform === 'win32') {
    if (appDataDir) extraDirs.push(path.win32.join(appDataDir, 'npm'));
    if (localAppDataDir) {
      extraDirs.push(path.win32.join(localAppDataDir, 'Programs', 'claude'));
      extraDirs.push(path.win32.join(localAppDataDir, 'Programs', 'antigravity'));
    }
    if (homeDir) {
      extraDirs.push(path.win32.join(homeDir, '.local', 'bin'));
      extraDirs.push(path.win32.join(homeDir, 'AppData', 'Roaming', 'npm'));
    }
  } else if (homeDir) {
    extraDirs.push(
      path.posix.join(homeDir, '.local', 'bin'),
      path.posix.join(homeDir, '.npm-global', 'bin'),
      '/usr/local/bin',
      '/usr/bin'
    );
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of [...fromPath, ...extraDirs]) {
    if (!seen.has(dir)) {
      seen.add(dir);
      result.push(dir);
    }
  }
  return result;
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function hasExecutable(binaryName: string, opts: DetectOptions = {}): boolean {
  const platform = opts.platform ?? process.platform;
  const dirs = getCandidateDirs(opts);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, binaryName + ext);
      if (isExecutableFile(candidate, platform)) {
        return true;
      }
    }
  }
  return false;
}

export function detectInstalledEngines(opts: DetectOptions = {}): DetectedEngines {
  const claude = hasExecutable('claude', opts);
  const gpts = hasExecutable('codex', opts);
  const agy = hasExecutable('agy', opts);

  let recommended: EngineType = 'claude';
  if (claude) {
    recommended = 'claude';
  } else if (gpts) {
    recommended = 'gpts';
  } else if (agy) {
    recommended = 'agy';
  }

  return { claude, gpts, agy, recommended };
}

/**
 * Resolves the best engine for first run when the user has not explicitly saved an `engineType` override.
 * If a bundled default engine is specified and installed on the system, it is preserved; otherwise
 * falls back to `detected.recommended`.
 */
export function resolveFirstRunEngine(
  bundledEngine?: EngineType,
  opts: DetectOptions = {}
): EngineType {
  const detected = detectInstalledEngines(opts);
  if (bundledEngine && detected[bundledEngine]) {
    return bundledEngine;
  }
  return detected.recommended;
}
