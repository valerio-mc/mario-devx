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
- Produce a prioritized, plan-item-sized plan in `IMPLEMENTATION_PLAN.md`.
- Each plan item must be executable in one loop iteration.
- Each plan item must include:
  - Scope (what changes)
  - Done when (explicit verification: tests/lint/typecheck/build)
  - Notes/risks

Plan item format requirements:
- Every plan item has a stable ID: `PI-0001`, `PI-0002`, ...
- Use status: `TODO`, `DOING`, `DONE`, `BLOCKED`.
- Prefer the template:
  - `### PI-0007 - TODO - <title>`
  - then Scope / Done when / Evidence / Notes.

Evidence requirements:
- For deterministic checks, reference logs under `.mario/state/` or `.mario/runs/<run>/`.
- If completion requires human judgment, set `HITL_REQUIRED=1` in AGENTS and describe the checklist.

If `specs/*` are missing or inconsistent, propose how to split/fix them, but do not invent requirements.

If any core files are missing, create minimal defaults (or ask the user to run `mario-init` to bootstrap templates).
