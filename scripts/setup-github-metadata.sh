#!/usr/bin/env bash
# Configures GitHub repository description, homepage URL, topics, and features for badnexus/Aurao.
# Usage:
#   ./scripts/setup-github-metadata.sh
# Requires either `gh` CLI (authenticated) or `GITHUB_TOKEN` env var with `repo` scope.

set -euo pipefail

REPO="badnexus/Aurao"
HOMEPAGE="https://badnexus.github.io/Aurao/"
DESCRIPTION="Your friendly, safe desktop GUI for autonomous AI agents (Claude Code, OpenAI Codex CLI, Google Antigravity) — with 1-click file approval cards and zero terminal jargon."

TOPICS=(
  "ai-agents"
  "claude-code"
  "openai-codex"
  "antigravity"
  "electron"
  "desktop-app"
  "local-ai"
  "human-in-the-loop"
  "file-organizer"
  "typescript"
  "gui"
  "agentic-ai"
  "productivity"
  "windows"
  "open-source"
)

if command -v gh >/dev/null 2>&1; then
  echo "Configuring $REPO via GitHub CLI (gh)..."
  TOPIC_ARGS=()
  for t in "${TOPICS[@]}"; do
    TOPIC_ARGS+=("--add-topic" "$t")
  done
  gh repo edit "$REPO" \
    --description "$DESCRIPTION" \
    --homepage "$HOMEPAGE" \
    --enable-discussions \
    --enable-issues \
    "${TOPIC_ARGS[@]}"
  echo "✅ Repository metadata and topics updated via gh."
elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
  echo "Configuring $REPO via GitHub REST API..."
  curl -fsSL -X PATCH "https://api.github.com/repos/$REPO" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "{\"description\":\"$DESCRIPTION\",\"homepage\":\"$HOMEPAGE\",\"has_issues\":true,\"has_discussions\":true}" >/dev/null

  TOPICS_JSON=$(printf '"%s",' "${TOPICS[@]}")
  TOPICS_JSON="[${TOPICS_JSON%,}]"
  curl -fsSL -X PUT "https://api.github.com/repos/$REPO/topics" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "{\"names\":$TOPICS_JSON}" >/dev/null
  echo "✅ Repository metadata and topics updated via GitHub API."
else
  echo "ℹ️ Neither authenticated 'gh' CLI nor GITHUB_TOKEN found."
  echo "Run this script with GITHUB_TOKEN=<token> ./scripts/setup-github-metadata.sh"
fi
