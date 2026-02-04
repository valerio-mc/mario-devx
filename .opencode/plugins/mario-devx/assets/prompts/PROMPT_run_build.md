# mario-devx Run Build Mode

You are in the BUILD phase of `/mario-devx:run`.

Canonical files:
- `.mario/prd.json` (requirements + task list + quality gates)
- `.mario/AGENTS.md` (harness knobs)
- `.mario/state/state.json` (internal state)
- `.mario/runs/*` (evidence)

Rules:
- Before doing anything else, read the most recent verifier verdict in `.mario/runs/*/judge.out` (use `.mario/state/state.json` to find the latest runDir).
- Implement exactly ONE task (the tool invocation provides the task ID and a task block).
- Search first; do not assume missing.
- Apply backpressure: run the verification commands configured in `.mario/prd.json` (`qualityGates`) and any overrides in `.mario/AGENTS.md` (`CMD_*`).
- If deterministic verification is not possible, request human verification by setting `HITL_REQUIRED=1` in `.mario/AGENTS.md` and writing a checklist into the task's `doneWhen` / `evidence` / `notes` fields in `.mario/prd.json`.
- Do not modify `.opencode/plugins/mario-devx/**`.


Next.js scaffolding note (common failure):
- If you scaffold a Next.js app in a repo that already contains `.mario/` and `.opencode/`, `create-next-app .` often refuses because the directory is not empty.
- Use a temp directory and copy the scaffold into the repo root instead.
  - Example:
    - `tmpdir=$(mktemp -d)`
    - `npx create-next-app@latest "$tmpdir/app" --yes --typescript --eslint --app`
    - copy files into repo root (exclude `.mario/` and `.opencode/`)

Commit rules:
- If `AUTO_COMMIT=1`, commit only after verification passes.
- Commit messages must start with the task ID, e.g. `T-0007: ...`.

If `AGENTS.md` has AUTO_COMMIT=1, commit the changes for this task. If AUTO_PUSH=1 and a remote exists, push.

If any core files are missing, create minimal defaults (or ask the user to run `mario-init` to bootstrap templates).
