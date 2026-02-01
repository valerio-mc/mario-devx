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
/mario-devx:new <idea>
/mario-devx:run <N>
/mario-devx:ui-verify
/mario-devx:doctor
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
- **One command loop:** `/mario-devx:run <N>` executes the next plan item(s) and stops on failure.

## ELI5: get shit done

`/mario-devx:status` prints the current run/iteration state plus the work session id so you can jump straight into `/sessions`. It also tells you the next most likely command to run based on whether you're DOING, BLOCKED, or idle.

### 0) Understand the sessions (or suffer)

- You run `/mario-devx:*` commands from your normal session ("control session").
- The actual PRD/plan/build/verifier work runs in a persistent per-repo **work session** called `mario-devx (work)`.
- Open it via `/sessions` when you want to watch or answer prompts.
- Most commands are async: you trigger them in the control session, they run in the work session, and you get notified when the work session goes idle.
- Useful helpers: `/mario-devx:doctor` (healthcheck + common fixes), `/mario-devx:status` (what's happening + what to do next).

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

### 4) Bootstrap (init + PRD + plan)

```
/mario-devx:new my brilliant idea
```

This bootstraps everything:

- creates `.mario/` (if missing)
- runs the PRD interview in `mario-devx (work)` (open `/sessions` and jump into it to answer)
- when PRD looks complete, it automatically starts the plan generation

If you already have a PRD and just want to regenerate the plan, rerun `/mario-devx:new`.

### 5) Set Quality Gates

Edit `.mario/PRD.md` and put real commands under `## Quality Gates` (commands only, wrap them in backticks).

If this is a web app and you want UI checks too, run `/mario-devx:ui-verify` (agent-browser / Playwright) and let `/mario-devx:run` bully the frontend as well.

If you don’t define “done”, the agent will.

If you edit `.mario/PRD.md` after bootstrapping, rerun `/mario-devx:new` to refresh `.mario/IMPLEMENTATION_PLAN.md`.

### 6) Run the loop

```
/mario-devx:run 1
```

This:

- picks the next `TODO` (or resumes `DOING`) plan item from `.mario/IMPLEMENTATION_PLAN.md`
- runs the builder in `mario-devx (work)`
- runs deterministic gates (+ optional UI verify)
- runs the judge and writes feedback to `.mario/state/feedback.md`

To keep going:

```
/mario-devx:run 5
```

## What gets created

In your project:

```text
.mario/
  PRD.md
  specs/*.md
  IMPLEMENTATION_PLAN.md
  AGENTS.md
  state/feedback.md
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

## Troubleshooting

- **Quality Gates failing instantly:** in `.mario/PRD.md` under `## Quality Gates`, only backticked shell commands are executed. Prose bullets will be ignored.
- **Plan generation looks like slop:** `.mario/IMPLEMENTATION_PLAN.md` must not contain placeholders like `[...]` or `TODO: fill later`. If it does, rerun `/mario-devx:new`.
- **Where is it running?** open `/sessions` and jump into `mario-devx (work)`, or run `/mario-devx:status`.
- **UI verify doesn’t run:** run `/mario-devx:ui-verify` to set it up (agent-browser / Playwright) and make sure prerequisites are installed.
- **Still confused:** run `/mario-devx:doctor` and follow the suggestions.

## Acknowledgements

- [Geoffrey Huntley + playbook](https://github.com/ghuntley/how-to-ralph-wiggum)
- [Resource index](https://github.com/snwfdhmp/awesome-ralph)
- [agent-browser (Vercel)](https://github.com/vercel-labs/agent-browser)

## License

MIT. See `LICENSE`.
