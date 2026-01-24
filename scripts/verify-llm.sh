#!/usr/bin/env bash
set -euo pipefail

mkdir -p state

PROMPT_FILE="prompts/PROMPT_verify_llm.md"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Missing $PROMPT_FILE" >&2
  exit 2
fi

git status --porcelain > state/git.status 2>/dev/null || true
git diff > state/git.diff 2>/dev/null || true

: "${OPENCODE_FORMAT:=default}"
: "${OPENCODE_MODEL:=}"
: "${OPENCODE_AGENT:=}"

ATTACH=(
  -f "AGENTS.md"
  -f "PRD.md"
  -f "IMPLEMENTATION_PLAN.md"
  -f "state/git.status"
  -f "state/git.diff"
  -f "$PROMPT_FILE"
)

RUN_ARGS=(run --format "$OPENCODE_FORMAT")
if [[ -n "$OPENCODE_MODEL" ]]; then
  RUN_ARGS+=(--model "$OPENCODE_MODEL")
fi
if [[ -n "$OPENCODE_AGENT" ]]; then
  RUN_ARGS+=(--agent "$OPENCODE_AGENT")
fi

opencode "${RUN_ARGS[@]}" "${ATTACH[@]}" "$(cat "$PROMPT_FILE")" > state/feedback.md
