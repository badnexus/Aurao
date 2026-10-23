# Windows SmartScreen & Code Signing Guide for Aurao

This guide covers both the **immediate zero-cost SmartScreen allowlisting** with Microsoft and the **permanent automated Authenticode signing** via the **SignPath.io Open-Source Foundation** integrated in [`.github/workflows/release.yml`](../.github/workflows/release.yml).

---

## 1. Immediate Allowlisting at Microsoft (Clears SmartScreen in 4–24h)

To clear the blue *"Windows protected your PC"* SmartScreen popup for an existing unsigned release (`Aurao-0.3.1.exe` or `Aurao-Setup-0.3.2.exe`):

1. Open the official **[Microsoft Security Intelligence — Submit a file for analysis](https://www.microsoft.com/en-us/wdsi/filesubmission)** portal and sign in with a Microsoft account.
2. Select **Software developer** as your role.
3. Choose **Microsoft Defender SmartScreen** (or **Microsoft Defender Antivirus** if quarantined) and select **Incorrectly detected as malware/PUA**.
4. Upload `Aurao-0.3.1.exe` (and/or `Aurao-Setup-0.3.2.exe`).
5. Under additional details, paste:
   > Open-source GPL-3.0 desktop application (Electron + TypeScript) built reproducibly via GitHub Actions at https://github.com/badnexus/Aurao/actions. Source code and SHA-256 checksums published at https://github.com/badnexus/Aurao/releases.

---

## 2. Permanent Automated Code Signing via SignPath.io Foundation (Free for GPLv3)

[`.github/workflows/release.yml`](../.github/workflows/release.yml) is pre-wired for **SignPath.io**. Until the repository secret `SIGNPATH_API_TOKEN` is configured, the workflow gracefully skips the signing step and publishes standard builds.

### Step A — Apply for Free Open-Source Code Signing

1. Go to **[https://about.signpath.io/product/open-source](https://about.signpath.io/product/open-source)** and click **Apply now**.
2. Use the following project metadata:
   - **Project Name:** `Aurao`
   - **Project URL:** `https://badnexus.github.io/Aurao/`
   - **Source Code Repository:** `https://github.com/badnexus/Aurao`
   - **License:** `GNU General Public License v3.0 (GPL-3.0-only)`
   - **Build System:** `GitHub Actions (.github/workflows/release.yml)`
   - **Description:** Friendly desktop GUI wrapper (Electron/TypeScript) around local agentic AI CLIs (Claude Code, OpenAI Codex CLI, Google Antigravity) with visual Human-in-the-Loop approval cards.

### Step B — Configure GitHub Repository Secret & Variables

Once SignPath approves the project:

1. In SignPath, create a CI user API token and note your **Organization ID**, **Project Slug** (`aurao`), and **Signing Policy Slug** (`release-signing`).
2. In GitHub (`badnexus/Aurao` → **Settings** → **Secrets and variables** → **Actions**):
   - Add **Repository Secret**:
     - `SIGNPATH_API_TOKEN`: `<your SignPath CI user token>`
   - Add **Repository Variables**:
     - `SIGNPATH_ORGANIZATION_ID`: `<your SignPath Organization UUID>`
     - `SIGNPATH_PROJECT_SLUG`: `aurao` (optional, defaults to `aurao`)
     - `SIGNPATH_SIGNING_POLICY_SLUG`: `release-signing` (optional, defaults to `release-signing`)

On every subsequent `git push origin v*`, GitHub Actions will automatically:
1. Build `Aurao-Setup-${version}.exe` (per-user NSIS installer) and `Aurao-${version}.exe` (portable).
2. Submit both executables to SignPath.io for Authenticode signing.
3. Recompute `release/RELEASE-INFO.txt` and `release/badnexus.Aurao.yaml` with the **signed** SHA-256 hashes.
4. Publish the signed executables to GitHub Releases.
