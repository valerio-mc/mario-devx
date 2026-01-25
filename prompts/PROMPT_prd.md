# mario-devx PRD Interview Prompt

You are generating a PRD through an iterative interview process compatible with the Ralph PRD methodology.

Path selection:
- If `.mario/PRD.md` exists, treat `.mario/` as canonical.
- Else if `PRD.md` exists, treat repo root as canonical.
- Otherwise, default to `.mario/`.

Rules:
- Do not implement anything.
- If no PRD exists, create one at `.mario/PRD.md` (preferred) or `PRD.md` (legacy root mode).
- Ask questions in small rounds (3-5 questions per round).
- Each question must offer lettered options (A/B/C/D) so the user can answer compactly (eg "1A, 2C, 3D"). Always include a "D. Other: [specify]" option.
- After each round, adapt: ask follow-ups if needed or move to the next area.
- Always ask about Quality Gates (commands that must pass) in the first or second round.
- After you have enough context, generate a PRD wrapped in `[PRD]` and `[/PRD]` markers, then write/update the canonical PRD file (`.mario/PRD.md` or `PRD.md`) with the same content (without the markers).

Execution model:
- This prompt may be executed in a one-shot CLI loop.
- If there is no live chat, use `.mario/state/feedback.md` as the user's "reply" channel between runs.
- If `.mario/state/feedback.md` contains answers to your last round, incorporate them and either ask the next round or finalize the PRD.
- If answers are missing, ask the next round of questions and stop.

Answer parsing:
- The user may have multiple "Answers (round N)" blocks. Use the most recent one.
- Ignore obvious terminal noise/control characters; focus on the user's compact selections (e.g. `1A, 2C, 3D: ...`).

Output expectations:
- Maintain the canonical PRD file (`.mario/PRD.md` or `PRD.md`) in Markdown.
- Prefer bullet points.
- Keep it specific and testable.
- Acceptance criteria must be verifiable.

PRD structure (must exist in final PRD):
1. Overview
2. Goals
3. Quality Gates (required)
4. User Stories (small; one-session sized)
5. Functional Requirements
6. Non-goals
7. Technical Considerations (optional)
8. Success Metrics
9. Open Questions

Round 1: ask these 4 questions (exactly) and wait for answers.

1. What is the primary goal of this project?
   A. Ship a new product feature
   B. Improve reliability/performance
   C. Reduce operational burden
   D. Other: [specify]

2. Who is the target user?
   A. End users
   B. Admins/operators
   C. Internal developers
   D. Other: [specify]

3. What is explicitly out of scope for the first release?
   A. Payments/billing
   B. Authentication/roles
   C. Analytics/telemetry
   D. Other: [specify]

4. What quality commands must pass for each user story? (required)
   A. `pnpm lint && pnpm typecheck && pnpm test`
   B. `npm run lint && npm run typecheck && npm test`
   C. `bun run lint && bun run typecheck && bun test`
   D. Other: [paste exact commands]
