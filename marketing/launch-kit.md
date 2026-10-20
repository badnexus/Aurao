# Aurao v0.3.0 Multi-Channel Launch & Community Copy Kit

> **Strategic Principle (Gregor & Henrik):**
> Different communities reward completely different framing:
> - **Developers (`Show HN`, `r/ClaudeAI`, `r/LocalLLaMA`, `r/OpenAI`)** care about the *personal problem*, the *multi-engine architecture* (`IEngine` over `claude-agent-sdk`, `codex app-server` JSON-RPC 2.0 daemon, and `agy`), and *Human-in-the-Loop pre-tool hooks*.
> - **Everyday Power Users & Knowledge Workers (`r/PKMS`, `r/ObsidianMD`, `r/Productivity`, `r/AcademicPublishing`)** care about *concrete 5-minute workflows* on local files without terminal fear or copy-pasting.

---

## 1. Hacker News (`Show HN`)

- **Submission URL:** `https://github.com/badnexus/Aurao`
- **Best Posting Window:** Tuesday–Thursday, 15:00–17:00 CET (09:00–11:00 EST)
- **Title (strictly <80 chars):**
```text
Show HN: Aurao – A zero-jargon GUI over Claude Code and Codex CLI for my wife
```
- **First Comment (Maker Context — post immediately after submitting):**
```text
Hi HN,

I built Aurao originally for my wife. Over the last few months, CLI agents like Claude Code, OpenAI's Codex CLI, and Google Antigravity (`agy`) have become incredible at real knowledge work—sorting messy folders, synthesizing 20 PDFs into a briefing, and maintaining local Markdown vaults.

The problem: if you aren't a software engineer, a terminal window with raw stdout, CWD paths, and text-prompt permissions is intimidating and one mistyped approval away from deleting the wrong folder.

So I built Aurao (Electron + TypeScript, GPLv3) to wrap those exact CLI engines into a calm desktop UI designed for non-developers:

1. Multi-Engine Abstraction (`src/main/IEngine.ts`):
   - `ClaudeEngine.ts`: wraps `@anthropic-ai/claude-agent-sdk`.
   - `GptsEngine.ts`: runs OpenAI's `codex app-server` as a persistent stdio JSON-RPC 2.0 daemon (eliminating cold-spawn latency per turn, and unwrapping the native Rust `codex.exe` binary directly on Windows to bypass cmd.exe overhead).
   - `AgyEngine.ts`: wraps Google's Antigravity CLI (`agy`) with dynamic model discovery and local SQLite session indexing.

2. Human-in-the-Loop Pre-Tool Hooks:
   - Default mode is "Safe Changes": read-only tools execute seamlessly, while any file write/move/delete or shell command pauses and renders a visual 1-click Approval Card in the chat UI (`Approve` / `Decline`).

3. Plain-Language Persona & Hidden-File Filtering:
   - Strips developer jargon ("repository", "commit", "YAML", "stdout", "CWD") and hides dotfiles/Windows system junctions (`AppData`, `NTUSER.DAT`) in the built-in drag-and-drop workspace explorer.

4. Zero-Config First Run:
   - Auto-detects whichever CLI (`claude`, `codex`, or `agy`) is installed on your machine on first launch, and ships as a single portable Windows `.exe` (`Aurao-0.3.0.exe`) or runs from source on macOS/Linux.

Live overview page: https://badnexus.github.io/Aurao/
Repo & source: https://github.com/badnexus/Aurao

Would love your feedback on the engine abstraction and how you handle safe local file access for non-technical family or colleagues!
```

---

## 2. Reddit — Technical & AI Communities

### A. `r/ClaudeAI` & `r/ClaudeCode`
- **Title:**
```text
I built an open-source, zero-jargon desktop GUI for Claude Code (and Codex CLI) so my wife could use autonomous file agents safely with 1-click approval cards
```
- **Post Body:**
```markdown
Like many of you, I use Claude Code daily in the terminal—not just for code, but for organizing files, researching across PDFs, and managing Markdown notes.

My wife wanted the exact same capabilities for her everyday document and research workflows, but asking a non-developer to live inside a terminal with raw tool prompts is a non-starter.

So I open-sourced **Aurao (`v0.3.0`)** — a calm, portable desktop app that wraps the **Claude Agent SDK** (plus OpenAI Codex CLI and Google Antigravity) into a visual interface with zero terminal jargon:

- 🛡️ **1-Click Visual Approval Cards:** In "Safe Changes" mode (default), Aurao reads documents freely, but pauses and shows a clean visual card whenever it wants to create, edit, or move a file. Nothing touches the disk until you click **Approve**.
- 💬 **Plain-Language Persona:** Instructs the agent to never mention "repositories", "CWD", "branches", or "stdout", speaking instead in normal desktop concepts (folders, documents, Word/PDFs).
- ⚡ **Multi-Engine & Session History:** Switch between Claude, OpenAI Codex (`codex app-server`), and Google Antigravity (`agy`) on the fly, and resume past conversations with full visual Markdown restoration.
- 📦 **Zero-Install Windows Portable `.exe`:** Ships as a single `Aurao-0.3.0.exe` (and runs from source on Linux/macOS).

- **GitHub Repo (GPLv3):** https://github.com/badnexus/Aurao
- **Product Overview & Demo GIF:** https://badnexus.github.io/Aurao/
- **Direct Windows Portable Download:** https://github.com/badnexus/Aurao/releases/latest

Happy to answer any questions about how the `@anthropic-ai/claude-agent-sdk` pre-tool approval hooks and session history restoration are wired up!
```

### B. `r/OpenAI` & `r/ChatGPTCoding`
- **Title:**
```text
Open-sourced Aurao v0.3.0: A low-latency desktop GUI for OpenAI Codex CLI (`codex app-server`) & Claude Code with 1-click visual file approvals
```
- **Key Angle to Highlight:**
  Focus on `src/main/GptsEngine.ts` — how Aurao keeps a warm `codex app-server` JSON-RPC 2.0 daemon over `stdio` (<1ms turn dispatch), unwraps the native Windows Rust binary `codex.exe` directly, indexes `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` with `mtime` caching, and surfaces `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` as 1-click UI cards.

---

## 3. Reddit — Knowledge Work & Non-Developer Communities (`r/PKMS`, `r/ObsidianMD`, `r/Productivity`)

- **Title:**
```text
I built a free, open-source desktop assistant that organizes messy folders, summarizes PDFs, and edits local Markdown notes — with 1-click safety approvals before any file is changed
```
- **Post Body:**
```markdown
Web chatbots (ChatGPT, Claude in the browser) are great at chatting, but terrible at working with your actual computer: you end up endlessly uploading files and copy-pasting text back and forth. Meanwhile, the new generation of AI agents that *can* work with local folders usually require command-line/coding skills.

I originally built **Aurao** for my wife so she could use autonomous AI directly on her local folders and notes with **100% safety and zero technical jargon**:

### What we use it for every day:
1. **Cleaning messy Downloads/Desktop folders:** Drag a folder into the chat and ask *"Sort these PDFs and invoices into folders by year and topic."*
2. **Synthesizing research:** Drop 15 PDFs or Markdown notes into the window and ask *"Compare the key takeaways and save a 1-page briefing into my vault."*
3. **Safe vault maintenance:** Ask it to tag, cross-link, or summarize notes in a local folder without worrying about accidental overwrites.

### Why it's safe for your local files:
By default, Aurao runs in **Safe Changes** mode. It can read your files to answer questions, but whenever it wants to create, edit, or move a file, it pauses and shows a **visual Approval Card**. You see exactly what will happen and click **Approve** or **Decline**.

It's 100% free and open-source (GPLv3), runs locally on your desktop (Windows portable `.exe`, plus Linux/macOS from source), and supports Claude, OpenAI, and Google Antigravity.

- **Overview & Demo GIF:** https://badnexus.github.io/Aurao/
- **GitHub & Download:** https://github.com/badnexus/Aurao
```

---

## 4. X (Twitter) & LinkedIn Launch Thread (`v0.3.0`)

### English Post / Thread
```text
Terminal AI agents (Claude Code, OpenAI Codex CLI, Google Antigravity) are incredible at organizing files, summarizing PDFs, and drafting reports.

But 99% of people will never open a command-line window to use them.

So I built Aurao originally for my wife — and today v0.3.0 is live & open-source! ✨

What's new in Aurao v0.3.0:
🛡️ Visual 1-Click Approval Cards: AI reads freely, but pauses for your approval before touching any file.
🧠 3 Engines in 1 App: Claude Agent SDK + low-latency OpenAI Codex CLI (`codex app-server`) + Google Antigravity (`agy`).
🔍 Zero-Config First Run: Automatically detects which AI CLI you have installed.
💬 Zero Jargon: A Plain-Language Persona that speaks in "folders & documents", not "repos & stdout".

🌐 Website: https://badnexus.github.io/Aurao/
⭐ GitHub & Windows Portable (.exe): https://github.com/badnexus/Aurao

(Attach: assets/Aurao_Demo.gif)
```

### German LinkedIn Post Variant (DACH Network)
```text
Autonome KI-Agenten wie Claude Code, OpenAI Codex CLI und Google Antigravity können heute ganze Ordnerstrukturen aufräumen, 20 PDFs zu einem Management-Briefing verdichten und lokale Dokumente pflegen.

Der Haken: Sie leben im Entwickler-Terminal. Wer kein Softwareentwickler ist, schreckt vor schwarzen Konsolenfenstern und kryptischen Befehlen sofort zurück.

Genau deshalb habe ich ursprünglich für meine Frau **Aurao** entwickelt — und heute haben wir **Aurao v0.3.0** als Open Source veröffentlicht! 🚀

Was Aurao besonders macht:
🛡️ **Human-in-the-Loop per Klick:** Im Standardmodus („Nur Änderungen“) darf die KI Dokumente lesen, zeigt aber vor jeder Dateiänderung eine visuelle Freigabekarte („Freigeben“ / „Ablehnen“).
🧠 **Multi-Engine unter der Haube:** Verbindet Anthropic Claude Agent SDK, OpenAI Codex CLI (`codex app-server` Daemon) und Google Antigravity (`agy`) in einer einzigen Oberfläche.
🔍 **Zero-Config Start:** Erkennt beim ersten Start automatisch, welche Engine installiert ist.
💬 **Alltagssprache statt Entwickler-Jargon:** Spricht in Ordnern und Dokumenten statt in Repositories, Branches und CWD.

🌐 Produktseite: https://badnexus.github.io/Aurao/
⭐ GitHub & Windows Portable Download (.exe): https://github.com/badnexus/Aurao
```

---

## 5. Product Hunt Launch Kit

- **Name:** `Aurao`
- **Tagline (60 chars max):** `Autonomous AI agents for your files—without the terminal.`
- **Links:**
  - Website: `https://badnexus.github.io/Aurao/`
  - GitHub: `https://github.com/badnexus/Aurao`
- **Topics:** `Artificial Intelligence`, `Productivity`, `Open Source`, `Windows`, `Developer Tools`
- **Short Description:**
  `Aurao wraps autonomous terminal AI agents (Claude Code, OpenAI Codex CLI, and Google Antigravity) into a calm, zero-jargon desktop app. Organize messy folders, summarize stacks of PDFs, and edit local files safely with 1-click Human-in-the-Loop approval cards.`
- **Gallery Assets Checklist:**
  1. `assets/Aurao_Demo.gif` (Animated hero workflow)
  2. `assets/Aurao_Assistant.png` (High-res main interface + workspace explorer)
