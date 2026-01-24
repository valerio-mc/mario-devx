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

: "${MARIO_LLM_VERIFY:=1}"

"$SCRIPT_DIR/verify.sh"

if [[ "$MARIO_LLM_VERIFY" == "0" ]]; then
  exit 0
fi

"$SCRIPT_DIR/verify-llm.sh"

status_line=""
if [[ -f "$MARIO_FEEDBACK_FILE" ]]; then
  status_line="$(head -n 1 "$MARIO_FEEDBACK_FILE" | tr -d '\r' || true)"
fi

if [[ "$status_line" == "Status: PASS" ]]; then
  exit 0
fi

exit 1
