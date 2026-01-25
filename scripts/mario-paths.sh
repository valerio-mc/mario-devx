#!/usr/bin/env bash

# Shared helpers for mario-devx loop scripts.
#
# This file is meant to be sourced by scripts in `scripts/`.

mario_repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

mario_join() {
  local base="$1"
  local rel="$2"

  if [[ -z "$base" || "$base" == "." ]]; then
    printf '%s\n' "$rel"
    return 0
  fi

  printf '%s/%s\n' "$base" "$rel"
}

mario_detect_paths() {
  # State base directory (hidden by default).
  : "${MARIO_DIR:=.mario}"

  # Docs root selection:
  # - If any of the new `.mario/*` core docs exist, `.mario` is canonical.
  # - Else, if legacy root files exist, repo root is canonical.
  # - Else, default to `.mario`.
  if [[ "${MARIO_ROOT_MODE:-0}" == "1" ]]; then
    MARIO_DOCS_DIR="."
  elif [[ -f ".mario/PRD.md" || -f ".mario/AGENTS.md" || -f ".mario/IMPLEMENTATION_PLAN.md" || -d ".mario/specs" ]]; then
    MARIO_DOCS_DIR=".mario"
  elif [[ -f "PRD.md" || -f "AGENTS.md" || -f "IMPLEMENTATION_PLAN.md" || -d "specs" ]]; then
    MARIO_DOCS_DIR="."
  else
    MARIO_DOCS_DIR=".mario"
  fi

  MARIO_STATE_DIR="$MARIO_DIR"

  MARIO_PRD_FILE="$(mario_join "$MARIO_DOCS_DIR" "PRD.md")"
  MARIO_PLAN_FILE="$(mario_join "$MARIO_DOCS_DIR" "IMPLEMENTATION_PLAN.md")"
  MARIO_SPECS_DIR="$(mario_join "$MARIO_DOCS_DIR" "specs")"

  # Agent configuration lives in the state dir by default.
  # If a legacy root `AGENTS.md` exists and `.mario/AGENTS.md` does not, use the legacy file.
  local state_agents
  state_agents="$(mario_join "$MARIO_STATE_DIR" "AGENTS.md")"
  if [[ -f "$state_agents" || "$MARIO_DOCS_DIR" != "." ]]; then
    MARIO_AGENTS_FILE="$state_agents"
  elif [[ -f "AGENTS.md" ]]; then
    MARIO_AGENTS_FILE="AGENTS.md"
  else
    MARIO_AGENTS_FILE="$state_agents"
  fi

  MARIO_FEEDBACK_FILE="$(mario_join "$MARIO_STATE_DIR" "state/feedback.md")"
  MARIO_PROGRESS_FILE="$(mario_join "$MARIO_STATE_DIR" "progress.md")"
  MARIO_GUARDRAILS_FILE="$(mario_join "$MARIO_STATE_DIR" "guardrails.md")"
  MARIO_ACTIVITY_LOG="$(mario_join "$MARIO_STATE_DIR" "activity.log")"
  MARIO_ERRORS_LOG="$(mario_join "$MARIO_STATE_DIR" "errors.log")"
  MARIO_RUNS_DIR="$(mario_join "$MARIO_STATE_DIR" "runs")"
  MARIO_PROMPTS_DIR="$(mario_join "$MARIO_STATE_DIR" "prompts")"
}

mario_mkdirp_core() {
  mkdir -p "$MARIO_STATE_DIR/state" "$MARIO_RUNS_DIR"
  mkdir -p "$MARIO_SPECS_DIR"

  # Ensure docs dir exists if using `.mario`.
  if [[ "$MARIO_DOCS_DIR" != "." ]]; then
    mkdir -p "$MARIO_DOCS_DIR"
  fi
}

mario_bootstrap_minimal_files() {
  # Minimal defaults if the project hasn't been bootstrapped with mario-init.
  if [[ ! -f "$MARIO_PRD_FILE" ]]; then
    printf '%s\n' '# PRD' > "$MARIO_PRD_FILE"
  fi

  if [[ ! -f "$MARIO_AGENTS_FILE" ]]; then
    printf '%s\n' '# AGENTS' > "$MARIO_AGENTS_FILE"
  fi

  if [[ ! -f "$MARIO_PLAN_FILE" ]]; then
    printf '%s\n' '# IMPLEMENTATION PLAN' > "$MARIO_PLAN_FILE"
  fi

  if [[ ! -f "$MARIO_FEEDBACK_FILE" ]]; then
    printf '%s\n' 'Status: NONE' > "$MARIO_FEEDBACK_FILE"
  fi

  if [[ ! -f "$MARIO_PROGRESS_FILE" ]]; then
    printf '%s\n' '# Mario Progress' > "$MARIO_PROGRESS_FILE"
  fi

  if [[ ! -f "$MARIO_GUARDRAILS_FILE" ]]; then
    printf '%s\n' '# Guardrails' > "$MARIO_GUARDRAILS_FILE"
  fi

  if [[ ! -f "$MARIO_ACTIVITY_LOG" ]]; then
    printf '%s\n' '# Mario DevX activity log' > "$MARIO_ACTIVITY_LOG"
  fi

  if [[ ! -f "$MARIO_ERRORS_LOG" ]]; then
    printf '%s\n' '# Mario DevX errors log' > "$MARIO_ERRORS_LOG"
  fi
}

mario_load_agents_file() {
  local agents_file="$1"

  [[ -f "$agents_file" ]] || return 0

  # NOTE: Values containing spaces must be quoted in the file:
  #   AGENT_CMD='claude -p --dangerously-skip-permissions'
  #
  # We treat AGENTS.md as a shell env file (comments + assignments).
  # shellcheck disable=SC1090
  set -a
  source "$agents_file"
  set +a
}

mario_load_agents() {
  mario_load_agents_file "$MARIO_AGENTS_FILE"
}

mario_default_agent_cmd() {
  local agent="${AGENT:-opencode}"

  case "$agent" in
    claude|claude-code)
      printf '%s\n' 'claude -p --dangerously-skip-permissions'
      ;;
    codex)
      printf '%s\n' 'codex exec --yolo -'
      ;;
    opencode|opencode-run)
      # Use "default" output so the verifier can parse plain text.
      printf '%s\n' 'opencode run --format default "$(cat {prompt})"'
      ;;
    *)
      return 1
      ;;
  esac
}

mario_resolve_cmd() {
  local raw="$1"
  local prompt_file="$2"

  # If the command contains "{prompt}" we replace it with the prompt file path.
  if [[ "$raw" == *"{prompt}"* ]]; then
    printf '%s\n' "${raw//\{prompt\}/$prompt_file}"
    return 0
  fi

  printf '%s\n' "$raw"
}
