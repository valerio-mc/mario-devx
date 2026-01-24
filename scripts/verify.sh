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

LOG_DIR=""
if [[ -n "${MARIO_RUN_DIR:-}" ]]; then
  LOG_DIR="$MARIO_RUN_DIR/verify"
else
  LOG_DIR="$MARIO_STATE_DIR/state/verify"
fi
mkdir -p "$LOG_DIR"

write_feedback_fail() {
  local reason="$1"
  {
    echo "Status: FAIL"
    echo "Reason:"
    echo "- $reason"
    echo "Next actions:"
    echo "- Fix the issue and re-run the loop"
  } > "$MARIO_FEEDBACK_FILE"
}

write_feedback_pass() {
  {
    echo "Status: PASS"
    echo "Reason:"
    echo "- Deterministic checks passed"
    echo "Next actions:"
    echo "- Proceed to the next plan item"
  } > "$MARIO_FEEDBACK_FILE"
}

run_cmd() {
  local label="$1"
  local cmd="$2"
  local log_file="$LOG_DIR/${label}.log"

  if [[ -z "$cmd" ]]; then
    return 0
  fi

  echo "Running: $label" >&2
  set +e
  bash -lc "$cmd" 2>&1 | tee "$log_file" >&2
  local ec=${PIPESTATUS[0]}
  set -e

  if [[ "$ec" != "0" ]]; then
    write_feedback_fail "$label failed (exit $ec): $cmd"
    return 1
  fi
}

: "${HITL_REQUIRED:=0}"
if [[ "$HITL_REQUIRED" == "1" ]]; then
  write_feedback_fail "Human verification required (HITL_REQUIRED=1)"
  exit 1
fi

run_cmd "lint" "${CMD_LINT:-}" || exit 1
run_cmd "typecheck" "${CMD_TYPECHECK:-}" || exit 1
run_cmd "tests" "${CMD_TEST:-}" || exit 1
run_cmd "build" "${CMD_BUILD:-}" || exit 1

write_feedback_pass
exit 0
