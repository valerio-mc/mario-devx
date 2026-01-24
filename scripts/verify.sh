#!/usr/bin/env bash
set -euo pipefail

mkdir -p state

load_agents() {
  if [[ ! -f AGENTS.md ]]; then
    return 0
  fi

  while IFS= read -r line; do
    case "$line" in
      AUTO_COMMIT=*|AUTO_PUSH=*|HITL_REQUIRED=*|CMD_*=*)
        export "$line"
        ;;
    esac
  done < AGENTS.md
}

write_feedback_fail() {
  local reason="$1"
  {
    echo "Status: FAIL"
    echo "Reason:"
    echo "- $reason"
    echo "Next actions:"
    echo "- Fix the issue and re-run the loop"
  } > state/feedback.md
}

write_feedback_pass() {
  {
    echo "Status: PASS"
    echo "Reason:"
    echo "- Deterministic checks passed"
    echo "Next actions:"
    echo "- Proceed to the next brick"
  } > state/feedback.md
}

run_cmd() {
  local label="$1"
  local cmd="$2"

  if [[ -z "$cmd" ]]; then
    return 0
  fi

  echo "Running: $label" >&2
  bash -lc "$cmd" || {
    write_feedback_fail "$label failed: $cmd"
    return 1
  }
}

load_agents

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
