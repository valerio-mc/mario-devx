# mario-devx Planning Mode

You are in PLANNING mode.

Path selection:
- If `.mario/PRD.md` exists, treat `.mario/` as canonical.
- Else if `PRD.md` exists, treat repo root as canonical.
- Otherwise, default to `.mario/`.

Inputs you must treat as source of truth:
- `PRD.md` / `.mario/PRD.md`

Persistent state:
- `IMPLEMENTATION_PLAN.md` / `.mario/IMPLEMENTATION_PLAN.md`
- `AGENTS.md` / `.mario/AGENTS.md`

Rules:
- Plan only. Do not implement.
- Do not run shell commands.
- Do not modify files outside `.mario/`.
- Do not assume missing functionality; search the codebase first.
- Never edit the control plane: do not modify `.opencode/plugins/mario-devx/**`.
- Produce a prioritized, plan-item-sized plan in `IMPLEMENTATION_PLAN.md`.
- Each plan item must be executable in one loop iteration.
- Single-shot: produce ONE plan update, write the file, then STOP.
- After writing the plan, tell the user to run `/mario-devx:run 1`.
- Then STOP. Do not start implementation.
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
- For deterministic checks, reference logs under `.mario/runs/<run>/` (and use `.mario/state/state.json` to find the latest run dir).
- If completion requires human judgment, set `HITL_REQUIRED=1` in AGENTS and describe the checklist.

Sizing rule:
- If a plan item cannot be completed in one iteration with clear evidence, split it.

Web scaffolding guidance (avoid common papercuts):
- For Next.js scaffolding in a repo with `.mario/` and `.opencode/`, avoid `create-next-app .` (non-empty dir). Plan to scaffold in a temp dir and copy into repo root.

If any core files are missing, write a note in the plan item under Notes/risks and keep going.
