# mario-devx Build Mode

You are in BUILD mode.

Path selection:
- If `.mario/PRD.md` exists, treat `.mario/` as canonical.
- Else if `PRD.md` exists, treat repo root as canonical.
- Otherwise, default to `.mario/`.

Rules:
- Before doing anything else, read the most recent verifier verdict in `.mario/runs/*/judge.out` (use `.mario/state/state.json` to find the latest runDir).
- Implement exactly ONE plan item from `IMPLEMENTATION_PLAN.md` / `.mario/IMPLEMENTATION_PLAN.md`.
- Search first; do not assume missing.
- Apply backpressure: run the verification commands configured in `AGENTS.md` / `.mario/AGENTS.md`.
- Backpressure source of truth:
  - Prefer `## Quality Gates` from the PRD.
  - Fall back to `CMD_*` in `.mario/AGENTS.md`.
  - If neither exists, expect the harness to auto-detect and persist `CMD_*`.
- If deterministic verification is not possible, request human verification by setting `HITL_REQUIRED=1` in `.mario/AGENTS.md` and writing a checklist into the plan item under `Done when` / `Evidence`.
- Update `IMPLEMENTATION_PLAN.md` to mark the plan item `DONE` and note discoveries.


Next.js scaffolding note (common failure):
- If you scaffold a Next.js app in a repo that already contains `.mario/` and `.opencode/`, `create-next-app .` often refuses because the directory is not empty.
- Use a temp directory and copy the scaffold into the repo root instead.
  - Example:
    - `tmpdir=$(mktemp -d)`
    - `npx create-next-app@latest "$tmpdir/app" --yes --typescript --eslint --app`
    - copy files into repo root (exclude `.mario/` and `.opencode/`)

Commit rules:
- If `AUTO_COMMIT=1`, commit only after verification passes.
- Commit messages must start with the plan item ID, e.g. `PI-0007: ...`.

If `AGENTS.md` has AUTO_COMMIT=1, commit the changes for this plan item. If AUTO_PUSH=1 and a remote exists, push.

If any core files are missing, create minimal defaults (or ask the user to run `mario-init` to bootstrap templates).
