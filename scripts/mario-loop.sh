#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-build}" # prd | plan | build

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/mario-paths.sh"

ROOT_DIR="$(mario_repo_root)"
cd "$ROOT_DIR"

case "$MODE" in
  prd|plan|build) ;;
  *)
    echo "Unknown mode: $MODE (expected: prd|plan|build)" >&2
    exit 2
    ;;
esac

mario_detect_paths
mario_mkdirp_core
mario_bootstrap_minimal_files
mario_load_agents

# Re-evaluate paths after loading config (MARIO_ROOT_MODE, etc.).
mario_detect_paths
mario_mkdirp_core
mario_bootstrap_minimal_files

if [[ -z "${AGENT_CMD:-}" ]]; then
  AGENT_CMD="$(mario_default_agent_cmd)" || {
    echo "Missing AGENT_CMD and unsupported AGENT='${AGENT:-}'." >&2
    echo "Set AGENT_CMD in $MARIO_AGENTS_FILE." >&2
    exit 2
  }
fi

: "${MAX_ITERATIONS:=0}" # 0 = unlimited
: "${MARIO_NO_PROGRESS_LIMIT:=3}"
: "${MARIO_REPEAT_FAIL_LIMIT:=5}"

case "$MODE" in
  build) : "${VERIFY_CMD:=$SCRIPT_DIR/verify-all.sh}" ;;
  *) : "${VERIFY_CMD:=$SCRIPT_DIR/verify.sh}" ;;
esac

prompt_template_candidates=(
  "$MARIO_PROMPTS_DIR/PROMPT_${MODE}.md"
  "prompts/PROMPT_${MODE}.md"
)

PROMPT_TEMPLATE=""
for p in "${prompt_template_candidates[@]}"; do
  if [[ -f "$p" ]]; then
    PROMPT_TEMPLATE="$p"
    break
  fi
done

if [[ -z "$PROMPT_TEMPLATE" ]]; then
  echo "Missing prompt template for mode '$MODE'." >&2
  echo "Looked for:" >&2
  for p in "${prompt_template_candidates[@]}"; do
    echo "- $p" >&2
  done
  echo "Run mario-init to bootstrap prompts into $MARIO_PROMPTS_DIR." >&2
  exit 2
fi

run_agent() {
  local prompt_file="$1"
  local raw_cmd="$2"
  local resolved

  resolved="$(mario_resolve_cmd "$raw_cmd" "$prompt_file")"
  if [[ "$raw_cmd" == *"{prompt}"* ]]; then
    bash -lc "$resolved"
    return $?
  fi

  cat "$prompt_file" | bash -lc "$resolved"
}

write_prompt() {
  local out_file="$1"

  {
    echo "# mario-devx"
    echo
    echo "Mode: $MODE"
    echo "Repo: $ROOT_DIR"
    echo
    echo "Canonical files (use these paths):"
    echo "- PRD: $MARIO_PRD_FILE"
    echo "- Specs: $MARIO_SPECS_DIR/*"
    echo "- Plan: $MARIO_PLAN_FILE"
    echo "- Agent config: $MARIO_AGENTS_FILE"
    echo "- Feedback (read first): $MARIO_FEEDBACK_FILE"
    echo "- Progress log: $MARIO_PROGRESS_FILE"
    echo "- Guardrails: $MARIO_GUARDRAILS_FILE"
    echo "- Activity log: $MARIO_ACTIVITY_LOG"
    echo "- Errors log: $MARIO_ERRORS_LOG"
    echo
    echo "---"
    echo
    cat "$PROMPT_TEMPLATE"
  } > "$out_file"
}

activity() {
  # shellcheck disable=SC2129
  printf '%s\n' "[$(date -Iseconds)] $*" >> "$MARIO_ACTIVITY_LOG" 2>/dev/null || true
}

errorlog() {
  # shellcheck disable=SC2129
  printf '%s\n' "[$(date -Iseconds)] $*" >> "$MARIO_ERRORS_LOG" 2>/dev/null || true
}

ITERATION=0
NO_PROGRESS_COUNT=0
REPEAT_FAIL_COUNT=0
LAST_FAIL_KEY=""

while true; do
  if [[ "$MAX_ITERATIONS" != "0" ]] && [[ "$ITERATION" -ge "$MAX_ITERATIONS" ]]; then
    echo "Reached MAX_ITERATIONS=$MAX_ITERATIONS" >&2
    exit 3
  fi

  ITERATION=$((ITERATION + 1))
  iter_start_epoch="$(date +%s)"
  timestamp="$(date +%Y%m%d-%H%M%S)"
  run_dir="$MARIO_RUNS_DIR/${timestamp}-${MODE}-iter${ITERATION}"
  mkdir -p "$run_dir"

  activity "start mode=$MODE iteration=$ITERATION run=$run_dir"

  before_head=""
  after_head=""

  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    before_head="$(git rev-parse HEAD 2>/dev/null || true)"
    printf '%s\n' "$before_head" > "$run_dir/git.head.before" 2>/dev/null || true
    git status --porcelain > "$run_dir/git.status.before" 2>/dev/null || true
    git diff > "$run_dir/git.diff.before" 2>/dev/null || true
  fi

  prompt_file="$run_dir/prompt.md"
  write_prompt "$prompt_file"

  echo "Running agent (mode=$MODE iteration=$ITERATION)" >&2
  agent_out="$run_dir/agent.out"
  set +e
  run_agent "$prompt_file" "$AGENT_CMD" 2>&1 | tee "$agent_out"
  agent_ec=${PIPESTATUS[0]}
  set -e
  printf '%s\n' "$agent_ec" > "$run_dir/agent.exit_code"

  if [[ "$agent_ec" != "0" ]]; then
    errorlog "agent_exit mode=$MODE iteration=$ITERATION run=$run_dir exit_code=$agent_ec"
  fi

  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    after_head="$(git rev-parse HEAD 2>/dev/null || true)"
    printf '%s\n' "$after_head" > "$run_dir/git.head.after" 2>/dev/null || true
    git status --porcelain > "$run_dir/git.status.after" 2>/dev/null || true
    git diff > "$run_dir/git.diff.after" 2>/dev/null || true
  fi

  progress=0
  if [[ -n "$before_head" && -n "$after_head" && "$before_head" != "$after_head" ]]; then
    progress=1
  elif [[ -s "$run_dir/git.status.after" ]]; then
    progress=1
  fi

  if [[ "$progress" == "0" ]]; then
    NO_PROGRESS_COUNT=$((NO_PROGRESS_COUNT + 1))
  else
    NO_PROGRESS_COUNT=0
  fi

  set +e
  MARIO_RUN_DIR="$run_dir" "$VERIFY_CMD"
  verify_ec=$?
  set -e

  verify_status="FAIL"
  if [[ "$verify_ec" == "0" ]]; then
    verify_status="PASS"
  fi

  printf '%s\n' "- $(date -Iseconds) mode=$MODE iteration=$ITERATION run=$run_dir verify=$verify_status" >> "$MARIO_PROGRESS_FILE" 2>/dev/null || true

  iter_end_epoch="$(date +%s)"
  iter_seconds=$((iter_end_epoch - iter_start_epoch))
  activity "end mode=$MODE iteration=$ITERATION run=$run_dir verify=$verify_status seconds=$iter_seconds"

  if [[ "$verify_ec" == "0" ]]; then
    exit 0
  fi

  fail_key=""
  if [[ -f "$MARIO_FEEDBACK_FILE" ]]; then
    fail_key="$(head -n 50 "$MARIO_FEEDBACK_FILE" | cksum | cut -d ' ' -f 1)"
  fi

  if [[ -n "$fail_key" && "$fail_key" == "$LAST_FAIL_KEY" ]]; then
    REPEAT_FAIL_COUNT=$((REPEAT_FAIL_COUNT + 1))
  else
    REPEAT_FAIL_COUNT=0
    LAST_FAIL_KEY="$fail_key"
  fi

  if [[ -n "$fail_key" ]]; then
    errorlog "verify_fail mode=$MODE iteration=$ITERATION run=$run_dir fail_key=$fail_key no_progress=$NO_PROGRESS_COUNT repeat_fail=$REPEAT_FAIL_COUNT"
  else
    errorlog "verify_fail mode=$MODE iteration=$ITERATION run=$run_dir (no feedback hash) no_progress=$NO_PROGRESS_COUNT repeat_fail=$REPEAT_FAIL_COUNT"
  fi

  if [[ "$NO_PROGRESS_COUNT" -ge "$MARIO_NO_PROGRESS_LIMIT" ]]; then
    echo "Halting: no progress for $NO_PROGRESS_COUNT iterations." >&2
    exit 4
  fi

  if [[ "$REPEAT_FAIL_COUNT" -ge "$MARIO_REPEAT_FAIL_LIMIT" ]]; then
    echo "Halting: same failure repeated $REPEAT_FAIL_COUNT times." >&2
    exit 5
  fi
done
