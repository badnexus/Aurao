# Contributing to Aurao

Thank you for your interest in contributing to **Aurao**! Aurao's mission is to make autonomous AI agents (**Claude Agent SDK**, **OpenAI Codex CLI**, and **Google Antigravity `agy`**) safe, welcoming, and accessible to everyday desktop users without requiring terminal or coding skills.

---

## Development Setup

### Prerequisites
- **Node.js** v22+
- At least one supported AI backend installed or configured:
  - Anthropic Claude Code (`claude`) or API credentials
  - OpenAI Codex CLI (`codex`)
  - Google Antigravity CLI (`agy`)

### Quick Start
```bash
git clone https://github.com/badnexus/Aurao.git
cd Aurao
npm install
npm test
npm start
```

---

## Architecture & Extension Guide

### 1. Adding a New AI Agent Engine (`IEngine`)
All agent backends implement the `IEngine` interface in [`src/main/IEngine.ts`](src/main/IEngine.ts):
1. Create a new engine class in `src/main/<YourEngine>Engine.ts` implementing `IEngine` (`startTurn`, `stopTurn`, `approve`, `setApprovalMode`, `newChat`, `resumeSession`, `listModels`, `dispose`).
2. Emit unified events (`text`, `thinking`, `tool`, `approval`, `done`, `error`, `status`) so the renderer UI and `StreamAccumulator` work out-of-the-box.
3. Respect the 3 safety modes (`ask`, `safe`, `bypass`): read-only operations should pass automatically in `safe` mode, while file writes, deletes, or shell executions must request user approval via the `approval` callback.
4. Register the new engine key in `src/main/config.ts` (`EngineType`), `src/main/cliDetect.ts`, and `src/main/main.ts`.
5. Add unit tests in `test/<YourEngine>Engine.test.js`.

### 2. Adding or Improving UI Translations (`i18n`)
Aurao supports **English (`en`)** and **German (`de`)** with zero developer jargon in user-facing copy:
- Main-process strings live in [`src/main/i18n.ts`](src/main/i18n.ts).
- Renderer UI strings live in [`src/renderer/i18n.js`](src/renderer/i18n.js).
- When adding a new UI label, avoid terminal jargon (*repository, CWD, stdout, daemon, token*) and prefer warm, everyday desktop language (*workspace, folder, actions, safety mode*).

### 3. Plain-Language Persona (`persona.ts`)
- System prompt rules for the `standard` and `soft` personas are defined in [`src/main/persona.ts`](src/main/persona.ts).

---

## Testing & Pull Request Checklist

Before opening a Pull Request:
1. Run `npm test` and ensure all unit tests pass (`test/*.test.js`).
2. Run `npm run build` and verify zero TypeScript compiler errors.
3. All contributions are licensed under the project's [GNU General Public License v3.0 (GPL-3.0-only)](LICENSE).
