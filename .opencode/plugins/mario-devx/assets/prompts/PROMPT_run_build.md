# mario-devx Run Build Mode

You are in the BUILD phase of `/mario-devx:run`.

Canonical files:
- `.mario/prd.json` (requirements + task list + quality gates)
- `.mario/AGENTS.md` (harness knobs)
- `.mario/state/state.json` (internal state)

Rules:
- Before doing anything else, read `.mario/prd.json` for the current task and its `lastAttempt` (if any).
- Implement exactly ONE task (the tool invocation provides the task ID and a task block).
- Search first; do not assume missing.
- Apply backpressure using project-defined verification in `.mario/prd.json` (`tasks[].doneWhen`, `verificationPolicy.taskGates`, `verificationPolicy.globalGates`).
- If deterministic verification is not possible, report the limitation in chat and continue with smallest verifiable code change; do NOT edit `.mario/prd.json` directly.
- Do not modify `.opencode/plugins/mario-devx/**`.
- Do not edit control-plane files directly: `.mario/prd.json`, `.mario/state/state.json`, `.mario/AGENTS.md`.

Prime directive:
- Do not advance. You are not done unless the deterministic gates pass and the verifier outputs `Status: PASS` + `EXIT_SIGNAL: true`.

Stop conditions (do not guess):
- If the task block you received does not match `.mario/prd.json` for that task id, STOP and mark the task `blocked` with a short note describing the mismatch.
- If the task's `doneWhen` is missing, vague, or cannot be verified, STOP and explain what is unverifiable; do not edit `.mario/prd.json` directly.

No-magic rule:
- Do not write vague work like "update the logic" or "refactor the component".
- Every change must point to specific files and concrete behaviors (example: "Modify `src/auth.ts` to add `validate()` handling X").

Minimal-change rule:
- Prefer the smallest change that satisfies `doneWhen`.
- Delete dead code instead of adding wrappers; do not add boilerplate comments.

UI style-reference rule:
- If `.mario/prd.json` includes `ui.styleReferences`, inspect them before implementing UI-facing changes.
- For URL references, fetch and analyze the visual direction (layout density, typography hierarchy, color mood, spacing, radius/shadow patterns).
- For local image references, read the file and extract the same visual cues.
- If direct inspection is not possible with available tools, try `agent-browser` commands when appropriate (for example to open/snapshot a referenced URL), then proceed with best-effort implementation and state the limitation in chat.
- Convert extracted cues into concrete implementation choices (tokens/variables/classes/components) instead of generic imitation.


Next.js scaffolding note (common failure):
- If you scaffold a Next.js app in a repo that already contains `.mario/` and `.opencode/`, `create-next-app .` often refuses because the directory is not empty.
- Use a temp directory and copy the scaffold into the repo root instead.
  - Example:
    - `tmpdir=$(mktemp -d)`
    - `npx create-next-app@latest "$tmpdir/app" --yes --typescript --eslint --app`
    - copy files into repo root (exclude `.mario/` and `.opencode/`)

If any core files are missing, ask the user to rerun `/mario-devx:new` (or run `/mario-devx:new` in a clean repo) so the plugin can seed `.mario/prd.json` and `.mario/AGENTS.md`.
