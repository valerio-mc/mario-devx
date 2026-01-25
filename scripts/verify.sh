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

extract_prd_quality_gates() {
  local prd_file="$1"
  local in_section=0
  local line
  local cmds=()

  [[ -f "$prd_file" ]] || return 0

  while IFS= read -r line; do
    if [[ "$in_section" == "0" ]]; then
      if [[ "$line" == "## Quality Gates" ]]; then
        in_section=1
      fi
      continue
    fi

    # Stop at next H2 section.
    if [[ "$line" == "## "* ]]; then
      break
    fi

    # Only consider list items.
    if [[ "$line" =~ ^[[:space:]]*-[[:space:]]+(.+)$ ]]; then
      local item="${BASH_REMATCH[1]}"

      # Extract all `...` inline code spans.
      local had_code_span=0
      local tmp="$item"
      while [[ "$tmp" =~ \`([^\`]*)\` ]]; do
        had_code_span=1
        local cmd="${BASH_REMATCH[1]}"
        if [[ -n "$cmd" && "$cmd" != "TODO"* ]]; then
          cmds+=("$cmd")
        fi
        tmp="${tmp#*\`}"  # remove up to first backtick
        tmp="${tmp#*\`}"  # remove up to second backtick
      done

      # If the list item is plain text (no backticks), treat it as a command.
      if [[ "$had_code_span" == "0" ]]; then
        shopt -s nocasematch
        if [[ "$item" == TODO* || "$item" == *"example"* ]]; then
          :
        else
          cmds+=("$item")
        fi
        shopt -u nocasematch
      fi
    fi
  done < "$prd_file"

  if [[ ${#cmds[@]} -gt 0 ]]; then
    printf '%s\n' "${cmds[@]}"
  fi
}

shell_quote_single() {
  # Wrap a string in single quotes for shell assignment.
  # foo'bar -> 'foo'\''bar'
  local s="$1"
  printf "'%s'" "${s//\'/\'\\\'\'}"
}

set_agents_var() {
  local var="$1"
  local value="$2"
  local q
  q="$(shell_quote_single "$value")"

  [[ -n "$MARIO_AGENTS_FILE" ]] || return 1
  [[ -f "$MARIO_AGENTS_FILE" ]] || return 1

  local tmp
  tmp="${MARIO_AGENTS_FILE}.tmp.$$"
  local found=0

  while IFS= read -r line; do
    if [[ "$line" =~ ^${var}= ]]; then
      printf '%s=%s\n' "$var" "$q" >> "$tmp"
      found=1
    else
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < "$MARIO_AGENTS_FILE"

  if [[ "$found" == "0" ]]; then
    printf '%s=%s\n' "$var" "$q" >> "$tmp"
  fi

  mv "$tmp" "$MARIO_AGENTS_FILE"
}

detect_node_pm() {
  if [[ -f pnpm-lock.yaml ]]; then
    printf '%s\n' pnpm
    return 0
  fi
  if [[ -f bun.lockb || -f bun.lock ]]; then
    printf '%s\n' bun
    return 0
  fi
  if [[ -f yarn.lock ]]; then
    printf '%s\n' yarn
    return 0
  fi
  printf '%s\n' npm
}

node_has_script() {
  local script="$1"

  command -v node >/dev/null 2>&1 || return 1
  [[ -f package.json ]] || return 1

  node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); const s=(pkg.scripts||{}); process.exit(s[process.argv[1]]?0:1);' "$script"
}

node_run_cmd() {
  local pm="$1"
  local script="$2"

  case "$pm" in
    pnpm) printf '%s\n' "pnpm $script" ;;
    yarn) printf '%s\n' "yarn $script" ;;
    bun) printf '%s\n' "bun run $script" ;;
    npm|*) printf '%s\n' "npm run $script" ;;
  esac
}

autodetect_backpressure() {
  # Output lines: VAR=CMD (no quoting)
  # Only emits vars we can confidently set.

  # Node
  if [[ -f package.json ]]; then
    local pm
    pm="$(detect_node_pm)"

    if node_has_script lint; then
      printf '%s\n' "CMD_LINT=$(node_run_cmd "$pm" lint)"
    fi
    if node_has_script typecheck; then
      printf '%s\n' "CMD_TYPECHECK=$(node_run_cmd "$pm" typecheck)"
    fi
    if node_has_script test; then
      printf '%s\n' "CMD_TEST=$(node_run_cmd "$pm" test)"
    fi
    if node_has_script build; then
      printf '%s\n' "CMD_BUILD=$(node_run_cmd "$pm" build)"
    fi

    return 0
  fi

  # Rust
  if [[ -f Cargo.toml ]]; then
    printf '%s\n' "CMD_LINT=cargo fmt --check"
    printf '%s\n' "CMD_TYPECHECK=cargo clippy -- -D warnings"
    printf '%s\n' "CMD_TEST=cargo test"
    printf '%s\n' "CMD_BUILD=cargo build"
    return 0
  fi

  # Go
  if [[ -f go.mod ]]; then
    printf '%s\n' "CMD_TEST=go test ./..."
    printf '%s\n' "CMD_BUILD=go build ./..."
    return 0
  fi

  # Python (minimal)
  if [[ -f pyproject.toml || -f requirements.txt || -f requirements-dev.txt ]]; then
    if command -v pytest >/dev/null 2>&1; then
      printf '%s\n' "CMD_TEST=pytest"
    else
      printf '%s\n' "CMD_TEST=python -m pytest"
    fi
    return 0
  fi
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

# 1) PRD-driven backpressure (preferred)
prd_gates=()
while IFS= read -r cmd; do
  [[ -n "$cmd" ]] || continue
  prd_gates+=("$cmd")
done < <(extract_prd_quality_gates "$MARIO_PRD_FILE" || true)
if [[ ${#prd_gates[@]} -gt 0 ]]; then
  idx=0
  for cmd in "${prd_gates[@]}"; do
    idx=$((idx + 1))
    run_cmd "quality_gate_${idx}" "$cmd" || exit 1
  done
  write_feedback_pass
  exit 0
fi

# 2) AGENTS overrides (explicit)
has_agents_cmds=0
for v in "${CMD_LINT:-}" "${CMD_TYPECHECK:-}" "${CMD_TEST:-}" "${CMD_BUILD:-}"; do
  if [[ -n "$v" ]]; then
    has_agents_cmds=1
    break
  fi
done

if [[ "$has_agents_cmds" == "1" ]]; then
  run_cmd "lint" "${CMD_LINT:-}" || exit 1
  run_cmd "typecheck" "${CMD_TYPECHECK:-}" || exit 1
  run_cmd "tests" "${CMD_TEST:-}" || exit 1
  run_cmd "build" "${CMD_BUILD:-}" || exit 1
  write_feedback_pass
  exit 0
fi

# 3) Autodetect (fallback) + persist into AGENTS
detected=()
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  detected+=("$line")
done < <(autodetect_backpressure || true)

if [[ ${#detected[@]} -gt 0 ]]; then
  for kv in "${detected[@]}"; do
    var="${kv%%=*}"
    val="${kv#*=}"
    case "$var" in
      CMD_LINT|CMD_TYPECHECK|CMD_TEST|CMD_BUILD)
        set_agents_var "$var" "$val" || true
        ;;
    esac
  done

  # Reload so we run exactly what we wrote.
  mario_load_agents

  run_cmd "lint" "${CMD_LINT:-}" || exit 1
  run_cmd "typecheck" "${CMD_TYPECHECK:-}" || exit 1
  run_cmd "tests" "${CMD_TEST:-}" || exit 1
  run_cmd "build" "${CMD_BUILD:-}" || exit 1
  write_feedback_pass
  exit 0
fi

# 4) Hard fail: no backpressure configured
write_feedback_fail "No backpressure configured. Add commands under '## Quality Gates' in $MARIO_PRD_FILE, or set CMD_* in $MARIO_AGENTS_FILE."
exit 1

write_feedback_pass
exit 0
