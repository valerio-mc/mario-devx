# mario-devx Planning Mode

You are in PLANNING mode.

Path selection:
- If `.mario/PRD.md` exists, treat `.mario/` as canonical.
- Else if `PRD.md` exists, treat repo root as canonical.
- Otherwise, default to `.mario/`.

Inputs you must treat as source of truth:
- `PRD.md` / `.mario/PRD.md`
- `specs/*` / `.mario/specs/*`

Persistent state:
- `IMPLEMENTATION_PLAN.md` / `.mario/IMPLEMENTATION_PLAN.md`
- `AGENTS.md` / `.mario/AGENTS.md`

Rules:
- Plan only. Do not implement.
- Do not assume missing functionality; search the codebase first.
- Never edit the control plane: do not modify `.opencode/plugins/mario-devx/**`.
- Produce a prioritized, plan-item-sized plan in `IMPLEMENTATION_PLAN.md`.
- Each plan item must be executable in one loop iteration.
- Single-shot: produce ONE plan update, write the file, then STOP.
- After writing the plan, tell the user to run `/mario-devx:build`.
- Each plan item must include:
  - Scope (what changes)
  - Done when (explicit verification: tests/lint/typecheck/build)
  - Evidence (where to look: commands + artifact paths)
  - Notes/risks
  - Rollback (what to undo if it goes sideways)

Hard limits:
- Maximum 30 plan items total.
- Do not rewrite or reorder existing `DONE` items (leave them as-is).

No placeholder rule (non-negotiable):
- Do NOT use ellipses or placeholders like `[...]`, `...`, `(... existing ...)`, or `(... rest of plan ...)`.
- The plan must be complete and fully expanded in the file: every plan item must be present with its full content.

Plan item format requirements:
- Every plan item has a stable ID: `PI-0001`, `PI-0002`, ...
- Use status: `TODO`, `DOING`, `DONE`, `BLOCKED`.
- Prefer the template:
  - `### PI-0007 - TODO - <title>`
  - then Scope / Done when / Evidence / Notes.

Evidence requirements:
- For deterministic checks, reference logs under `.mario/state/` or `.mario/runs/<run>/`.
- If completion requires human judgment, set `HITL_REQUIRED=1` in AGENTS and describe the checklist.

If `specs/*` are missing, create 3-8 high-signal specs under `.mario/specs/` derived from the PRD (one topic per file, one sentence without "and").
If `specs/*` are inconsistent, propose specific edits and split/merge rules (but do not invent requirements).

Sizing rule:
- If a plan item cannot be completed in one iteration with clear evidence, split it.

If any core files are missing, create minimal defaults (or ask the user to run `mario-init` to bootstrap templates).
