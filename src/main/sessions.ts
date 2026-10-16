import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { HistoricalMessage, SessionSummary } from './EngineTypes';
import { sanitizeForLlm } from './LogSanitizer';

const GREETING_REGEX = /^(casual|friendly|general|simple)?\s*(greeting|begr[üu]ßung)$/i;
const IS_GREETING_TEXT = /^(hallo|hello|hi|hey|guten tag|moin|servus)\b[\s\w]*$/i;

function cleanUserPrompt(raw: string): string {
  if (!raw) return '';
  const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  let text = match ? match[1] : raw;
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  text = text.replace(/<[^>]+>/g, '').replace(/\r?\n/g, ' ').trim();
  return text;
}

function getPromptsFromTranscript(conversationId: string): string[] {
  try {
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs');
    const fullLog = path.join(brainDir, 'transcript_full.jsonl');
    const compactLog = path.join(brainDir, 'transcript.jsonl');
    const target = fs.existsSync(fullLog) ? fullLog : (fs.existsSync(compactLog) ? compactLog : null);
    if (!target) return [];

    const content = fs.readFileSync(target, 'utf8');
    const lines = content.split('\n');
    const prompts: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'USER_INPUT' && entry.content) {
          const cleaned = cleanUserPrompt(String(entry.content));
          if (cleaned) prompts.push(cleaned);
        }
      } catch {
        // ignore
      }
    }
    return prompts;
  } catch {
    return [];
  }
}

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

      let title = (r.title || '').trim();
      let preview = (r.preview || '').trim();

      const prompts = getPromptsFromTranscript(r.conversation_id);
      const substantive = prompts.filter((p) => !IS_GREETING_TEXT.test(p));
      const firstSub = substantive[0] || prompts[0] || '';
      const lastSub = substantive[substantive.length - 1] || prompts[prompts.length - 1] || '';

      if (!title || GREETING_REGEX.test(title) || title.toLowerCase() === 'unterhaltung') {
        if (firstSub) {
          title = firstSub.length > 60 ? firstSub.slice(0, 57) + '…' : firstSub;
          preview = (lastSub && lastSub !== firstSub) ? lastSub : firstSub;
        } else {
          title = 'Unterhaltung';
        }
      } else if (!preview || preview === title || GREETING_REGEX.test(preview)) {
        if (firstSub) preview = firstSub;
      }

      if (preview && preview.length > 140) {
        preview = preview.slice(0, 137) + '…';
      }

      return {
        id: r.conversation_id,
        title,
        preview,
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

export function getAgySessionHistory(conversationId: string): HistoricalMessage[] {
  try {
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs');
    const fullLog = path.join(brainDir, 'transcript_full.jsonl');
    const compactLog = path.join(brainDir, 'transcript.jsonl');
    const target = fs.existsSync(fullLog) ? fullLog : (fs.existsSync(compactLog) ? compactLog : null);
    if (!target) return [];

    const content = fs.readFileSync(target, 'utf8');
    const lines = content.split('\n');
    const history: HistoricalMessage[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'USER_INPUT' && entry.content) {
          let text = String(entry.content);
          const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
          if (match) text = match[1];
          text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
          text = text.replace(/<[^>]+>/g, '').trim();
          if (text) {
            history.push({
              role: 'user',
              text,
              timestamp: entry.created_at,
            });
          }
        } else if (entry.type === 'PLANNER_RESPONSE' && entry.content) {
          const text = String(entry.content).trim();
          if (text) {
            history.push({
              role: 'assistant',
              text,
              timestamp: entry.created_at,
            });
          }
        }
      } catch {
        // ignore line
      }
    }
    return history;
  } catch (err) {
    console.error('Failed to get agy session history:', err);
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

export async function getClaudeSessionHistory(sessionId: string): Promise<HistoricalMessage[]> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    if (typeof sdk.getSessionMessages !== 'function') return [];
    const res = await sdk.getSessionMessages(sessionId);
    const list = Array.isArray(res) ? res : (res && Array.isArray((res as any).messages) ? (res as any).messages : []);
    const history: HistoricalMessage[] = [];
    for (const m of list) {
      const role = m.role === 'user' ? 'user' : (m.role === 'assistant' ? 'assistant' : null);
      if (!role) continue;
      let text = '';
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        text = m.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
      }
      if (text.trim()) {
        history.push({
          role,
          text: text.trim(),
          timestamp: m.timestamp || m.created_at,
        });
      }
    }
    return history;
  } catch (err) {
    console.error('Failed to get claude session history:', err);
    return [];
  }
}

/**
 * Rolling context summarization (not applied anywhere yet): Termi never assembles the model's
 * message history itself - the Claude SDK and agy own their transcripts - and the History view
 * must show what was said verbatim. Kept for a future path that really builds an LLM payload.
 *
 * For commands older than keepTurns (default 3) that completed successfully (exit code 0),
 * replace the raw stdout in the message text with [System: Command executed successfully. Output hidden.].
 */
export function summarizeRollingContext(
  messages: HistoricalMessage[],
  keepTurns = 3,
  sanitizeLogs = true,
): HistoricalMessage[] {
  const total = messages.length;
  return messages.map((m, idx) => {
    // Number of turns (assistant responses) after this message
    const turnsFromEnd = Math.floor((total - 1 - idx) / 2);
    let text = m.text;

    if (turnsFromEnd >= keepTurns) {
      const isExitCodeZero =
        /exit(?:ed with)? code:?\s*0\b/i.test(text) ||
        /\bstatus:?\s*0\b/i.test(text) ||
        /\bexited with status 0\b/i.test(text) ||
        /Command executed successfully/i.test(text);

      if (isExitCodeZero) {
        if (/(Output:|stdout:)[\s\S]+/i.test(text)) {
          text = text.replace(
            /(?:Output:|stdout:)[\s\S]+/i,
            'Output:\n[System: Command executed successfully. Output hidden.]',
          );
        } else if (text.length > 300) {
          text = '[System: Command executed successfully. Output hidden.]';
        }
      }
    }

    if (sanitizeLogs) {
      text = sanitizeForLlm(text, true);
    }

    return {
      ...m,
      text,
    };
  });
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

export async function getSessionHistory(engineType: string, sessionId: string): Promise<HistoricalMessage[]> {
  if (engineType === 'agy') return getAgySessionHistory(sessionId);
  if (engineType === 'claude') return getClaudeSessionHistory(sessionId);
  return [];
}
