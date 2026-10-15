/**
 * LogSanitizer - Strictly typed terminal stream preprocessing utility for LLM ingestion.
 *
 * Prevents context-window bloat by stripping ANSI escape sequences, collapsing carriage-return
 * progress overwrites, stripping repetitive CLI noise, and applying middle-out truncation.
 */

// Matches CSI, OSC, and standard ANSI escape codes without external dependencies
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const OSC_REGEX = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

// Common CLI noise: ASCII progress bars like [=====>    ], spinners, tqdm bars
const PROGRESS_BAR_REGEX = /\[[=\->\s#*]{5,}\]\s*(?:\d{1,3}%)?/g;
const UNICODE_PROGRESS_REGEX = /\|\s*[█▎▍▌▋▊▉\s]{5,}\s*\|\s*(?:\d{1,3}%)?/g;
const SPINNER_CHARS_REGEX = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;

export interface TruncationOptions {
  maxChars?: number;
  headLines?: number;
  tailLines?: number;
}

/**
 * Strips all ANSI formatting, color, and cursor movement escape sequences.
 */
export function stripAnsi(text: string): string {
  if (!text) return '';
  return text.replace(OSC_REGEX, '').replace(ANSI_REGEX, '');
}

/**
 * Resolves carriage-return (\r) overwrites (typical for in-place CLI loading bars)
 * so only the final visible state of each line is preserved.
 */
export function resolveCarriageReturns(text: string): string {
  if (!text || !text.includes('\r')) return text;

  // Split lines on standard line breaks (\n or \r\n)
  const lines = text.split(/\r?\n/);
  const resolved = lines.map((line) => {
    if (!line.includes('\r')) return line;
    const parts = line.split('\r');
    // In terminal behavior, subsequent segments overwrite earlier ones from col 0.
    // The final segment represents the settled state.
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].trim().length > 0) return parts[i];
    }
    return '';
  });

  return resolved.join('\n');
}

/**
 * Detects and removes repetitive CLI noise such as progress bars and excessive blank lines.
 */
export function stripNoise(text: string): string {
  if (!text) return '';
  return text
    .replace(PROGRESS_BAR_REGEX, '')
    .replace(UNICODE_PROGRESS_REGEX, '')
    .replace(SPINNER_CHARS_REGEX, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Truncates long command outputs by removing the middle lines.
 * Retains the first headLines (default: 10) and last tailLines (default: 40).
 * If the output has few lines (e.g. minified single-line payloads) but exceeds maxChars,
 * it falls back to character-based middle-out truncation.
 */
export function truncateMiddleOut(text: string, options?: TruncationOptions): string {
  const maxChars = options?.maxChars ?? 1000;
  const headLines = options?.headLines ?? 10;
  const tailLines = options?.tailLines ?? 40;

  if (!text || text.length <= maxChars) {
    return text;
  }

  const lines = text.split('\n');
  const totalLines = lines.length;
  const thresholdLines = headLines + tailLines;

  if (totalLines > thresholdLines) {
    const head = lines.slice(0, headLines);
    const tail = lines.slice(-tailLines);
    const truncatedCount = totalLines - thresholdLines;
    const notice = `... [Truncated ${truncatedCount} lines to preserve context window] ...`;
    return [...head, notice, ...tail].join('\n');
  }

  // Fallback for minified or dense outputs with few lines exceeding character threshold
  const retainChars = Math.floor(maxChars * 0.4);
  const headPart = text.slice(0, retainChars);
  const tailPart = text.slice(-retainChars);
  const truncatedChars = text.length - (retainChars * 2);
  const notice = `\n... [Truncated ${truncatedChars} characters to preserve context window] ...\n`;
  return headPart + notice + tailPart;
}

/**
 * Complete sanitization pipeline:
 * 1. Strips ANSI escape codes.
 * 2. Resolves carriage return overwrites.
 * 3. Strips repetitive CLI noise.
 * 4. Applies middle-out truncation if exceeding character limits.
 *
 * Can be completely bypassed by setting enabled = false (user setting).
 */
export function sanitizeForLlm(rawOutput: string, enabled = true, options?: TruncationOptions): string {
  if (!enabled || !rawOutput) return rawOutput;

  const withoutAnsi = stripAnsi(rawOutput);
  const resolvedCr = resolveCarriageReturns(withoutAnsi);
  const withoutNoise = stripNoise(resolvedCr);
  return truncateMiddleOut(withoutNoise, options);
}
