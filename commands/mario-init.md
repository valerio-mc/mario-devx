---
description: Bootstrap mario-devx files in current repo
---

Install Mario DevX into the current project.

Default behavior installs from `main`. Pin by setting `MARIO_DEVX_REF`.

Install:
!`curl -fsSL "https://raw.githubusercontent.com/valerio-mc/mario-devx/${MARIO_DEVX_REF:-main}/install.sh" | bash`

Then run:
- `scripts/mario prd`
