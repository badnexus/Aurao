# Termi Architecture Optimization Specification

## 1. Project Context & Core Directive
**Project:** Termi is an Electron/TypeScript desktop application wrapping autonomous CLI agent frameworks (Google Antigravity `agy`, Anthropic Claude SDK) in a GUI for non-software developers.
**Core Challenge:** CLI tools generate token-heavy, unstructured `stdout`/`stderr` streams designed for humans. Waiting for complete execution blocks the UI, causing high perceived latency.
**Objective:** Refactor the engine layer (`src/main/AgyEngine.ts`, `src/main/ClaudeEngine.ts`, `src/main/main.ts`) to stream outputs asynchronously, strictly sanitize and truncate terminal logs, and implement prompt caching.

## 2. Phase 1: Asynchronous IPC & Subprocess Streaming
The UI must reflect terminal output and LLM reasoning instantly. The engines must not block while waiting for a process to exit.

### Implementation Tasks
* **Migrate to `spawn`:** Ensure all CLI executions use `child_process.spawn` instead of `exec` or synchronous equivalents.
* **Chunked IPC Streaming:** Bind to `stdout.on('data')` and `stderr.on('data')`. Pipe these text chunks to the Electron renderer process using `webContents.send('terminal-stream-chunk', data)`.
* **Frontend Aggregation:** Update the React/UI layer to append incoming SSE/IPC chunks to the active terminal block in real-time.
* **Edge Case Constraint (IPC Flooding):** When piping `stdout.on('data')` over IPC, implement a 50ms to 100ms debounce or buffer accumulator. Do not send thousands of microscopic IPC messages per second; batch the chunks.

## 3. Phase 2: Token Sanitization & Middle-Out Truncation
Raw terminal logs rapidly exhaust the LLM context window. Implement a strictly typed `LogSanitizer` utility to preprocess all streams before they append to the LLM's message history.

### Implementation Tasks
* **ANSI Stripping:** Integrate the existing `strip-ansi` dependency to remove all color and formatting codes from the buffer before LLM ingestion.
* **Noise Filtering Regex:** Write regex patterns to detect and strip repetitive CLI noise (e.g., loading bars like `[=====> ]`, redundant absolute paths, consecutive empty newlines).
* **Middle-Out Truncation Logic:** If a command output exceeds a defined character threshold (e.g., 1000 chars), truncate the middle. Keep the first 10 lines and the last 40 lines. Replace the middle with `\n... [Truncated {X} lines to preserve context window] ...\n`.
* **Edge Case Constraint (Carriage Returns):** Ensure the regex handles carriage returns (`\r`) properly. If a string contains multiple `\r` overwrites (typical for loading bars), resolve them so only the final state of that line is kept before appending to the LLM context.

## 4. Phase 3: Rolling Context & Prompt Caching
The LLM does not need the raw output of a command that succeeded 10 turns ago. It only needs the immediate working context.

### Implementation Tasks
* **Context Summarization:** Modify the session state manager (`src/main/sessions.ts`). For commands older than 3 conversation turns that exited with code `0`, replace the raw `stdout` in the LLM payload with a system flag: `[System: Command executed successfully. Output hidden.]`
* **Anthropic Prompt Caching:** In `ClaudeEngine.ts`, configure the API request headers to utilize Prompt Caching for the system instructions, persona definitions, and dense tool/schema definitions.
* **Edge Case Constraint (Cache Eviction & Thresholds):** Place the `cache_control: { type: 'ephemeral' }` object strictly on the final static block of the system instructions or tool schemas. Ensure dynamic content (like the rolling chat history) comes AFTER the cached breakpoints.

## 5. Acceptance Criteria
1. **Zero UI Blocking:** The renderer process remains fully responsive while scripts execute.
2. **Token Reduction:** Running a verbose command passes fewer than 500 tokens of standard error/output back to the LLM.
3. **Type Safety:** All IPC channels (`ipcMain.handle`, `ipcRenderer.invoke`) remain strictly typed via the `src/preload/preload.ts` context bridge.
