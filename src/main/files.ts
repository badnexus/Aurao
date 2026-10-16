// Folder listing for the Datei-Explorer. Deterministic, read-only, no model call.
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** Bytes for files; number of children for folders. */
  size: number;
  ext: string;
}

export interface DirListing {
  dir: string;
  parent: string | null;
  entries: FileEntry[];
}

const HIDE = new Set(['.git', 'node_modules', 'Desktop.ini', 'desktop.ini']);

const WIN_HIDDEN_NAMES = new Set([
  'appdata',
  'application data',
  'cookies',
  'local settings',
  'my documents',
  'nethood',
  'printhood',
  'recent',
  'sendto',
  'start menu',
  'templates',
  'thumbs.db',
  'ntuser.ini',
]);

function isHiddenEntry(name: string): boolean {
  if (name.startsWith('.') || name.startsWith('~$')) return true;
  const lower = name.toLowerCase();
  if (WIN_HIDDEN_NAMES.has(lower)) return true;
  if (lower.startsWith('ntuser.dat')) return true;
  return false;
}

/** Folder or file? Used for paths dropped from Windows Explorer. */
export function statPath(p: string): { isDir: boolean } {
  try {
    return { isDir: fs.statSync(p).isDirectory() };
  } catch {
    return { isDir: false };
  }
}

export function listDir(dir: string, showHidden = false): DirListing {
  const resolved = path.resolve(dir);
  const parent = path.dirname(resolved);
  let names: string[] = [];
  try {
    names = fs.readdirSync(resolved);
  } catch {
    return { dir: resolved, parent: parent !== resolved ? parent : null, entries: [] };
  }
  const entries: FileEntry[] = [];
  for (const name of names) {
    if (HIDE.has(name)) continue;
    if (!showHidden && isHiddenEntry(name)) continue;
    const full = path.join(resolved, name);
    try {
      const st = fs.statSync(full);
      const isDir = st.isDirectory();
      let size = st.size;
      if (isDir) {
        try {
          size = fs.readdirSync(full).filter((n) => !HIDE.has(n) && (showHidden || !isHiddenEntry(n))).length;
        } catch {
          size = 0;
        }
      }
      entries.push({ name, path: full, isDir, size, ext: isDir ? '' : path.extname(name).slice(1).toLowerCase() });
    } catch {
      // unreadable entry (locked file, broken link) — skip silently
    }
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'de') : a.isDir ? -1 : 1));
  return { dir: resolved, parent: parent !== resolved ? parent : null, entries };
}
