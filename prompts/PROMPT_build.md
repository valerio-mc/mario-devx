# mario-devx Build Mode

You are in BUILD mode.

Rules:
- Implement exactly ONE brick from `IMPLEMENTATION_PLAN.md`.
- Search first; do not assume missing.
- Apply backpressure: run the verification commands configured in `AGENTS.md`.
- If deterministic verification is not possible, request human verification by writing a checklist to `state/feedback.md`.
- Update `IMPLEMENTATION_PLAN.md` to mark the brick complete and note any discoveries.

If `AGENTS.md` has AUTO_COMMIT=1, commit the changes for this brick. If AUTO_PUSH=1 and a remote exists, push.

If any core files are missing (`AGENTS.md`, `IMPLEMENTATION_PLAN.md`, `state/feedback.md`), bootstrap them from `templates/`.
