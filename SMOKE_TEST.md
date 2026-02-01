# Smoke Test

Manual end-to-end validation for the mario-devx OpenCode plugin.

## Prereqs

- macOS or Linux
- `git`
- `opencode` installed
- For UI verification: `agent-browser` prerequisites installed (the plugin can tell you what is missing via `/mario-devx:ui-verify` or `/mario-devx:doctor`).

## 1) Setup a fresh repo

```bash
mkdir mario-smoke && cd mario-smoke && git init
mkdir -p .opencode/plugins
tmpdir="$(mktemp -d)" && \
  curl -fsSL https://github.com/valerio-mc/mario-devx/archive/refs/heads/main.tar.gz | tar -xz -C "$tmpdir" && \
  cp -R "$tmpdir"/mario-devx-main/.opencode/plugins/mario-devx ./.opencode/plugins/ && \
  cp "$tmpdir"/mario-devx-main/.opencode/plugins/mario-devx.ts ./.opencode/plugins/ && \
  cp "$tmpdir"/mario-devx-main/.opencode/package.json ./.opencode/
opencode .
```

## 2) Init

In the OpenCode TUI:

```
/mario-devx:init
```

Expected:

- `.mario/PRD.md` exists
- `.mario/AGENTS.md` exists
- `.mario/state/feedback.md` exists

## 3) PRD interview

```
/mario-devx:prd build a tiny web app
```

Expected:

- Work happens in `mario-devx (work)` (open `/sessions` to watch/answer)
- When it finishes, `.mario/PRD.md` is populated

## 4) Quality Gates

Edit `.mario/PRD.md` and ensure `## Quality Gates` contains only backticked commands.

Example (Node):

```text
## Quality Gates
- `npm test`
- `npm run lint`
```

## 5) Plan

```
/mario-devx:plan
```

Expected:

- `.mario/IMPLEMENTATION_PLAN.md` exists
- No placeholders like `[...]` / `TODO: fill later`

## 6) Draft + Approve one iteration (HITL)

Draft:

```
/mario-devx:build
```

Expected:

- `.mario/state/pending_plan.md` exists

Approve:

```
/mario-devx:approve
```

Expected:

- `.mario/state/feedback.md` updated
- A new run directory exists under `.mario/runs/*` with artifacts:
  - `prompt.md`
  - `gates.log`
  - `gates.json`
  - `judge.out`

## 7) Verify + Auto

Verify:

```
/mario-devx:verify
```

Expected:

- A new `.mario/runs/*` directory for the verifier run
- `.mario/state/feedback.md` updated

Auto (run a couple iterations):

```
/mario-devx:auto 2
```

Expected:

- Stops early on a failing gate or failing verifier
- Prints evidence pointers (run dir, `gates.log`, `judge.out`)

## 8) UI verification path (optional)

Enable:

```
/mario-devx:ui-verify
```

Expected:

- `.mario/AGENTS.md` has `UI_VERIFY=1`

Then run:

```
/mario-devx:verify
```

Expected in the verifier run dir under `.mario/runs/*`:

- `ui-verify.log`
- (often also) `ui.png`, `ui-snapshot.json`, `ui-console.json`, `ui-errors.json`

## 9) Triage helpers

- `/mario-devx:resume` should tell you the next action based on run state.
- `/mario-devx:doctor` should flag common misconfigs (non-backticked gates, missing UI prereqs, etc.).
