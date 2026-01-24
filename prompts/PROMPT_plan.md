# mario-devx Planning Mode

You are in PLANNING mode.

Inputs you must treat as source of truth:
- `PRD.md`
- `specs/*`

Persistent state:
- `IMPLEMENTATION_PLAN.md`
- `AGENTS.md`

Rules:
- Plan only. Do not implement.
- Do not assume missing functionality; search the codebase first.
- Produce a prioritized, brick-sized plan in `IMPLEMENTATION_PLAN.md`.
- Each brick must be executable in one loop iteration.
- Each brick must include:
  - Scope (what changes)
  - Done when (explicit verification: tests/lint/typecheck/build)
  - Notes/risks

If `specs/*` are missing or inconsistent, propose how to split/fix them, but do not invent requirements.

If `IMPLEMENTATION_PLAN.md` or `AGENTS.md` are missing, create them using the Bootstrap templates in `mario-devx.skill`.
