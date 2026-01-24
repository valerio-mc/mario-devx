# Mario Devx

Ralph-style, file-based agent loops for shipping software.

Named after Super Mario because (1) it never stops running, (2) it repeatedly smashes its face into the same level until it learns where the invisible blocks are, and (3) because Italians always do it better 🇮🇹.

Mario Devx is a "skill" + a small set of templates and scripts that let you run any AI coding CLI in a deterministic loop:

- PRD interview -> `.mario/PRD.md`
- Split into specs -> `.mario/specs/*.md`
- Planning loop -> `.mario/IMPLEMENTATION_PLAN.md` (plan items with stable IDs)
- Build loop -> implement exactly one plan item per iteration
- Backpressure -> deterministic checks + an LLM verifier that can fail the iteration

State lives on disk and in git, not in a chat window. Fresh context every iteration. Same prompt, new code.

This repo takes deep inspiration from the Ralph Wiggum ecosystem. See Acknowledgements.

## Why this exists

If you have ever watched an agent:

- declare victory without running tests,
- "fix" a bug by redefining the acceptance criteria,
- or confidently ship a placeholder,

Mario Devx adds two things that agents actually respect:

1. Backpressure (commands that must pass)
2. A loop (keep going until it does)

## Quick start

Prereqs:

- A git repo (the loop uses git as memory)
- One AI coding CLI (pick at least one):
  - OpenCode
  - Claude Code
  - Codex

### 1) Install the OpenCode command (optional)

If you use OpenCode, install the `mario-init` command into your OpenCode commands directory:

```bash
bash scripts/install-opencode-commands.sh
```

### 2) Bootstrap mario-devx files in your target project

From your project root:

- OpenCode: run `mario-init`
- Or manually copy templates/scripts (see "Manual install")

`mario-init` creates the `.mario/` directory and copies templates/prompts.

Expected outputs (in your project):

```text
.mario/
  PRD.md
  AGENTS.md
  IMPLEMENTATION_PLAN.md
  prompts/
  specs/
  state/feedback.md
  progress.md
```

### 3) Run the loop

```bash
# PRD interview
bash scripts/mario-loop.sh prd

# Plan only (no code changes)
bash scripts/mario-loop.sh plan

# Implement one plan item per iteration
bash scripts/mario-loop.sh build
```

## The workflow (3 phases, 2 modes, 1 loop)

This mirrors the "Three Phases, Two Prompts, One Loop" mental model described in Ralph docs:

1. Define requirements (PRD)
2. Plan (gap analysis)
3. Build (one task, verify, commit)

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
commands/mario-init.md
prompts/                   # prompt templates copied into .mario/prompts/
scripts/                   # loop + verification scripts
templates/                 # project templates copied into .mario/
SKILL.md                   # skill contract
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

Set the commands that must pass before a plan item is considered done:

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

Mario Devx has two verification layers:

1. Deterministic backpressure: `scripts/verify.sh`
2. LLM verifier (PASS/FAIL feedback): `scripts/verify-llm.sh`

Combined gate (default for build mode): `scripts/verify-all.sh`

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

If you do not want to use OpenCode commands, copy these into your project:

- `templates/*` -> `.mario/*`
- `prompts/*` -> `.mario/prompts/*`
- `scripts/*` -> `scripts/*`

Then edit `.mario/AGENTS.md` and run the loop.

## Acknowledgements

This project is deeply inspired by the Ralph Wiggum technique and its surrounding playbooks and community resources.

- Geoffrey Huntley + community playbook: https://github.com/ghuntley/how-to-ralph-wiggum
- Resource index: https://github.com/snwfdhmp/awesome-ralph

## License

MIT. See `LICENSE`.
