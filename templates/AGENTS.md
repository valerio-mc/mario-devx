# AGENTS

# Controls
AUTO_COMMIT=1
AUTO_PUSH=0
HITL_REQUIRED=0

# Storage
# - Default: keep mario-devx artifacts in `.mario/`.
# - Set MARIO_ROOT_MODE=1 to use legacy repo-root locations.
MARIO_DIR=.mario
MARIO_ROOT_MODE=0

# Agent runner
# The loop executes AGENT_CMD once per iteration.
#
# If AGENT_CMD contains `{prompt}`, it will be replaced with the prompt file path.
# If AGENT_CMD does NOT contain `{prompt}`, the prompt content will be piped via stdin.
#
# Values containing spaces must be quoted.
AGENT=opencode
AGENT_CMD='opencode run --format default "$(cat {prompt})"'

# LLM verifier
# `scripts/verify-all.sh` runs deterministic checks, then this verifier.
# Set MARIO_LLM_VERIFY=0 to disable the LLM verifier.
MARIO_LLM_VERIFY=1

# If unset, defaults to AGENT_CMD.
# Consider using a different model/provider for "third LLM" supervision.
LLM_VERIFY_CMD=

# Loop safety
MARIO_NO_PROGRESS_LIMIT=3
MARIO_REPEAT_FAIL_LIMIT=5

# Backpressure commands (optional)
# Set these to project-specific commands.
CMD_LINT=
CMD_TYPECHECK=
CMD_TEST=
CMD_BUILD=

# Notes
# Keep this file operational. Requirements and planning belong in PRD.md / IMPLEMENTATION_PLAN.md.
