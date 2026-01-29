# AGENTS

# Controls
AUTO_COMMIT=1
AUTO_PUSH=0
HITL_REQUIRED=0

# UI verification (optional)
# When enabled, `/mario-devx:verify` will also validate the UI using `agent-browser`.
# Repo: https://github.com/vercel-labs/agent-browser
UI_VERIFY=0
UI_VERIFY_REQUIRED=0
UI_VERIFY_CMD='npm run dev'
UI_VERIFY_URL='http://localhost:3000'
AGENT_BROWSER_REPO='https://github.com/vercel-labs/agent-browser'

# Storage
# - Default: keep mario-devx artifacts in `.mario/`.
# - Set MARIO_ROOT_MODE=1 to use legacy repo-root locations.
MARIO_DIR=.mario
MARIO_ROOT_MODE=0

# Agent runner (OpenCode plugin)
# The plugin always uses the current OpenCode session + agent.
# These fields are kept for legacy compatibility only.
AGENT=opencode
AGENT_CMD=

# LLM verifier
# The plugin runs deterministic checks, then this verifier.
# Set MARIO_LLM_VERIFY=0 to disable the LLM verifier.
MARIO_LLM_VERIFY=1

# If unset, defaults to AGENT_CMD.
# Consider using a different model/provider for "third LLM" supervision.
LLM_VERIFY_CMD=

# Loop safety
MARIO_NO_PROGRESS_LIMIT=3
MARIO_REPEAT_FAIL_LIMIT=5

# Backpressure commands (optional overrides)
# Source of truth is `## Quality Gates` in PRD.md.
# If PRD has no quality gates yet, the harness will attempt to auto-detect and persist `CMD_*` here.
CMD_LINT=
CMD_TYPECHECK=
CMD_TEST=
CMD_BUILD=

# Notes
# Keep this file operational. Requirements and planning belong in PRD.md / IMPLEMENTATION_PLAN.md.
