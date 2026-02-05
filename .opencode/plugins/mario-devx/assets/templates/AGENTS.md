# mario-devx AGENTS

Operational config for mario-devx.

Notes:
- The plugin parses `KEY=VALUE` lines.
- Lines starting with `#` are treated as comments.
- Values may be quoted with single or double quotes.

## Config

```dotenv
# UI verification (best-effort)
# Repo: https://github.com/vercel-labs/agent-browser
UI_VERIFY=0
UI_VERIFY_REQUIRED=0
UI_VERIFY_CMD='npm run dev'
UI_VERIFY_URL='http://localhost:3000'
AGENT_BROWSER_REPO='https://github.com/vercel-labs/agent-browser'
```
