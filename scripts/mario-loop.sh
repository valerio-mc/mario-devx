#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-build}" # prd | plan | build

case "$MODE" in
  prd) PROMPT_FILE="prompts/PROMPT_prd.md" ;;
  plan) PROMPT_FILE="prompts/PROMPT_plan.md" ;;
  build) PROMPT_FILE="prompts/PROMPT_build.md" ;;
  *)
    echo "Unknown mode: $MODE (expected: prd|plan|build)" >&2
    exit 2
    ;;
esac

mkdir -p specs state

: "${MAX_ITERATIONS:=0}"     # 0 = unlimited
: "${OPENCODE_FORMAT:=json}" # default|json
: "${OPENCODE_MODEL:=}"      # optional provider/model
: "${OPENCODE_AGENT:=}"      # optional agent name
: "${VERIFY_CMD:=./scripts/verify.sh}" # exit 0=done, 1=continue

if [[ ! -f PRD.md ]]; then
  if [[ -f templates/PRD.md ]]; then
    cp templates/PRD.md PRD.md
  else
    printf '%s\n' '# PRD' > PRD.md
  fi
fi

if [[ ! -f AGENTS.md ]]; then
  if [[ -f templates/AGENTS.md ]]; then
    cp templates/AGENTS.md AGENTS.md
  else
    printf '%s\n' '# AGENTS' > AGENTS.md
  fi
fi

if [[ ! -f IMPLEMENTATION_PLAN.md ]]; then
  if [[ -f templates/IMPLEMENTATION_PLAN.md ]]; then
    cp templates/IMPLEMENTATION_PLAN.md IMPLEMENTATION_PLAN.md
  else
    printf '%s\n' '# IMPLEMENTATION PLAN' > IMPLEMENTATION_PLAN.md
  fi
fi

if [[ ! -f state/feedback.md ]]; then
  printf '%s\n' 'Status: NONE' > state/feedback.md
fi

ITERATION=0
while true; do
  if [[ "$MAX_ITERATIONS" != "0" ]] && [[ "$ITERATION" -ge "$MAX_ITERATIONS" ]]; then
    echo "Reached MAX_ITERATIONS=$MAX_ITERATIONS" >&2
    exit 3
  fi

  ITERATION=$((ITERATION + 1))
  mkdir -p state

  ATTACH=(
    -f "AGENTS.md"
    -f "PRD.md"
    -f "IMPLEMENTATION_PLAN.md"
    -f "state/feedback.md"
    -f "$PROMPT_FILE"
  )

  shopt -s nullglob
  SPEC_FILES=(specs/*.md)
  shopt -u nullglob
  if [[ ${#SPEC_FILES[@]} -gt 0 ]]; then
    for f in "${SPEC_FILES[@]}"; do
      ATTACH+=( -f "$f" )
    done
  fi

  RUN_ARGS=(run --format "$OPENCODE_FORMAT")
  if [[ -n "$OPENCODE_MODEL" ]]; then
    RUN_ARGS+=(--model "$OPENCODE_MODEL")
  fi
  if [[ -n "$OPENCODE_AGENT" ]]; then
    RUN_ARGS+=(--agent "$OPENCODE_AGENT")
  fi

  opencode "${RUN_ARGS[@]}" "${ATTACH[@]}" "$(cat "$PROMPT_FILE")" | tee "state/last_run.$OPENCODE_FORMAT"

  if "$VERIFY_CMD"; then
    exit 0
  fi
done
