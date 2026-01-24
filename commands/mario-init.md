---
description: Bootstrap mario-devx files in current repo
---

Create mario-devx core files in this repo if missing.

Detect mario-devx skill install path:
!`if [ -d .opencode/skills/mario-devx ]; then echo "skill=.opencode/skills/mario-devx"; elif [ -d "$HOME/.config/opencode/skills/mario-devx" ]; then echo "skill=$HOME/.config/opencode/skills/mario-devx"; else echo "skill="; fi`

Bootstrap folders:
!`mkdir -p specs state scripts`

Bootstrap docs (do not overwrite existing files):
!`SKILL_DIR=$(if [ -d .opencode/skills/mario-devx ]; then echo .opencode/skills/mario-devx; elif [ -d "$HOME/.config/opencode/skills/mario-devx" ]; then echo "$HOME/.config/opencode/skills/mario-devx"; fi); if [ -n "$SKILL_DIR" ] && [ -d "$SKILL_DIR/templates" ]; then cp -n "$SKILL_DIR/templates/PRD.md" PRD.md 2>/dev/null || true; cp -n "$SKILL_DIR/templates/AGENTS.md" AGENTS.md 2>/dev/null || true; cp -n "$SKILL_DIR/templates/IMPLEMENTATION_PLAN.md" IMPLEMENTATION_PLAN.md 2>/dev/null || true; mkdir -p specs state; cp -n "$SKILL_DIR/templates/state/feedback.md" state/feedback.md 2>/dev/null || true; else echo "No templates found; will create minimal defaults."; fi`
!`test -f PRD.md || printf '%s\n' '# PRD' > PRD.md`
!`test -f AGENTS.md || printf '%s\n' '# AGENTS' > AGENTS.md`
!`test -f IMPLEMENTATION_PLAN.md || printf '%s\n' '# IMPLEMENTATION PLAN' > IMPLEMENTATION_PLAN.md`
!`test -f state/feedback.md || printf '%s\n' 'Status: NONE' > state/feedback.md`

Bootstrap loop scripts (optional, do not overwrite existing files):
!`SKILL_DIR=$(if [ -d .opencode/skills/mario-devx ]; then echo .opencode/skills/mario-devx; elif [ -d "$HOME/.config/opencode/skills/mario-devx" ]; then echo "$HOME/.config/opencode/skills/mario-devx"; fi); if [ -n "$SKILL_DIR" ] && [ -d "$SKILL_DIR/scripts" ]; then cp -n "$SKILL_DIR/scripts/mario-loop.sh" scripts/mario-loop.sh 2>/dev/null || true; cp -n "$SKILL_DIR/scripts/verify.sh" scripts/verify.sh 2>/dev/null || true; cp -n "$SKILL_DIR/scripts/verify-llm.sh" scripts/verify-llm.sh 2>/dev/null || true; chmod +x scripts/mario-loop.sh scripts/verify.sh scripts/verify-llm.sh 2>/dev/null || true; else echo "No scripts found to copy."; fi`

Required outputs:
- `PRD.md`
- `AGENTS.md`
- `IMPLEMENTATION_PLAN.md`
- `specs/` directory
- `state/feedback.md`

Then, open `PRD.md` and ask me exactly one question to start the interview.
