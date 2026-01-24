# Ralph PRD Alignment Notes

This repo's PRD flow is aligned to the existing `ralph-prd` skill installed at:

- `~/.config/opencode/skill/ralph-prd/SKILL.md`

Key requirements we intentionally mirror:

- Ask clarifying questions in rounds with lettered options so users can answer quickly (eg "1A, 2C").
- Always ask about quality gates early.
- PRD contains a dedicated "Quality Gates" section used as global acceptance/backpressure.
- PRD expresses work as small user stories with acceptance criteria.
- Never implement during PRD generation.

Differences (intentional):

- mario-devx stores the PRD in `PRD.md` (instead of defaulting to `tasks/prd.md`).
- mario-devx uses an additional brick plan file (`IMPLEMENTATION_PLAN.md`) and loop scripts.
