---
description: Bootstrap mario-devx files in current repo
---

Create mario-devx core files in this repo if missing by copying the templates shipped with the mario-devx skill.

Prefer project-local skill path first, then global skill path:
- `.opencode/skills/mario-devx/templates/*`
- `~/.config/opencode/skills/mario-devx/templates/*`

If templates are not available, create the files with reasonable defaults.

Required outputs:
- `PRD.md`
- `AGENTS.md`
- `IMPLEMENTATION_PLAN.md`
- `specs/` directory
- `state/feedback.md`

Then, open `PRD.md` and ask me exactly one question to start the interview.
