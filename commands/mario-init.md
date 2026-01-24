---
description: Bootstrap mario-devx files in current repo
---

Create mario-devx core files in this repo if missing.

Detect mario-devx skill install path:
!`if [ -d .opencode/skills/mario-devx ]; then echo "skill=.opencode/skills/mario-devx"; elif [ -d "$HOME/.config/opencode/skills/mario-devx" ]; then echo "skill=$HOME/.config/opencode/skills/mario-devx"; else echo "skill="; fi`

Bootstrap folders:
!`mkdir -p .mario/specs .mario/state .mario/prompts scripts`

Bootstrap docs (do not overwrite existing files):
!`SKILL_DIR=$(if [ -d .opencode/skills/mario-devx ]; then echo .opencode/skills/mario-devx; elif [ -d "$HOME/.config/opencode/skills/mario-devx" ]; then echo "$HOME/.config/opencode/skills/mario-devx"; fi); if [ -n "$SKILL_DIR" ] && [ -d "$SKILL_DIR/templates" ]; then cp -n "$SKILL_DIR/templates/PRD.md" .mario/PRD.md 2>/dev/null || true; cp -n "$SKILL_DIR/templates/AGENTS.md" .mario/AGENTS.md 2>/dev/null || true; cp -n "$SKILL_DIR/templates/IMPLEMENTATION_PLAN.md" .mario/IMPLEMENTATION_PLAN.md 2>/dev/null || true; cp -n "$SKILL_DIR/templates/state/feedback.md" .mario/state/feedback.md 2>/dev/null || true; cp -n "$SKILL_DIR/templates/progress.md" .mario/progress.md 2>/dev/null || true; cp -n "$SKILL_DIR/templates/mario.gitignore" .mario/.gitignore 2>/dev/null || true; else echo "No templates found; will create minimal defaults."; fi`
!`test -f .mario/PRD.md || printf '%s\n' '# PRD' > .mario/PRD.md`
!`test -f .mario/AGENTS.md || printf '%s\n' '# AGENTS' > .mario/AGENTS.md`
!`test -f .mario/IMPLEMENTATION_PLAN.md || printf '%s\n' '# IMPLEMENTATION PLAN' > .mario/IMPLEMENTATION_PLAN.md`
!`test -f .mario/state/feedback.md || printf '%s\n' 'Status: NONE' > .mario/state/feedback.md`
!`test -f .mario/progress.md || printf '%s\n' '# Mario Progress' > .mario/progress.md`

Bootstrap prompts (do not overwrite existing files):
!`SKILL_DIR=$(if [ -d .opencode/skills/mario-devx ]; then echo .opencode/skills/mario-devx; elif [ -d "$HOME/.config/opencode/skills/mario-devx" ]; then echo "$HOME/.config/opencode/skills/mario-devx"; fi); if [ -n "$SKILL_DIR" ] && [ -d "$SKILL_DIR/prompts" ]; then cp -n "$SKILL_DIR/prompts/PROMPT_prd.md" .mario/prompts/PROMPT_prd.md 2>/dev/null || true; cp -n "$SKILL_DIR/prompts/PROMPT_plan.md" .mario/prompts/PROMPT_plan.md 2>/dev/null || true; cp -n "$SKILL_DIR/prompts/PROMPT_build.md" .mario/prompts/PROMPT_build.md 2>/dev/null || true; cp -n "$SKILL_DIR/prompts/PROMPT_verify_llm.md" .mario/prompts/PROMPT_verify_llm.md 2>/dev/null || true; else echo "No prompts found to copy."; fi`

Bootstrap loop scripts (optional, do not overwrite existing files):
!`SKILL_DIR=$(if [ -d .opencode/skills/mario-devx ]; then echo .opencode/skills/mario-devx; elif [ -d "$HOME/.config/opencode/skills/mario-devx" ]; then echo "$HOME/.config/opencode/skills/mario-devx"; fi); if [ -n "$SKILL_DIR" ] && [ -d "$SKILL_DIR/scripts" ]; then cp -n "$SKILL_DIR/scripts/mario-loop.sh" scripts/mario-loop.sh 2>/dev/null || true; cp -n "$SKILL_DIR/scripts/mario-paths.sh" scripts/mario-paths.sh 2>/dev/null || true; cp -n "$SKILL_DIR/scripts/verify.sh" scripts/verify.sh 2>/dev/null || true; cp -n "$SKILL_DIR/scripts/verify-all.sh" scripts/verify-all.sh 2>/dev/null || true; cp -n "$SKILL_DIR/scripts/verify-llm.sh" scripts/verify-llm.sh 2>/dev/null || true; chmod +x scripts/mario-loop.sh scripts/mario-paths.sh scripts/verify.sh scripts/verify-all.sh scripts/verify-llm.sh 2>/dev/null || true; else echo "No scripts found to copy."; fi`

Required outputs:
- `.mario/PRD.md`
- `.mario/AGENTS.md`
- `.mario/IMPLEMENTATION_PLAN.md`
- `.mario/specs/` directory
- `.mario/state/feedback.md`
- `.mario/progress.md`
- `.mario/prompts/*`

Then, open `.mario/PRD.md` and ask me exactly one question to start the interview.
