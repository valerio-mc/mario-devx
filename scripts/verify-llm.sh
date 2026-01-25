#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/mario-paths.sh"

ROOT_DIR="$(mario_repo_root)"
cd "$ROOT_DIR"

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

LLM_VERIFY_CMD="${LLM_VERIFY_CMD:-${AGENT_CMD}}"
if [[ -z "$LLM_VERIFY_CMD" ]]; then
  echo "Missing LLM_VERIFY_CMD and AGENT_CMD." >&2
  exit 2
fi

prompt_template_candidates=(
  "$MARIO_PROMPTS_DIR/PROMPT_verify_llm.md"
  "prompts/PROMPT_verify_llm.md"
)

PROMPT_TEMPLATE=""
for p in "${prompt_template_candidates[@]}"; do
  if [[ -f "$p" ]]; then
    PROMPT_TEMPLATE="$p"
    break
  fi
done

if [[ -z "$PROMPT_TEMPLATE" ]]; then
  echo "Missing verifier prompt template." >&2
  for p in "${prompt_template_candidates[@]}"; do
    echo "- $p" >&2
  done
  exit 2
fi

LOG_DIR=""
if [[ -n "${MARIO_RUN_DIR:-}" ]]; then
  LOG_DIR="$MARIO_RUN_DIR/verify-llm"
else
  LOG_DIR="$MARIO_STATE_DIR/state/verify-llm"
fi
mkdir -p "$LOG_DIR"

git_status_file="$LOG_DIR/git.status"
git_diff_file="$LOG_DIR/git.diff"

git status --porcelain > "$git_status_file" 2>/dev/null || true
git diff > "$git_diff_file" 2>/dev/null || true

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

rendered_prompt="$LOG_DIR/prompt.md"
{
  echo "# mario-devx LLM verifier"
  echo
  echo "Repo: $ROOT_DIR"
  echo
  echo "Canonical files:"
  echo "- PRD: $MARIO_PRD_FILE"
  echo "- Specs: $MARIO_SPECS_DIR/*"
  echo "- Plan: $MARIO_PLAN_FILE"
  echo "- Agent config: $MARIO_AGENTS_FILE"
  echo
  echo "Precomputed context:"
  echo "- Git status: $git_status_file"
  echo "- Git diff: $git_diff_file"
  echo
  echo "---"
  echo
  cat "$PROMPT_TEMPLATE"
} > "$rendered_prompt"

raw_out="$LOG_DIR/out.raw"
set +e
run_agent "$rendered_prompt" "$LLM_VERIFY_CMD" 2>&1 | tee "$raw_out"
agent_ec=${PIPESTATUS[0]}
set -e

if [[ "$agent_ec" != "0" ]]; then
  {
    echo "Status: FAIL"
    echo "Reason:"
    echo "- Verifier command failed (exit $agent_ec)"
    echo "Next actions:"
    echo "- Inspect verifier output in $raw_out"
  } > "$MARIO_FEEDBACK_FILE"
  exit 1
fi

extract_status_block() {
  local in_file="$1"
  local out_file="$2"
  local found=0

  while IFS= read -r line; do
    if [[ "$found" == "0" ]]; then
      case "$line" in
        "Status: PASS"|"Status: FAIL")
          found=1
          printf '%s\n' "$line" > "$out_file"
          ;;
      esac
      continue
    fi

    printf '%s\n' "$line" >> "$out_file"
  done < "$in_file"

  [[ "$found" == "1" ]]
}

tmp_feedback="$LOG_DIR/feedback.extracted"
if ! extract_status_block "$raw_out" "$tmp_feedback"; then
  {
    echo "Status: FAIL"
    echo "Reason:"
    echo "- Verifier output did not contain a 'Status: PASS|FAIL' line"
    echo "Next actions:"
    echo "- Fix the verifier prompt or command"
    echo "- Inspect raw output in $raw_out"
  } > "$MARIO_FEEDBACK_FILE"
  exit 1
fi

cp "$tmp_feedback" "$MARIO_FEEDBACK_FILE"

exit_signal=""
exit_signal_line="$(grep -E '^EXIT_SIGNAL:' "$MARIO_FEEDBACK_FILE" | head -n 1 | tr -d '\r' || true)"
case "$exit_signal_line" in
  "EXIT_SIGNAL: true") exit_signal="true" ;;
  "EXIT_SIGNAL: false") exit_signal="false" ;;
esac

status_line="$(head -n 1 "$MARIO_FEEDBACK_FILE" | tr -d '\r' || true)"
if [[ "$status_line" == "Status: PASS" ]]; then
  if [[ "$exit_signal" == "true" ]]; then
    exit 0
  fi

  {
    echo "Status: FAIL"
    echo "EXIT_SIGNAL: false"
    echo "Reason:"
    echo "- Verifier returned PASS but did not set EXIT_SIGNAL: true"
    echo "Next actions:"
    echo "- Update the verifier prompt and re-run"
    echo "- Inspect raw verifier output in $raw_out"
  } > "$MARIO_FEEDBACK_FILE"
  exit 1
fi

exit 1
