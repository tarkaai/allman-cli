#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
branch_slug="$(git branch --show-current 2>/dev/null | tr '/' '-')"

if [[ -z "$branch_slug" ]]; then
  exit 0
fi

sessions_dir="$repo_root/.claude-sessions/$branch_slug"
session_file="$sessions_dir/active-session.json"

mkdir -p "$sessions_dir"

if [[ ! -f "$session_file" ]]; then
  exit 0
fi

ts="$(date -u +"%Y%m%dT%H%M%SZ")"
session_snapshot="$sessions_dir/active-session.precompact-$ts.json"
cp "$session_file" "$session_snapshot"

if command -v jq >/dev/null 2>&1; then
  plan_file="$(jq -r '.plan.implementationPlan // .plan.sessionPlan // .plan.file // empty' "$session_file" 2>/dev/null || true)"
  # Resolve relative paths against the repo root
  if [[ -n "$plan_file" && "$plan_file" != /* ]]; then
    plan_file="$repo_root/$plan_file"
  fi
  if [[ -n "$plan_file" && -f "$plan_file" ]]; then
    plan_base="$(basename "$plan_file" .md)"
    cp "$plan_file" "$sessions_dir/$plan_base.precompact-$ts.md"
  fi
fi

echo "[precompact] Saved session snapshot: $session_snapshot"
