import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { SessionSummary } from './EngineTypes';

export function listAgySessions(cwd?: string): SessionSummary[] {
  try {
    const dbPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversation_summaries.db');
    if (!fs.existsSync(dbPath)) return [];

    // Dynamically require node:sqlite
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris
      FROM conversation_summaries
      ORDER BY last_modified_time DESC
      LIMIT 100
    `).all() as Array<{
      conversation_id: string;
      title: string;
      preview: string;
      step_count: number;
      last_modified_time: string;
      workspace_uris: string;
    }>;
    db.close();

    const normalizedCwd = cwd ? path.resolve(cwd).toLowerCase() : '';

    return rows.map((r) => {
      let workspace = '';
      let matchesCwd = false;
      try {
        const uris = JSON.parse(r.workspace_uris || '[]');
        if (Array.isArray(uris) && uris.length > 0) {
          workspace = decodeURIComponent(uris[0].replace(/^file:\/\/\/?/i, '')).replace(/\//g, path.sep);
          if (normalizedCwd && path.resolve(workspace).toLowerCase() === normalizedCwd) {
            matchesCwd = true;
          }
        }
      } catch {
        // ignore
      }

      return {
        id: r.conversation_id,
        title: r.title && r.title.trim() ? r.title : (r.preview && r.preview.trim() ? r.preview : 'Unterhaltung'),
        preview: r.preview || '',
        lastModified: r.last_modified_time,
        stepCount: r.step_count || 0,
        workspace,
        matchesCwd,
      };
    });
  } catch (err) {
    console.error('Failed to list agy sessions:', err);
    return [];
  }
}

export async function listClaudeSessions(cwd?: string): Promise<SessionSummary[]> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    if (typeof sdk.listSessions !== 'function') return [];
    const sessions = await sdk.listSessions(cwd ? { dir: cwd } : undefined);
    return (sessions || []).map((s: { sessionId: string; summary?: string; mtime?: number; messageCount?: number }) => ({
      id: s.sessionId,
      title: s.summary && s.summary.trim() ? s.summary : s.sessionId.slice(0, 8),
      preview: s.summary || '',
      lastModified: s.mtime ? new Date(s.mtime).toISOString() : '',
      stepCount: s.messageCount ?? 0,
      workspace: cwd,
      matchesCwd: true,
    }));
  } catch (err) {
    console.error('Failed to list claude sessions:', err);
    return [];
  }
}

export async function listSessions(engineType: string, cwd?: string): Promise<SessionSummary[]> {
  if (engineType === 'agy') {
    return listAgySessions(cwd);
  }
  if (engineType === 'claude') {
    return listClaudeSessions(cwd);
  }
  return [];
}
