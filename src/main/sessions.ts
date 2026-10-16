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

const codexSessionCache = new Map<
  string,
  { mtimeMs: number; summary: Omit<SessionSummary, 'matchesCwd'>; filePath: string }
>();

function defaultCodexSessionsDir(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

function collectRolloutFiles(dir: string, acc: Array<{ filePath: string; mtimeMs: number }> = []): Array<{ filePath: string; mtimeMs: number }> {
  if (!fs.existsSync(dir)) return acc;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRolloutFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const st = fs.statSync(full);
        acc.push({ filePath: full, mtimeMs: st.mtimeMs });
      } catch {
        // ignore unreadable file
      }
    }
  }
  return acc;
}

function parseCodexMessageEntry(entry: Record<string, any>): { role: 'user' | 'assistant'; text: string; timestamp?: string } | null {
  const ts = entry.timestamp || entry.payload?.timestamp || entry.created_at;

  // Format 1: {"type":"event_msg","payload":{"type":"user_message"|"agent_message","message":"..."}}
  if (entry.type === 'event_msg' && entry.payload) {
    const pType = entry.payload.type;
    if (pType === 'user_message' && typeof entry.payload.message === 'string') {
      return { role: 'user', text: entry.payload.message.trim(), timestamp: ts };
    }
    if ((pType === 'agent_message' || pType === 'assistant_message') && typeof entry.payload.message === 'string') {
      return { role: 'assistant', text: entry.payload.message.trim(), timestamp: ts };
    }
  }

  // Format 2: {"type":"response_item","payload":{"type":"message","role":"user"|"assistant","content":[...]}}
  const msgObj = entry.type === 'response_item' && entry.payload ? entry.payload : entry;
  if ((msgObj.role === 'user' || msgObj.role === 'assistant') && msgObj.content !== undefined) {
    let text = '';
    if (typeof msgObj.content === 'string') {
      text = msgObj.content;
    } else if (Array.isArray(msgObj.content)) {
      text = msgObj.content
        .filter((b: any) => b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n');
    }
    text = text.trim();
    if (text) return { role: msgObj.role, text, timestamp: ts };
  }

  return null;
}

function extractSessionIdFromFilename(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  // rollout-2026-10-16T12-00-00-0199a213-81c0-7800-8aa1-bbab2a035a53 -> extract UUID or full basename
  const uuidMatch = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (uuidMatch) return uuidMatch[1];
  return base.replace(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-/, '') || base;
}

export function listCodexSessions(cwd?: string, sessionsDirOverride?: string): SessionSummary[] {
  try {
    const rootDir = sessionsDirOverride || defaultCodexSessionsDir();
    const files = collectRolloutFiles(rootDir);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const recentFiles = files.slice(0, 100);
    const normalizedCwd = cwd ? path.resolve(cwd).toLowerCase() : '';

    const results: SessionSummary[] = [];
    const seenIds = new Set<string>();

    for (const { filePath, mtimeMs } of recentFiles) {
      let cached = codexSessionCache.get(filePath);
      if (!cached || cached.mtimeMs !== mtimeMs) {
        let content = '';
        try {
          content = fs.readFileSync(filePath, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/);
        let sessionId = extractSessionIdFromFilename(filePath);
        let workspace = '';
        let lastModified = new Date(mtimeMs).toISOString();
        const userPrompts: string[] = [];
        let stepCount = 0;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'session_meta' && entry.payload) {
              if (entry.payload.id) sessionId = String(entry.payload.id);
              if (entry.payload.cwd) workspace = String(entry.payload.cwd);
              if (entry.payload.timestamp) lastModified = String(entry.payload.timestamp);
            } else if (entry.id && entry.cwd && !entry.type) {
              sessionId = String(entry.id);
              workspace = String(entry.cwd);
              if (entry.timestamp) lastModified = String(entry.timestamp);
            }

            const msg = parseCodexMessageEntry(entry);
            if (msg) {
              stepCount++;
              if (msg.role === 'user') {
                const cleaned = cleanUserPrompt(msg.text);
                if (cleaned) userPrompts.push(cleaned);
              }
            }
          } catch {
            // ignore malformed JSONL line
          }
        }

        const substantive = userPrompts.filter((p) => !IS_GREETING_TEXT.test(p));
        const firstSub = substantive[0] || userPrompts[0] || '';
        const lastSub = substantive[substantive.length - 1] || userPrompts[userPrompts.length - 1] || '';

        const title = firstSub
          ? firstSub.length > 60
            ? firstSub.slice(0, 57) + '…'
            : firstSub
          : sessionId.slice(0, 8);
        let preview = lastSub && lastSub !== firstSub ? lastSub : firstSub;
        if (preview.length > 140) preview = preview.slice(0, 137) + '…';

        cached = {
          mtimeMs,
          filePath,
          summary: {
            id: sessionId,
            title,
            preview,
            lastModified,
            stepCount,
            workspace,
          },
        };
        codexSessionCache.set(filePath, cached);
      }

      if (seenIds.has(cached.summary.id)) continue;
      seenIds.add(cached.summary.id);

      const matchesCwd = Boolean(
        normalizedCwd &&
          cached.summary.workspace &&
          path.resolve(cached.summary.workspace).toLowerCase() === normalizedCwd,
      );

      results.push({
        ...cached.summary,
        matchesCwd,
      });
    }

    return results;
  } catch (err) {
    console.error('Failed to list codex sessions:', err);
    return [];
  }
}

export function getCodexSessionHistory(sessionId: string, sessionsDirOverride?: string): HistoricalMessage[] {
  try {
    const rootDir = sessionsDirOverride || defaultCodexSessionsDir();
    const files = collectRolloutFiles(rootDir);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    let targetFile: string | null = null;
    for (const { filePath } of files) {
      if (path.basename(filePath).includes(sessionId)) {
        targetFile = filePath;
        break;
      }
      const cached = codexSessionCache.get(filePath);
      if (cached && cached.summary.id === sessionId) {
        targetFile = filePath;
        break;
      }
    }

    if (!targetFile) {
      // Fallback: inspect session_meta line of each file
      for (const { filePath } of files) {
        try {
          const firstLine = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)[0] || '';
          if (firstLine.includes(sessionId)) {
            targetFile = filePath;
            break;
          }
        } catch {
          // ignore
        }
      }
    }

    if (!targetFile || !fs.existsSync(targetFile)) return [];

    const content = fs.readFileSync(targetFile, 'utf8');
    const history: HistoricalMessage[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const msg = parseCodexMessageEntry(entry);
        if (msg && msg.text) {
          // Avoid consecutive duplicate user messages when both event_msg and response_item are logged
          const prev = history[history.length - 1];
          if (prev && prev.role === msg.role && prev.text === msg.text) continue;
          history.push(msg);
        }
      } catch {
        // ignore
      }
    }
    return history;
  } catch (err) {
    console.error('Failed to get codex session history:', err);
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
  if (engineType === 'gpts' || engineType === 'codex') {
    return listCodexSessions(cwd);
  }
  return [];
}

export async function getSessionHistory(engineType: string, sessionId: string): Promise<HistoricalMessage[]> {
  if (engineType === 'agy') return getAgySessionHistory(sessionId);
  if (engineType === 'claude') return getClaudeSessionHistory(sessionId);
  if (engineType === 'gpts' || engineType === 'codex') return getCodexSessionHistory(sessionId);
  return [];
}
