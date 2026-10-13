# Termi — The Cozy Desktop Interface for Agentic AI

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)]()

<img width="3768" height="1977" alt="Termi Interface" src="https://github.com/user-attachments/assets/c6f1568c-21a0-4304-a43f-b4fa438a5d62" />

**Termi** bridges the gap between powerful developer CLI agents and everyday desktop users. It wraps autonomous command-line agent frameworks—such as the **Google Antigravity CLI (`agy`)** and the **Anthropic Claude Agent SDK**—in a friendly, cozy chat window featuring human-in-the-loop safety cards, native drag-and-drop, and an optional jargon-free persona.

> *I originally built Termi for my wife so she could harness the full power of autonomous agentic AI for research, document management, and workflows—without having to learn terminal commands, Git, or shell syntax. It worked so well that I realized millions of non-technical professionals and teams face the exact same barrier.*

---

## 🚀 Quick Start (Windows Portable)

No installation, Node.js, or command line required:

👉 **[Download the latest Termi Windows Portable (.exe)](https://github.com/badnexus/Termi/releases)**

1. Download `Termi-vX.Y.Z-portable.exe` from the latest GitHub Release.
2. Run the executable anywhere (USB drive, Desktop, Downloads).
3. Open the **Settings (`⚙️`)** menu in the top bar to verify your engine health and customize personas.

---

## 🌟 Why Termi?

Autonomous AI CLI tools can edit files, run shell commands, analyze directories, and search the web. However, interacting with them via raw command prompts can be intimidating, verbose, and dangerous without visual guardrails.

Termi solves this by providing:

- ☕ **Familiar Chat & Zero Terminal Jargon:** Looks and feels like a modern messaging app. Switch between standard developer mode and a **Plain Language Persona** that replaces confusing technical terms (*repositories, APIs, YAML, CWD*) with friendly desktop concepts (*folders, documents, files*) and explains pending actions before executing them.
- 🛡️ **Human-in-the-Loop Approval Cards (3 Modes):**
  - **With Approval (`ask`):** Every single tool execution prompts an interactive card with clear **Approve** and **Deny** buttons.
  - **Safe Changes (`safe`, default):** Read-only tools (viewing files, web search) run automatically; modifications and commands require your click.
  - **Autopilot (`bypass`):** Full autonomous agent execution with an active visual warning badge.
- 📂 **Native Drag & Drop File Explorer:** Built-in sidebar explorer lets you drag files, folders, and documents directly into the chat. Paths and references are automatically resolved and passed into the agent's context.
- 📜 **Chat History & Session Resuming:** Revisit past conversations anytime via the **Verlauf (History)** tab. Features full visual Markdown rendering, message timestamps, keyword search, and a 1-click **New Chat** button.
- ⚙️ **In-App Settings & Multi-Provider Diagnostics:** Full visual configuration for engines, models, reasoning effort, allowed tools, and workspace paths. Includes an automated health-check diagnostic modal for Google Antigravity (`agy`), Claude Agent SDK, and cloud providers.
- 🔌 **Dual-Engine Architecture:** Pluggable engine layer supporting both Google Antigravity (`agy`) and the Anthropic Claude Agent SDK.
- 🌐 **Bilingual (DE / EN):** Full user interface localization in English and German.

---

## 🛠️ Building & Running from Source

If you want to run from source or contribute:

### Prerequisites
- [Node.js](https://nodejs.org/) v22+
- Either the **Google Antigravity CLI (`agy`)** or Anthropic API credentials configured.

### Quick Commands

```bash
# 1. Clone the repository
git clone https://github.com/badnexus/Termi.git
cd Termi

# 2. Install dependencies
npm install

# 3. Run in development mode
npm start

# 4. Package standalone Windows Portable executable
npm run dist
```

Built executables and checksums will be generated in the `release/` directory.

---

## 🏗️ Architecture

Termi is built with Electron and TypeScript using a clean separation of concerns:

- `src/main/IEngine.ts` — Common engine interface abstraction.
- `src/main/AgyEngine.ts` — Antigravity CLI subprocess orchestration, dynamic model discovery (`agy models`), and hook bridges.
- `src/main/ClaudeEngine.ts` — Claude Agent SDK integration and lifecycle management.
- `src/main/sessions.ts` — Native session state querying (SQLite & SDK transcripts) and history reconstruction.
- `src/main/persona.ts` — Persona system and plain-language terminology translation layer.
- `src/preload/preload.ts` — Secure context-isolated IPC bridge.
- `src/renderer/` — Reactive UI, Markdown rendering, approval card components, and multi-view navigation.

---

## ⚖️ License & Dual-Licensing

Termi is free open-source software, licensed under the **GNU General Public License v3.0 (GPLv3)**.

- **Community & Personal Use:** You are free to run, study, share, and modify Termi under the terms of the GPLv3. Any distributed modifications must also remain open source under the GPLv3.
- **Contributions:** We welcome community contributions! Contributing requires accepting our lightweight [Contributor License Agreement (CLA)](CLA.md).
- **Commercial & Enterprise Licensing:** If you or your organization wish to integrate or distribute Termi without the copyleft obligations of the GPLv3 (e.g., in a proprietary corporate deployment or embedded within a closed-source solution), commercial licenses are available. Please contact Florian Schaider to discuss options.
