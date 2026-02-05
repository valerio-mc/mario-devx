# mario-devx AGENTS

# This file is parsed as `KEY=VALUE` lines.
# - Lines starting with `#` are comments.
# - Values may be quoted with single or double quotes.

## Controls

# If enabled, the build agent may create commits after gates+judge pass.
AUTO_COMMIT=1

# If enabled and a remote exists, the build agent may push.
AUTO_PUSH=0

# If deterministic verification is not possible, set this to 1.
HITL_REQUIRED=0

## UI verification (best-effort)

# When enabled, `/mario-devx:run` may validate the UI using `agent-browser`.
# Repo: https://github.com/vercel-labs/agent-browser
UI_VERIFY=0

# If set to 1, missing prerequisites become a hard failure.
UI_VERIFY_REQUIRED=0

UI_VERIFY_CMD='npm run dev'
UI_VERIFY_URL='http://localhost:3000'
AGENT_BROWSER_REPO='https://github.com/vercel-labs/agent-browser'

## Backpressure overrides (optional)

# Source of truth is `qualityGates` in `.mario/prd.json`.
# If you set any `CMD_*` below, the build agent may treat them as additional gates.
CMD_LINT=
CMD_TYPECHECK=
CMD_TEST=
CMD_BUILD=

## Notes

# Keep this file operational. Requirements and tasks belong in `.mario/prd.json`.
