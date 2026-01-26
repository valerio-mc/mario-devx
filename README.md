# Mario DevX

<img align="right" src="mario_devx.png" alt="Mario DevX" width="300" />

Ralph-style, file-based agent loops for shipping software.

Named after Super Mario because (1) it never stops running, (2) it repeatedly smashes its face into the same level until it learns where the invisible blocks are, and (3) because Italians always do it better 🇮🇹.

**Mario DevX** is an OpenCode plugin (templates + prompts + state files) that runs a deterministic loop inside the OpenCode TUI:

- PRD interview -> `.mario/PRD.md`
- Split into specs -> `.mario/specs/*.md`
- Planning loop -> `.mario/IMPLEMENTATION_PLAN.md` (plan items with stable IDs)
- Build loop -> implement exactly one plan item per iteration
- Backpressure -> deterministic checks + an LLM verifier that can fail the iteration

State lives on disk and in git, not in a chat window. Fresh context every iteration. Same prompt, new code.

This repo takes deep inspiration from the Ralph Wiggum ecosystem. See Acknowledgements.

## Table of contents

- [Why this exists](#why-this-exists)
- [Key principles & workflow](#key-principles--workflow)
- [What gets installed](#what-gets-installed)
- [ELI5: get hit done](#eli5-get-hit-done)
- [File layout](#file-layout)
- [Configuration (.mario/AGENTS.md)](#configuration-marioagentsmd)
- [Verification model](#verification-model)
- [Safety](#safety)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Why this exists

If you have ever watched an agent:

- declare victory without running tests,
- "fix" a bug by redefining the acceptance criteria,
- or confidently ship a placeholder,

Mario DevX adds two things that agents actually respect:

1. **Backpressure** (commands that must pass)
2. **Loop** (keep going until it does)

**Backpressure** is the part where we stop "vibes-based software delivery".
It is a small set of commands (lint/typecheck/tests/build) that must pass before the loop is allowed to claim DONE.
If the commands fail, the agent doesn't get a gold star. It gets to keep working. Revolutionary.

## Key principles & workflow

Inspired by the Ralph playbook's "Key Principles" section: https://github.com/ghuntley/how-to-ralph-wiggum#key-principles

### Context is everything

- Every loop iteration is a fresh agent instance.
- The only memory is what you put on disk: `.mario/*` + git history.
- Keep plan items small enough to finish in one context window.

**Context rotting** (why long chat sessions go sideways):

- Long sessions accumulate contradictory instructions, stale assumptions, and half-finished threads.
- The model starts to "optimize" for coherence with old context instead of correctness with current code.
- You end up with a giant context window that *feels* like progress and *behaves* like entropy.

Mario DevX fights this by restarting the agent each iteration and forcing state onto disk.
Same inputs, fresh context, less hallucinated momentum.

TL;DR: huge context windows rot fast. Keep tasks small so the agent stays in the **smart zone**.

This informs everything else:

- Use the main agent/context as a scheduler (keep it clean).
- Use subagents as memory extension (fan out, then garbage collect).
- Simplicity and brevity win (verbose inputs degrade determinism).
- Prefer Markdown over JSON for work tracking (token efficiency).

### Steering: patterns + backpressure

- **Steer upstream**: keep the prompts + files stable so the agent starts from a known state.
- **Steer downstream**: make it impossible to "ship" without passing quality gates.

In practice:

- Put your real **definition of done** into `.mario/PRD.md` under `## Quality Gates`.
- The harness runs those commands as backpressure.
- If you don't define them, it will try to guess (and write the guess into `.mario/AGENTS.md`).
- If it can't guess, it fails loudly instead of pretending everything is fine.

### Let Mario Mario (but wear a helmet)

- The loop will eventually converge, but only if you keep tasks small and the gates real.
- If your agent runs with auto-permissions, treat your environment like it can get popped.

Practical protections:

- Prefer sandboxes / minimal credentials.
- Keep secrets out of the repo.
- Escape hatches: Ctrl+C stops the loop; regenerate the plan when it gets weird.

### Workflow (3 phases, 2 modes, 1 loop)

This mirrors the classic Ralph mental model:

1. Define requirements (PRD)
2. Plan (gap analysis)
3. Build (one task, verify, commit)

PRD definition is iterative:

- PRD mode is an interview in small rounds (3-5 questions/round).
- It updates `.mario/PRD.md` incrementally.
- You answer directly in the terminal; the harness appends your answers into `.mario/state/feedback.md` for the next run.
- You stop when it’s good enough and switch to planning/building.

Optional branch hygiene:

- Add `Branch: my-feature` (or `branchName: my-feature`) near the top of `.mario/PRD.md`.
- In build mode, the harness will switch to (or create) that branch before running the agent.

## What gets installed

Core artifacts live in `.mario/` (in the target project):

- `.mario/PRD.md`: project intent, scope, constraints
- `.mario/specs/*.md`: one topic-of-concern per file (one sentence without "and")
- `.mario/IMPLEMENTATION_PLAN.md`: ordered plan items (one item per loop iteration)
- `.mario/AGENTS.md`: operational knobs (agent command + backpressure)
- `.mario/state/feedback.md`: verifier output injected into the next iteration
- `.mario/progress.md`: append-only loop log
- `.mario/guardrails.md`: "signs" (short, high-signal rules to prevent repeated failure)
- `.mario/activity.log`: append-only harness activity log (iterations, timing)
- `.mario/errors.log`: append-only harness error log (failures, repeated failure keys)
- `.mario/runs/*`: per-iteration artifacts (prompt, outputs, diffs, logs)

OpenCode entrypoints (in the target project):

- `/mario-devx:init`
- `/mario-devx:prd`
- `/mario-devx:plan`
- `/mario-devx:build`
- `/mario-devx:approve`
- `/mario-devx:verify`

## ELI5: get hit done

This is the "I want results, not a dissertation" path.

### 1) Create a project and initialize git (don’t be a Goomba)

```bash
mkdir my-project
```

```bash
cd my-project
```

```bash
git init
```

### 2) Install the OpenCode plugin

Copy the plugin into your project:

```bash
mkdir -p .opencode/plugins
cp -R /path/to/mario-devx/.opencode/plugins/mario-devx ./.
cp /path/to/mario-devx/.opencode/plugins/mario-devx.ts ./.opencode/plugins/
cp /path/to/mario-devx/.opencode/package.json ./.opencode/
```

Then start OpenCode in the project:

```bash
opencode .
```

### 3) Initialize mario-devx state

In the OpenCode TUI:

```
/mario-devx:init
```

### 4) (Optional) Tell it which branch to use

Add a line near the top of `.mario/PRD.md`:

```text
Branch: my-feature
```

### 5) PRD interview: bootstrap your idea, then answer rounds in the TUI

```
/mario-devx:prd my brilliant idea
```

### 6) Set backpressure (definition of done)

In `.mario/PRD.md` under `## Quality Gates`, add real commands your repo can run. Example:

```text
Quality Gates (in PRD.md):
- pnpm lint && pnpm test
```

If you don’t set this, Mario DevX tries to auto-detect and write `CMD_*` into `.mario/AGENTS.md`. If it can’t, it fails (on purpose).

### 7) Plan

```
/mario-devx:plan
```

What it does:

- Runs a single planning pass (no code changes expected).
- Reads `.mario/PRD.md` (+ optional `.mario/specs/*`).
- Writes/updates `.mario/IMPLEMENTATION_PLAN.md` into small plan items (`PI-0001`, `PI-0002`, ...) sized to finish in one build iteration.

### 8) Build (two-step HITL)

```
/mario-devx:build
```

What it does:

- Drafts a pending iteration plan under `.mario/state/pending_plan.md`.
- You review/edit it, then run:

```
/mario-devx:approve
```

- The plugin runs the agent, deterministic gates, and the LLM judge.
- It writes feedback to `.mario/state/feedback.md` and logs artifacts under `.mario/runs/*`.

How many iterations?

- It keeps iterating until verification says you're done (`EXIT_SIGNAL: true`), or until a circuit breaker trips (`MARIO_NO_PROGRESS_LIMIT`, `MARIO_REPEAT_FAIL_LIMIT`, `MAX_ITERATIONS`).

If it gets stuck: stop it (Ctrl+C), tighten the plan item, and try again. More context is not a power-up.

## File layout

In your project (default):

```text
.mario/
  PRD.md                  # requirements + quality gates
  specs/*.md              # one topic of concern per file
  IMPLEMENTATION_PLAN.md   # plan items (PI-0001, PI-0002, ...)
  AGENTS.md                # agent + backpressure config
  state/feedback.md        # verifier feedback injected into next iteration
  progress.md              # append-only loop log
  guardrails.md            # short, high-signal "signs"
  activity.log             # harness activity log
  errors.log               # harness errors log
  runs/*                   # per-iteration prompts, outputs, diffs, logs
```

In this repo:

```text
.opencode/plugins/mario-devx/   # OpenCode plugin source + assets
```

## Configuration (.mario/AGENTS.md)

### Agent runner

The plugin always uses the current OpenCode session and agent. `AGENT_CMD` is ignored and kept only for legacy compatibility.

### Backpressure commands

Backpressure commands are optional overrides.

Preferred: set the commands under `## Quality Gates` in `.mario/PRD.md`.

Fallback: if PRD has no quality gates yet, Mario DevX will try to auto-detect common stacks (Node/Rust/Go/Python) and persist the detected `CMD_*` here.

If you want to override (or pin) them manually:

```bash
CMD_LINT='npm run lint'
CMD_TYPECHECK='npm run typecheck'
CMD_TEST='npm test'
CMD_BUILD='npm run build'
```

### Loop safety

```bash
MARIO_NO_PROGRESS_LIMIT=3
MARIO_REPEAT_FAIL_LIMIT=5
```

### LLM verifier (same agent)

By default, build mode runs deterministic checks and then runs the LLM verifier using the same agent/session.

## Verification model

Mario DevX has two verification layers:

1. Deterministic backpressure (auto-detected or from PRD Quality Gates)
2. LLM verifier (PASS/FAIL feedback)

**LLM review:** build mode runs the LLM verifier after deterministic backpressure (unless disabled via `MARIO_LLM_VERIFY=0`). The verifier writes PASS/FAIL back into `.mario/state/feedback.md`.

Exit detection:

- `Status: PASS` alone is not enough.
- The LLM verifier must also set `EXIT_SIGNAL: true`, otherwise the harness treats it as FAIL.



Verifier output is persisted to `.mario/state/feedback.md` in this format:

```text
Status: PASS|FAIL
EXIT_SIGNAL: true|false
Reason:
- ...
Next actions:
- ...
```

## Safety

You are running an agent in a loop. It will do what you told it to do, not what you meant.

- Run this in a sandbox if your agent requires auto-permissions.
- Keep secrets out of the repo.
- Use short plan items.
- If the loop is stuck, stop it and regenerate the plan.

## Acknowledgements

This project is deeply inspired by the Ralph Wiggum technique and its surrounding playbooks and community resources.

- Geoffrey Huntley + community playbook: https://github.com/ghuntley/how-to-ralph-wiggum
- Resource index: https://github.com/snwfdhmp/awesome-ralph

## License

MIT. See `LICENSE`.
