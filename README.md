# 👾 Mario DevX

<img align="right" src="mario_devx.png" alt="Mario DevX" width="256" />

Named after Super Mario because (1) it never stops running, (2) it repeatedly smashes its face into the same level until it learns where the invisible blocks are, and (3) because Italians always do it better 🇮🇹.

**Mario DevX** is an OpenCode plugin that runs Ralph-style, file-based, deterministic agent loops inside the OpenCode TUI.

## Motivations

Coding agents are great until the chat becomes the product: long threads, stale assumptions, and "it passed on vibes".

Mario DevX forces the only kind of memory that actually helps:
1. Put the truth on disk (`.mario/`), not in the chat.
2. Ship in small slices (one plan item per iteration).
3. Add backpressure (quality gates + strict judge) so the loop stops when it should.

## Commands

```
/mario-devx:new <idea>    # PRD interview -> plan
/mario-devx:run <N>       # build + gates + judge for the next N plan items
/mario-devx:status        # what's running + latest verdict path + next action
/mario-devx:doctor        # healthcheck + concrete fixes
```

## First run

Important: do this inside a git repo.

1) Create a repo

```bash
mkdir my-project && cd my-project && git init
```

2) Copy the plugin into your project

```bash
mkdir -p .opencode/plugins
tmpdir="$(mktemp -d)" && \
  curl -fsSL https://github.com/valerio-mc/mario-devx/archive/refs/heads/main.tar.gz | tar -xz -C "$tmpdir" && \
  cp -R "$tmpdir"/mario-devx-main/.opencode/plugins/mario-devx ./.opencode/plugins/ && \
  cp "$tmpdir"/mario-devx-main/.opencode/plugins/mario-devx.ts ./.opencode/plugins/ && \
  cp "$tmpdir"/mario-devx-main/.opencode/package.json ./.opencode/
```

3) Start OpenCode

```bash
opencode .
```

4) Bootstrap

```
/mario-devx:new my brilliant idea
```

Open `/sessions` and jump into `mario-devx (work)` to answer the PRD interview.

When the PRD is complete, mario-devx starts planning in the same work session. Wait for the work session to go idle before running `/mario-devx:run`.

## Usage

### Sessions (or suffer)

- You run `/mario-devx:*` in your normal session (control session).
- The PRD/planning/build/judge work runs in a persistent per-repo work session: `mario-devx (work)`.
- Most work is async: trigger in the control session, open `/sessions` to watch.

### The loop

1) Set your Quality Gates in `.mario/PRD.md` under `## Quality Gates` (commands only, wrap them in backticks).
2) Run one iteration:

```
/mario-devx:run 1
```

If planning is still running (or the plan is still a template), `/mario-devx:run` will refuse to execute.

To keep going:

```
/mario-devx:run 5
```

If it stops, the answer is in the latest verdict.

```
/mario-devx:status
```

Note: nothing runs code until you call `/mario-devx:run`.

## What gets created

In your project:

```text
.mario/
  PRD.md                    # product spec + Quality Gates + Frontend: yes|no
  IMPLEMENTATION_PLAN.md     # execution queue (PI-0001...) with TODO/DOING/DONE/BLOCKED
  AGENTS.md                  # harness knobs (UI_VERIFY*, CMD_*, etc)
  state/state.json           # internal state (iteration, run status, work session ids, latestVerdictPath)
  runs/*                     # evidence per run (gates.log/json, judge.out, optional ui-verify.log)
```

In this repo:

```text
.opencode/plugins/mario-devx/   # OpenCode plugin source + assets
```

## Backpressure (definition of done)

- Source of truth: `## Quality Gates` in `.mario/PRD.md`.
- Fallback: if you forgot, mario-devx auto-detects common scripts (Node) and a few sane defaults (Go/Rust/Python), and only persists them to `.mario/AGENTS.md` when they were auto-detected.

### UI verification (frontends)

If your PRD includes `Frontend: yes`, mario-devx enables best-effort UI verification by default:
- `UI_VERIFY=1`
- `UI_VERIFY_REQUIRED=0`

How it works:
- Starts your dev server (`UI_VERIFY_CMD`) and drives a real browser at `UI_VERIFY_URL` using Vercel's `agent-browser` (Playwright-based).
- Writes evidence under `.mario/runs/*` (look for `ui-verify.log`).

If prerequisites are missing, UI verify is skipped unless you set `UI_VERIFY_REQUIRED=1`.

## Verifier output

The judge writes to `.mario/runs/*/judge.out`:

```text
Status: PASS|FAIL
EXIT_SIGNAL: true|false
Reason:
- ...
Next actions:
- ...
```

## Git hygiene

If you don't want run artifacts or internal state in git, add this to your repo `.gitignore`:

```gitignore
.mario/runs/
.mario/state/
```

## Troubleshooting

- Quality Gates failing instantly: in `.mario/PRD.md` under `## Quality Gates`, only backticked commands are executed.
- Plan generation looks like slop: `.mario/IMPLEMENTATION_PLAN.md` must not contain placeholders like `[...]` or `TODO: fill later`. Rerun `/mario-devx:new`.
- Where is it running: open `/sessions` and jump into `mario-devx (work)`.
- UI verify doesn't run: install prerequisites (`npx skills add vercel-labs/agent-browser`, and `npm install -g agent-browser && agent-browser install`) and check `.mario/AGENTS.md`.
- Still confused: run `/mario-devx:doctor`.

## Acknowledgements

- [Geoffrey Huntley + playbook](https://github.com/ghuntley/how-to-ralph-wiggum)
- [Resource index](https://github.com/snwfdhmp/awesome-ralph)
- [agent-browser (Vercel)](https://github.com/vercel-labs/agent-browser)

## License

MIT. See `LICENSE`.
