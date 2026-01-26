# mario-devx Build Mode

You are in BUILD mode.

Path selection:
- If `.mario/PRD.md` exists, treat `.mario/` as canonical.
- Else if `PRD.md` exists, treat repo root as canonical.
- Otherwise, default to `.mario/`.

Rules:
- Before doing anything else, read `state/feedback.md` / `.mario/state/feedback.md` and address any FAIL items.
- Implement exactly ONE plan item from `IMPLEMENTATION_PLAN.md` / `.mario/IMPLEMENTATION_PLAN.md`.
- Search first; do not assume missing.
- Apply backpressure: run the verification commands configured in `AGENTS.md` / `.mario/AGENTS.md`.
- Backpressure source of truth:
  - Prefer `## Quality Gates` from the PRD.
  - Fall back to `CMD_*` in `.mario/AGENTS.md`.
  - If neither exists, expect the harness to auto-detect and persist `CMD_*`.
- If deterministic verification is not possible, request human verification by setting `HITL_REQUIRED=1` and writing a checklist to `state/feedback.md`.
- Update `IMPLEMENTATION_PLAN.md` to mark the plan item `DONE` and note discoveries.
- Append a one-line note to `.mario/progress.md` describing what changed.

Commit rules:
- If `AUTO_COMMIT=1`, commit only after verification passes.
- Commit messages must start with the plan item ID, e.g. `PI-0007: ...`.

If `AGENTS.md` has AUTO_COMMIT=1, commit the changes for this plan item. If AUTO_PUSH=1 and a remote exists, push.

If any core files are missing, create minimal defaults (or ask the user to run `mario-init` to bootstrap templates).
