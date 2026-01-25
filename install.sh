#!/usr/bin/env bash
set -euo pipefail

# Mario DevX installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/<ref>/install.sh | bash
#
# Env:
#   MARIO_DEVX_REPO=valerio-mc/mario-devx
#   MARIO_DEVX_REF=main
#
# Flags:
#   --force   overwrite existing files

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

: "${MARIO_DEVX_REPO:=valerio-mc/mario-devx}"
: "${MARIO_DEVX_REF:=main}"

ROOT="$(pwd)"

die() {
  echo "mario-devx: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

need_cmd bash
need_cmd mkdir
need_cmd chmod

fetch() {
  local remote_path="$1"
  local dest="$2"
  local url
  url="https://raw.githubusercontent.com/${MARIO_DEVX_REPO}/${MARIO_DEVX_REF}/${remote_path}"

  need_cmd curl
  curl -fsSL "$url" -o "$dest"
}

copy_file() {
  local src="$1"
  local dest="$2"

  if [[ "$FORCE" == "0" && -e "$dest" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
}

copy_or_fetch() {
  local local_src="$1"
  local remote_path="$2"
  local dest="$3"

  # Support running the installer from a cloned mario-devx checkout.
  # In that case some sources may already be at their destination paths.
  if [[ -f "$dest" && "$local_src" == "$dest" ]]; then
    return 0
  fi

  if [[ "$FORCE" == "0" && -e "$dest" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "$dest")"

  if [[ -f "$local_src" ]]; then
    cp "$local_src" "$dest"
  else
    fetch "$remote_path" "$dest"
  fi
}

mkdir -p \
  ".mario/specs" \
  ".mario/state" \
  ".mario/prompts" \
  ".mario/scripts"

# templates -> .mario
copy_or_fetch "templates/PRD.md" "templates/PRD.md" ".mario/PRD.md"
copy_or_fetch "templates/AGENTS.md" "templates/AGENTS.md" ".mario/AGENTS.md"
copy_or_fetch "templates/IMPLEMENTATION_PLAN.md" "templates/IMPLEMENTATION_PLAN.md" ".mario/IMPLEMENTATION_PLAN.md"
copy_or_fetch "templates/progress.md" "templates/progress.md" ".mario/progress.md"
copy_or_fetch "templates/state/feedback.md" "templates/state/feedback.md" ".mario/state/feedback.md"
copy_or_fetch "templates/mario.gitignore" "templates/mario.gitignore" ".mario/.gitignore"

# prompts -> .mario/prompts
copy_or_fetch "prompts/PROMPT_prd.md" "prompts/PROMPT_prd.md" ".mario/prompts/PROMPT_prd.md"
copy_or_fetch "prompts/PROMPT_plan.md" "prompts/PROMPT_plan.md" ".mario/prompts/PROMPT_plan.md"
copy_or_fetch "prompts/PROMPT_build.md" "prompts/PROMPT_build.md" ".mario/prompts/PROMPT_build.md"
copy_or_fetch "prompts/PROMPT_verify_llm.md" "prompts/PROMPT_verify_llm.md" ".mario/prompts/PROMPT_verify_llm.md"


# entrypoint shim -> project root
copy_or_fetch "mario" "mario" "mario"

# scripts -> .mario/scripts/
copy_or_fetch "scripts/mario-loop.sh" "scripts/mario-loop.sh" ".mario/scripts/mario-loop.sh"
copy_or_fetch "scripts/mario-paths.sh" "scripts/mario-paths.sh" ".mario/scripts/mario-paths.sh"
copy_or_fetch "scripts/verify.sh" "scripts/verify.sh" ".mario/scripts/verify.sh"
copy_or_fetch "scripts/verify-all.sh" "scripts/verify-all.sh" ".mario/scripts/verify-all.sh"
copy_or_fetch "scripts/verify-llm.sh" "scripts/verify-llm.sh" ".mario/scripts/verify-llm.sh"
copy_or_fetch "scripts/mario" "scripts/mario" ".mario/scripts/mario"

chmod +x \
  "mario" \
  ".mario/scripts/mario" \
  ".mario/scripts/mario-loop.sh" \
  ".mario/scripts/mario-paths.sh" \
  ".mario/scripts/verify.sh" \
  ".mario/scripts/verify-all.sh" \
  ".mario/scripts/verify-llm.sh" || true

echo "Mario DevX installed into: $ROOT" >&2
echo "Next:" >&2
echo "  - set quality gates in .mario/PRD.md (recommended)" >&2
echo "  - run: ./mario prd" >&2
