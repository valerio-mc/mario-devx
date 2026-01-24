---
name: mario-devx
description: Italian Ralph-style methodology for OpenCode: interactive PRD interview -> specs -> brick-by-brick implementation plan -> build loop with deterministic backpressure plus LLM/human verifier feedback injection.
---

Persist state on disk (and in git), not in chat context.

Core artifacts (in the target project root)
- `PRD.md`: project intent, scope, constraints.
- `specs/*.md`: one topic-of-concern per file, derived from PRD.
- `IMPLEMENTATION_PLAN.md`: ordered list of bricks (one brick per iteration).
- `AGENTS.md`: operational commands + toggles (backpressure + AUTO_COMMIT/AUTO_PUSH).
- `state/feedback.md`: verifier output injected into the next loop.

Resources shipped with this skill
- `prompts/`: prompt templates (PRD/plan/build/LLM-verify)
- `templates/`: starter versions of the core artifacts
- `scripts/`: loop runner + verifier scripts
- `commands/`: optional OpenCode `/mario-*` command files (installable)

Workflow

Phase 1 - Interview -> PRD
- Ask exactly one question at a time.
- Write/update `PRD.md` incrementally.
- Capture workflow toggles during interview (AUTO_COMMIT/AUTO_PUSH/HITL_REQUIRED + commands).

Phase 2 - Split -> specs
- Create `specs/*.md` from `PRD.md`.
- Each spec must be describable in one sentence without "and".
- Each spec must include acceptance criteria.

Phase 3 - Planning loop -> IMPLEMENTATION_PLAN
- Plan only. Do not implement.
- Compare `specs/*` vs codebase.
- Each brick must include an explicit "Done when" (verification).

Phase 4 - Building loop -> one brick
- Implement exactly one brick.
- Search first; do not assume missing.
- Apply deterministic backpressure (commands from `AGENTS.md`).
- Optionally run LLM verifier to generate `state/feedback.md`.
- If configured, auto-commit and optionally push.

Phase 5 - Feedback injection
- The next iteration must read `state/feedback.md` and address it first.

Bootstrap (create missing core files)

If the target project is missing mario-devx artifacts, bootstrap by copying templates.

Preferred source order:
1. Project-local skill install: `.opencode/skills/mario-devx/templates/*`
2. Global skill install: `~/.config/opencode/skills/mario-devx/templates/*`

If neither exists, create the files using the content in `templates/*` from this repo.

Loop runner (non-interactive)

Run in a target project:
- `bash scripts/mario-loop.sh prd`
- `bash scripts/mario-loop.sh plan`
- `bash scripts/mario-loop.sh build`

OpenCode UI is not used here. The loop uses `opencode run` (non-interactive).
