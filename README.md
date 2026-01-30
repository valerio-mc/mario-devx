# 👾 Mario DevX

<img align="right" src="mario_devx.png" alt="Mario DevX" width="256" />

Named after Super Mario because (1) it never stops running, (2) it repeatedly smashes its face into the same level until it learns where the invisible blocks are, and (3) because Italians always do it better 🇮🇹.

**Mario DevX** is an OpenCode plugin that runs Ralph-style, file-based, deterministic agent loops inside the OpenCode TUI.

- PRD interview -> `.mario/PRD.md`
- Split into specs -> `.mario/specs/*.md`
- Planning loop -> `.mario/IMPLEMENTATION_PLAN.md` (plan items with stable IDs)
- Build loop -> implement exactly one plan item per iteration
- Backpressure -> deterministic checks + an LLM verifier that can fail the iteration

State lives on disk and in git, not in a chat window. Fresh context every iteration. Same prompt, new code.

## What you get (in the OpenCode TUI)

No bash harness. No "run plan then exit then run build then rerun build" nonsense. Just slash commands.

```
/mario-devx:init
/mario-devx:prd <idea>
/mario-devx:plan
/mario-devx:build
/mario-devx:approve
/mario-devx:verify
/mario-devx:auto <N>
/mario-devx:ui-verify
/mario-devx:status
```

## Why a plugin

- It runs inside OpenCode, so the human can actually steer (instead of watching a bash loop speedrun your token budget).
- It writes state to `.mario/`, so every iteration starts fresh and still remembers the important stuff.
- It applies backpressure, so "it works on my vibes" doesn't ship.

## Key principles & workflow (short version)

- **Context rotting:** long chats don’t make the agent smarter; they make it confidently wrong in higher resolution.
- **Write it down:** the only memory is what you put in `.mario/` and git.
- **Steering (patterns + backpressure):** keep prompts/files stable upstream, then let gates bully the output downstream.
- **Gates are law:** if tests don’t pass, you’re not done (shocking).
- **Workflow (3 steps):** PRD -> Plan -> Build (one plan item per iteration, repeat until `EXIT_SIGNAL: true`).
- **HITL is a feature:** `/mario-devx:build` drafts the iteration, `/mario-devx:approve` runs it.

## ELI5: get shit done

### 1) Create a repo

```bash
mkdir my-project && cd my-project && git init
```

If it’s not in git, it’s not real.

### 2) Copy the plugin into your project

```bash
mkdir -p .opencode/plugins
tmpdir="$(mktemp -d)" && \
  curl -fsSL https://github.com/valerio-mc/mario-devx/archive/refs/heads/main.tar.gz | tar -xz -C "$tmpdir" && \
  cp -R "$tmpdir"/mario-devx-main/.opencode/plugins/mario-devx ./.opencode/plugins/ && \
  cp "$tmpdir"/mario-devx-main/.opencode/plugins/mario-devx.ts ./.opencode/plugins/ && \
  cp "$tmpdir"/mario-devx-main/.opencode/package.json ./.opencode/
```

This is the part where you "install" it without pretending we have a package manager story.

### 3) Start OpenCode

```bash
opencode .
```

You want the loop in the UI, not in your shell history.

### 4) Initialize mario-devx state

```
/mario-devx:init
```

This creates `.mario/` and seeds the canonical docs/prompts.

### 5) Write the PRD (interview)

```
/mario-devx:prd my brilliant idea
```

This runs in a persistent per-repo **work session** (clean context each time); open `/sessions` and jump into `mario-devx (work)` to answer the questions.

### 6) Set Quality Gates

Edit `.mario/PRD.md` and put real commands under `## Quality Gates`.

If this is a web app and you want UI checks too, run `/mario-devx:ui-verify` (agent-browser / Playwright) and let `/mario-devx:verify` bully the frontend as well.

If you don’t define “done”, the agent will.

### 7) Generate the plan

```
/mario-devx:plan
```

This runs in the work session; open `/sessions` -> `mario-devx (work)` to watch it write `.mario/IMPLEMENTATION_PLAN.md`.

### 8) Draft the next iteration (HITL checkpoint)

```
/mario-devx:build
```

This drafts `.mario/state/pending_plan.md` so you can fix the inevitable "plan item too big" problem.

### 9) Approve and run the iteration

```
/mario-devx:approve
```

This runs the build in the work session; open `/sessions` -> `mario-devx (work)` to watch it live.

The plugin runs the agent, runs gates, runs the judge, and writes feedback to `.mario/state/feedback.md`.

After you implement the plan item, run `/mario-devx:verify` (or `/mario-devx:auto <N>` to keep going automatically).

Control vs work session (the "new integrated logic"):
- Run `/mario-devx:*` commands from your normal session.
- PRD/plan/build/verifier work happens in a persistent per-repo work session (`mario-devx (work)`) that is reset between runs.

## What gets created

In your project:

```text
.mario/
  PRD.md
  specs/*.md
  IMPLEMENTATION_PLAN.md
  AGENTS.md
  state/feedback.md
  state/pending_plan.md
  progress.md
  guardrails.md
  activity.log
  errors.log
  runs/*
```

In this repo:

```text
.opencode/plugins/mario-devx/   # OpenCode plugin source + assets
```

## Backpressure (a.k.a. definition of done)

- Source of truth: `## Quality Gates` in `.mario/PRD.md`.
- Fallback: if you forgot, mario-devx auto-detects common scripts (Node) and a few sane defaults (Go/Rust/Python), then persists them to `.mario/AGENTS.md`.

For web apps, you can optionally add UI backpressure via `agent-browser` (Playwright-based) by enabling it in `.mario/AGENTS.md` or running `/mario-devx:ui-verify`.

## Verifier output (strict on purpose)

The judge writes to `.mario/state/feedback.md` using this format:

```text
Status: PASS|FAIL
EXIT_SIGNAL: true|false
Reason:
- ...
Next actions:
- ...
```

## Safety

- Run it where an overconfident agent can’t ruin your life.
- Keep plan items small.
- If it’s stuck: tighten the plan, don’t "add more context" like it’s a cheat code.

## Acknowledgements

- [Geoffrey Huntley + playbook](https://github.com/ghuntley/how-to-ralph-wiggum)
- [Resource index](https://github.com/snwfdhmp/awesome-ralph)
- [agent-browser (Vercel)](https://github.com/vercel-labs/agent-browser)

## License

MIT. See `LICENSE`.
