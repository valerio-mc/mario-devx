# Mario DevX

Ralph-style, file-based agent loops for shipping software.

<table>
  <tr>
    <td>
      <p>
        Named after Super Mario because (1) it never stops running, (2) it repeatedly smashes its face into the same level until it learns where the invisible blocks are, and (3) because Italians always do it better 🇮🇹.
      </p>
      <p>
        Mario DevX is a project harness (templates + prompts + scripts) that lets you run any AI coding CLI in a deterministic loop:
      </p>
      <ul>
        <li>PRD interview -&gt; <code>.mario/PRD.md</code></li>
        <li>Split into specs -&gt; <code>.mario/specs/*.md</code></li>
        <li>Planning loop -&gt; <code>.mario/IMPLEMENTATION_PLAN.md</code> (plan items with stable IDs)</li>
        <li>Build loop -&gt; implement exactly one plan item per iteration</li>
        <li>Backpressure -&gt; deterministic checks + an LLM verifier that can fail the iteration</li>
      </ul>
    </td>
    <td>
      <img src="mario_devx.png" alt="Mario DevX" width="260" />
    </td>
  </tr>
</table>

State lives on disk and in git, not in a chat window. Fresh context every iteration. Same prompt, new code.

This repo takes deep inspiration from the Ralph Wiggum ecosystem. See Acknowledgements.

## Table of contents

- [Why this exists](#why-this-exists)
- [Key principles](#key-principles)
- [What gets installed](#what-gets-installed)
- [Quick start](#quick-start)
- [The workflow (3 phases, 2 modes, 1 loop)](#the-workflow-3-phases-2-modes-1-loop)
- [File layout](#file-layout)
- [Configuration (.mario/AGENTS.md)](#configuration-marioagentsmd)
- [Verification model](#verification-model)
- [Safety](#safety)
- [Manual install](#manual-install)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Why this exists

If you have ever watched an agent:

- declare victory without running tests,
- "fix" a bug by redefining the acceptance criteria,
- or confidently ship a placeholder,

Mario DevX adds two things that agents actually respect:

1. Backpressure (commands that must pass)
2. A loop (keep going until it does)

Backpressure is the part where we stop "vibes-based software delivery".
It is a small set of commands (lint/typecheck/tests/build) that must pass before the loop is allowed to claim DONE.
If the commands fail, the agent doesn't get a gold star. It gets to keep working. Revolutionary.

## Key principles

Inspired by the Ralph playbook's "Key Principles" section: https://github.com/ghuntley/how-to-ralph-wiggum#key-principles

### Context is everything

- Every loop iteration is a fresh agent instance.
- The only memory is what you put on disk: `.mario/*` + git history.
- Keep plan items small enough to finish in one context window.

Context rotting (why long chat sessions go sideways):

- Long sessions accumulate contradictory instructions, stale assumptions, and half-finished threads.
- The model starts to "optimize" for coherence with old context instead of correctness with current code.
- You end up with a giant context window that *feels* like progress and *behaves* like entropy.

Mario DevX fights this by restarting the agent each iteration and forcing state onto disk.
Same inputs, fresh context, less hallucinated momentum.

Some numbers (because the problem is math, not vibes):

- When "200K tokens" are advertised, usable context is closer to ~176K.
- Models tend to perform best in a smaller "smart zone" (roughly 40-60% of context).
- Tight tasks + one task per loop keeps you near 100% smart-zone utilization.

This informs everything else:

- Use the main agent/context as a scheduler (keep it clean).
- Use subagents as memory extension (fan out, then garbage collect).
- Simplicity and brevity win (verbose inputs degrade determinism).
- Prefer Markdown over JSON for work tracking (token efficiency).

### Steering: patterns + backpressure

- Steer upstream: keep the prompts + files stable so the agent starts from a known state.
- Steer downstream: make it impossible to "ship" without passing quality gates.

In practice:

- Put your real "definition of done" into `.mario/PRD.md` under `## Quality Gates`.
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

## What gets installed

Core artifacts live in `.mario/` (in the target project):

- `.mario/PRD.md`: project intent, scope, constraints
- `.mario/specs/*.md`: one topic-of-concern per file (one sentence without "and")
- `.mario/IMPLEMENTATION_PLAN.md`: ordered plan items (one item per loop iteration)
- `.mario/AGENTS.md`: operational knobs (agent command + backpressure)
- `.mario/state/feedback.md`: verifier output injected into the next iteration
- `.mario/progress.md`: append-only loop log
- `.mario/runs/*`: per-iteration artifacts (prompt, outputs, diffs, logs)

Executable entrypoints (in the target project):

- `./mario`: single project-local shim
- `.mario/scripts/mario`: wrapper CLI (`init|prd|plan|build|doctor`)
- `.mario/scripts/mario-loop.sh`: loop runner
- `.mario/scripts/verify.sh`: deterministic backpressure
- `.mario/scripts/verify-llm.sh`: LLM judge backpressure
- `.mario/scripts/verify-all.sh`: combined gate

## Quick start

Prereqs:

- A git repo (the loop uses git as memory)
- One AI coding CLI (pick at least one):
  - Claude Code
  - Codex
  - OpenCode (works, but not required)

### 1) Install into your project (agent-agnostic)

From your project root:

```bash
curl -fsSL https://raw.githubusercontent.com/valerio-mc/mario-devx/main/install.sh | bash
```

Pin a version/tag (recommended for teams):

```bash
MARIO_DEVX_REF=v0.0.0 \
  curl -fsSL https://raw.githubusercontent.com/valerio-mc/mario-devx/v0.0.0/install.sh | bash
```

This installs:

- `.mario/*` (state + prompts)
- `.mario/scripts/*` (loop + verifier + wrapper)
- `./mario` (single shim entrypoint)

### 2) Configure

Edit `.mario/AGENTS.md` to select your agent.

Backpressure is configured in this order:

1. `## Quality Gates` in `.mario/PRD.md` (source of truth)
2. `CMD_*` in `.mario/AGENTS.md` (optional overrides)
3. Auto-detection (fallback): the harness tries to infer commands and writes them into `.mario/AGENTS.md`

The goal is that you can install Mario DevX and immediately run `./mario build` without first doing a small ritual of "please tell me how to run tests".
If your project actually has no tests/build/lint, Mario DevX will make that awkward (on purpose).

Quality gate parsing rules:

- Only list items under `## Quality Gates` are considered.
- You can write them as `- pnpm lint && pnpm test` (backticks are optional).
- Avoid putting examples in list items unless you want them to run.

### 3) Run

```bash
# PRD interview
./mario prd

# Plan only (no code changes)
./mario plan

# Implement one plan item per iteration
./mario build
```

This repo is a project harness. It doesn’t require any specific TUI.

## The workflow (3 phases, 2 modes, 1 loop)

This mirrors the "Three Phases, Two Prompts, One Loop" mental model described in Ralph docs:

1. Define requirements (PRD)
2. Plan (gap analysis)
3. Build (one task, verify, commit)

PRD definition is iterative:

- PRD mode is an interview in small rounds (3-5 questions/round).
- It updates `.mario/PRD.md` incrementally.
- You stop when it’s good enough and switch to planning/building.

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
  runs/*                   # per-iteration prompts, outputs, diffs, logs
```

In this repo:

```text
prompts/                   # prompt templates copied into .mario/prompts/
scripts/                   # loop + verification scripts
templates/                 # project templates copied into .mario/
install.sh                 # curlable installer
```

## Configuration (.mario/AGENTS.md)

### Agent runner

The loop executes `AGENT_CMD` once per iteration.

If `AGENT_CMD` contains `{prompt}`, it will be replaced with the prompt file path.
If it does not, the prompt content is piped through stdin.

Defaults:

```bash
AGENT=opencode
AGENT_CMD='opencode run --format default "$(cat {prompt})"'
```

Examples:

```bash
# Claude Code (stdin)
AGENT=claude
AGENT_CMD='claude -p --dangerously-skip-permissions'

# Codex (stdin)
AGENT=codex
AGENT_CMD='codex exec --yolo -'
```

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

### LLM verifier (third model supervision)

By default, build mode runs deterministic checks and then runs an LLM verifier.

```bash
MARIO_LLM_VERIFY=1
LLM_VERIFY_CMD=
```

If `LLM_VERIFY_CMD` is empty, it falls back to `AGENT_CMD`.
In practice, you will usually set a different model/provider here.

## Verification model

Mario DevX has two verification layers:

1. Deterministic backpressure: `.mario/scripts/verify.sh`
2. LLM verifier (PASS/FAIL feedback): `.mario/scripts/verify-llm.sh`

Combined gate (default for build mode): `.mario/scripts/verify-all.sh`

LLM review: build mode runs the LLM verifier after deterministic backpressure (unless disabled via `MARIO_LLM_VERIFY=0`). The verifier writes PASS/FAIL back into `.mario/state/feedback.md`.

(All executables live under `.mario/scripts/`; `./mario` is just a shim.)

Verifier output is persisted to `.mario/state/feedback.md` in this format:

```text
Status: PASS|FAIL
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

## Manual install

If you do not want to use the installer, copy these into your project:

- `templates/*` -> `.mario/*`
- `prompts/*` -> `.mario/prompts/*`
- `scripts/*` -> `.mario/scripts/*`
- `mario` -> `./mario`

Or: `curl` the installer (preferred) and let it do the copying.

Then edit `.mario/AGENTS.md` and run the loop.

## Acknowledgements

This project is deeply inspired by the Ralph Wiggum technique and its surrounding playbooks and community resources.

- Geoffrey Huntley + community playbook: https://github.com/ghuntley/how-to-ralph-wiggum
- Resource index: https://github.com/snwfdhmp/awesome-ralph

## License

MIT. See `LICENSE`.
