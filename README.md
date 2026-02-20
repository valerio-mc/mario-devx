# 👾 Mario DevX

<img align="right" src="mario_devx.png" alt="Mario DevX" width="256" />

Named after Super Mario because (1) it never stops running, (2) it repeatedly smashes its face into the same level until it learns where the invisible blocks are, and (3) because Italians always do it better 🇮🇹.

It does not "have a conversation" about shipping. It ships, fails a gate, reads the receipt, and tries again.
If you're looking for vibes, inspirational essays, or a 200-message thread that ends with "should work," you're in the wrong repo.

**Mario DevX** is an OpenCode plugin that runs Ralph-style, file-based, deterministic agent loops inside the OpenCode TUI.

## Why you'll like it

- **Smart planning, deterministic execution**: LLM-driven PRD interview adapts to your project (no rigid forms), but task execution is strictly deterministic—quality gates must pass, verifiable output stored on disk (`.mario/*`), not fragile chat memory.
- Strict verifier output (`PASS|FAIL` + next actions) so failures are actionable.
- Incremental scope management (`/mario-devx:add`, `/mario-devx:replan`) without restarting from scratch.

## Loop overview

![Mario DevX loop flowchart](mario_devx_flowchart.png)

## 30-second quickstart

```bash
mkdir my-project && cd my-project && git init && \
curl -fsSL https://raw.githubusercontent.com/valerio-mc/mario-devx/main/install.sh | bash && \
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

1) Create a repo and install mario-devx (same command as quickstart).
2) Start OpenCode: `opencode .`
3) Bootstrap: `/mario-devx:new my brilliant idea`
4) Execute one slice: `/mario-devx:run 1`

The PRD wizard is LLM-driven and asks one high-leverage question at a time. You answer like a normal human; it writes requirements, quality gates, and tasks to `.mario/prd.json` so nobody has to archaeologically excavate your chat history later.

## How it works

- `/mario-devx:run` executes in two ephemeral phases: **work** (build/repair) then **verify**.
- Verification pipeline is strict: deterministic gates -> UI verification (when enabled) -> LLM verifier.
- Tasks complete only on verifier `PASS`; otherwise they are blocked with concrete next actions instead of motivational poetry.
- Progress streams back to your control session as throttled toasts (text + tool lifecycle + patch updates).
- Toast streaming is on by default; set `STREAM_WORK=0` and/or `STREAM_VERIFY=0` in `.mario/AGENTS.md` to disable.
- `run.lock` heartbeats in `.mario/state/` guard against stale/abandoned runs and make interrupted runs recoverable instead of cursed.

## Agent knobs

`.mario/AGENTS.md` supports phase-agent and stream controls:

```dotenv
WORK_AGENT='build'
VERIFY_AGENT='build'
STREAM_WORK=1
STREAM_VERIFY=1
```

- `WORK_AGENT`: agent used for build/repair prompts.
- `VERIFY_AGENT`: agent used for verifier prompts.
- `STREAM_WORK` / `STREAM_VERIFY`: toast streaming toggles (`1` on, `0` off).

## Frontend verification

When `frontend: true`, mario-devx configures UI verification and auto-heals browser prerequisites during `/mario-devx:run` (non-interactive first), then stores UI evidence under `tasks[].lastAttempt.ui` so "works on my machine" has receipts.

Verifier output is stored under `tasks[].lastAttempt.judge` as structured JSON (`status`, `reason`, `nextActions`).

## What gets created

In your project:

```text
.mario/
  prd.json                   # requirements + planning + tasks + backlog + verification policy
  AGENTS.md                  # harness knobs (UI_VERIFY*, WORK_AGENT, VERIFY_AGENT, STREAM_WORK, STREAM_VERIFY)
  state/state.json           # internal state (iteration + run status)
  state/run.lock             # active-run lock + heartbeat
  state/mario-devx.log       # centralized structured run/tool logs (auto-capped/rotated)
```

In this repo:

```text
.opencode/plugins/mario-devx/   # OpenCode plugin source + assets
```

## Git hygiene

If you don't want internal state in git, add this to your repo `.gitignore`:

```gitignore
.mario/state/
```

## Troubleshooting

| Issue | Quick fix |
|-------|-----------|
| **Run blocked before coding starts** | Check `.mario/prd.json` for missing `tasks` or `qualityGates`, fix reality, then rerun `/mario-devx:run 1`. |
| **UI verification fails to start** | Ensure `UI_VERIFY=1`; if runtime is missing, run `CI=1 npm_config_yes=true npx --yes playwright install chromium` and let automation do its dramatic entrance. |
| **Anything weird / stuck / transport-y** | Run `/mario-devx:doctor` and attach `.mario/state/mario-devx.log`, `.mario/state/state.json`, `.mario/prd.json` so we debug facts, not folklore. |

## Acknowledgements

- [Geoffrey Huntley + playbook](https://github.com/ghuntley/how-to-ralph-wiggum)
- [Resource index](https://github.com/snwfdhmp/awesome-ralph)
- [agent-browser (Vercel)](https://github.com/vercel-labs/agent-browser)

## License

MIT. See `LICENSE`.
