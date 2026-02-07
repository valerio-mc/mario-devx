# 👾 Mario DevX

<img align="right" src="mario_devx.png" alt="Mario DevX" width="256" />

Named after Super Mario because (1) it never stops running, (2) it repeatedly smashes its face into the same level until it learns where the invisible blocks are, and (3) because Italians always do it better 🇮🇹.

It does not "have a conversation" about shipping. It ships, fails a gate, reads the receipt, and tries again.
If you're looking for vibes, inspirational essays, or a 200-message thread that ends with "should work," you're in the wrong repo.

**Mario DevX** is an OpenCode plugin that runs Ralph-style, file-based, deterministic agent loops inside the OpenCode TUI.

## Why you'll like it

- Deterministic loops with on-disk state (`.mario/*`), not fragile chat memory.
- Strict verifier output (`PASS|FAIL` + next actions) so failures are actionable.
- Incremental scope management (`/mario-devx:add`, `/mario-devx:replan`) without restarting from scratch.

## Loop overview

![Mario DevX loop flowchart](mario_devx_flowchart.png)

## 30-second quickstart

```bash
mkdir my-project && cd my-project && git init
mkdir -p .opencode/plugins
tmpdir="$(mktemp -d)" && \
  curl -fsSL https://github.com/valerio-mc/mario-devx/archive/refs/heads/main.tar.gz | tar -xz -C "$tmpdir" && \
  cp -R "$tmpdir"/mario-devx-main/.opencode/plugins/mario-devx ./.opencode/plugins/ && \
  cp "$tmpdir"/mario-devx-main/.opencode/plugins/mario-devx.ts ./.opencode/plugins/ && \
  cp "$tmpdir"/mario-devx-main/.opencode/package.json ./.opencode/
opencode .
```

Then in OpenCode:

```text
/mario-devx:new your idea
/mario-devx:run 1
```

<br clear="right" />

## Motivations

Coding agents are great until the chat becomes the product: long threads, stale assumptions, and "it passed on vibes".

Mario DevX forces the only kind of memory that actually helps:
1. Put the truth on disk (`.mario/`), not in the chat.
2. Ship in small slices (one task per iteration).
3. Add backpressure (quality gates + strict judge) so the loop stops when it should.

## Commands

```
/mario-devx:new <idea>    # PRD wizard -> seeds .mario/prd.json (requirements + tasks)
/mario-devx:run <N>       # build + gates + judge for the next N tasks
/mario-devx:add <feature> # add a new feature request and decompose into new tasks
/mario-devx:replan        # regenerate open-task plan from backlog requests
/mario-devx:status        # what's running + focus task + last verdict + next action
/mario-devx:doctor        # healthcheck + concrete fixes
```

## Control vs Work session

```text
+-----------------------+        +---------------------------+        +---------------------+
| Control Session (you) |  --->  | Work Session (mario-devx) |  --->  | Canonical State     |
| (runs slash commands) |        | (build + verify + judge)  |        | (.mario/* on disk)  |
+-----------------------+        +---------------------------+        +---------------------+
```

## First run
1) **Create a repo**

```bash
mkdir my-project && cd my-project && git init
```

2) **Install the plugin files**

Use the same install command shown in **30-second quickstart**.

3) **Start OpenCode**

```bash
opencode .
```

4) **Bootstrap**

```
/mario-devx:new my brilliant idea
```

Answer the PRD interview questions in your current session using natural language.
The interviewer is intentionally strict and now captures deeper planning fields:
- target users/problems + constraints + measurable outcomes
- runnable quality gates (project-defined backpressure)
- frontend UI conceptualization (design system, visual direction, UX requirements, optional style references)
- README policy for human-readable docs

Style references can be provided as URLs and/or screenshot paths in your answers.
Mario DevX now merges style references mentioned in any interview answer (even before the dedicated UI question), so early references are retained.

Example:
- `Style references: https://linear.app, https://stripe.com, ./references/hero-layout.png`

Task decomposition is unbounded: simple ideas may generate ~5 tasks, complex ideas can generate 30+ atomic tasks.
For `mustHaveFeatures`, the interviewer now requires atomic action statements (one behavior per line) and will keep asking until they are concrete.
Answer each interview prompt directly in natural language.
Mario DevX only records what you explicitly provide in your PRD; it does not add default features on its own.

5) **Run the loop**

```
/mario-devx:run <N>
```

`N` is the maximum number of tasks to attempt in this run.
Use `/mario-devx:run 1` for tight control (recommended), or a larger number to let it continue across multiple tasks until one fails or it reaches the limit.

Typical `/run` output:

```text
Run finished. Attempted: 1. Completed: 0. Stopped early due to failure.
Task: T-0004 (blocked) - Implement: ...
Gates: 3/4 PASS
UI verify: FAIL (required)
Judge: FAIL (exit=false)
Reason: Deterministic gate failed: npm run test (exit 1).
```

## Usage

### Sessions

- You run `/mario-devx:*` in your normal session (control session).
- The build/judge runs in a persistent per-repo work session internally; you generally do not need to open it.

### The loop

1) Set your Quality Gates in `.mario/prd.json` under `qualityGates` (commands only).
2) Run one iteration:

```
/mario-devx:run 1
```

To keep going:

```
/mario-devx:run 5
```

If it stops, the answer is in the focus task's `lastAttempt` verdict.

```
/mario-devx:status
```

Note: nothing runs code until you call `/mario-devx:run`.

Task order is scaffold-first by design:
- `T-0001`: scaffold baseline
- `T-0002`: setup quality pipeline (using PRD-defined gates)
- docs task (README) when enabled
- remaining tasks: feature implementation

Scaffold nuance:
- For web/TypeScript ideas in non-empty repos, the default scaffold may be created in `app/` (not root) to avoid clobbering existing files.
- Scaffold completion accepts either `package.json` at root or `app/package.json`.
- When scaffold lands in `app/`, mario-devx runs deterministic quality gates against that workspace and defaults UI dev command to `npm --prefix app run dev`.
- `T-0002` now auto-bootstraps missing baseline scripts (for example `typecheck`, `test:e2e`) in the active workspace before retrying gates.

You can add features at any time:

```text
/mario-devx:add add CSV export and saved filters
/mario-devx:replan
```

If your `/mario-devx:add` request is too vague, mario-devx will ask a short 3-step clarification interview before generating tasks.

`/mario-devx:replan` also repairs malformed open feature tasks by canceling non-atomic fragments and regenerating clean atomic tasks from PRD/backlog.

## What gets created

In your project:

```text
.mario/
  prd.json                   # requirements + planning + tasks + backlog + verification policy
  AGENTS.md                  # harness knobs (UI_VERIFY*)
  state/state.json           # internal state (iteration, run status, work session ids)
```

In this repo:

```text
.opencode/plugins/mario-devx/   # OpenCode plugin source + assets
```

## Backpressure (definition of done)

- Source of truth: `qualityGates` in `.mario/prd.json`.

If you leave `qualityGates` empty, `/mario-devx:run` will refuse to run.

### UI verification (frontends)

If `.mario/prd.json` has `frontend: true`, mario-devx asks during PRD interview whether UI verification should be required.

When enabled, mario-devx sets:
- `UI_VERIFY=1`
- `UI_VERIFY_REQUIRED=1` or `0` (from PRD answer)

How it works:
- Starts your dev server (`UI_VERIFY_CMD`) and drives a real browser at `UI_VERIFY_URL` using Vercel's `agent-browser` (Playwright-based).
- Stores the latest UI result on the task under `.mario/prd.json` (`tasks[].lastAttempt.ui`).

If prerequisites are missing and UI verify is enabled, mario-devx auto-attempts install first.
When UI verify is enabled and prerequisites are missing, mario-devx auto-attempts:
- `npm install -g agent-browser`
- `agent-browser install`
- `npx skills add vercel-labs/agent-browser`

## Verifier output

The judge output is stored on the task in `.mario/prd.json` under `tasks[].lastAttempt.judge`:

```text
Status: PASS|FAIL
EXIT_SIGNAL: true|false
Reason:
- ...
Next actions:
- ...
```

## Git hygiene

If you don't want internal state in git, add this to your repo `.gitignore`:

```gitignore
.mario/state/
```

## Troubleshooting

- Quality Gates failing instantly: verify `.mario/prd.json` has runnable commands under `qualityGates`.
- Scaffold keeps blocking on `T-0001`: inspect `tasks[].lastAttempt.judge.nextActions` in `.mario/prd.json`; follow the suggested scaffold command (root or `app/`), then rerun `/mario-devx:run 1`.
- `T-0002` still blocked: inspect `tasks[].lastAttempt.judge.reason` for `ReasonCode:*`; follow `nextActions` (they now point to the correct workspace manifest).
- UI verify doesn't run: check install output for `agent-browser`; if auto-install failed, rerun the install commands manually and verify `.mario/AGENTS.md` has `UI_VERIFY=1`.
- If `/run` shows AGENTS parse warnings: fix malformed lines in `.mario/AGENTS.md` (must be `KEY=VALUE`; comments must start with `#`).
- Still confused: run `/mario-devx:doctor`.

## Acknowledgements

- [Geoffrey Huntley + playbook](https://github.com/ghuntley/how-to-ralph-wiggum)
- [Resource index](https://github.com/snwfdhmp/awesome-ralph)
- [agent-browser (Vercel)](https://github.com/vercel-labs/agent-browser)

## License

MIT. See `LICENSE`.
