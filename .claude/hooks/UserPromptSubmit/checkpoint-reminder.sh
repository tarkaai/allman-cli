#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
branch_slug="$(git branch --show-current 2>/dev/null | tr '/' '-')"

if [[ -z "$branch_slug" ]]; then
  exit 0
fi

session_file="$repo_root/.claude-sessions/$branch_slug/active-session.json"

if [[ ! -f "$session_file" ]]; then
  exit 0
fi

step="?"
status="unknown"
next_action="Update .claude-sessions/$branch_slug/active-session.json before switching phases."

if command -v jq >/dev/null 2>&1; then
  step="$(jq -r '.workflow.currentStep // "?"' "$session_file" 2>/dev/null || echo "?")"
  status="$(jq -r '.workflow.status // "unknown"' "$session_file" 2>/dev/null || echo "unknown")"
  next_action="$(jq -r '.workflow.nextAction // empty' "$session_file" 2>/dev/null || true)"
fi

if [[ "$status" == "completed" ]]; then
  exit 0
fi

echo "[checkpoint] Step $step ($status)"
if [[ -n "${next_action:-}" ]]; then
  echo "[checkpoint] Next action: $next_action"
fi
