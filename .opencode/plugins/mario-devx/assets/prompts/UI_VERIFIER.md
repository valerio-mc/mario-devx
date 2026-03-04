# mario-devx UI Verifier Playbook

This playbook defines how to autonomously verify website UI with `agent-browser`.

## Core command contract

- Use `agent-browser open <url>` to navigate.
- Use `agent-browser snapshot` to inspect page structure and refs.
- Use `agent-browser console --limit=50` to inspect console logs.
- Use `agent-browser errors` to inspect page/runtime errors.
- Use `agent-browser close` to close the browser session.

Do not assume unsupported flags. If uncertain, run `agent-browser --help` first.

## Skill-grounded command usage (required)

- Before interactive exploration, read the first existing file from:
  - `.opencode/skills/agent-browser/SKILL.md`
  - `~/.config/opencode/skills/agent-browser/SKILL.md`
- Treat that SKILL.md as command/safety reference for this verifier phase.
- If neither path exists, fall back to `agent-browser --help`.

## Autonomous verification workflow

0. Read agent-browser SKILL.md once for this verifier phase (or `agent-browser --help` fallback).
1. If `UI verification evidence` is already present in prompt context, use it first and only run fresh browser commands when that evidence is missing or clearly inconclusive.
2. Open the UI URL.
3. Collect one full snapshot and at least one interactive snapshot (`snapshot -i`) when available.
4. If needed, interact with the UI (click/fill/find/get) to validate acceptance behaviors.
5. Validate PRD scope for the current task using concrete evidence from snapshot/text.
6. Check console and runtime errors.
7. Evaluate aesthetics using the balanced rubric below.

## Balanced aesthetic rubric

Score each criterion from 0 to 2.

- Hierarchy and typography
  - 0: unreadable/incoherent
  - 1: acceptable but rough
  - 2: clear, intentional hierarchy
- Spacing and layout rhythm
  - 0: cluttered/broken
  - 1: mostly usable with inconsistencies
  - 2: consistent and deliberate
- Contrast and readability
  - 0: poor readability
  - 1: readable with minor issues
  - 2: clear readable contrast
- Component consistency
  - 0: mixed/unrelated styles
  - 1: mostly consistent
  - 2: cohesive system feel
- Style-reference alignment (if references exist)
  - 0: clearly mismatched
  - 1: partially aligned
  - 2: aligned direction

Balanced pass policy:

- For scaffold/foundation tasks, allow minor visual roughness if UX and structure are correct.
- Fail only for major visual mismatch, broken usability, or PRD contradiction.

Reporting requirement:

- Include a compact rubric summary in verifier reasons, for example:
  - `Rubric: hierarchy=1 spacing=1 contrast=2 consistency=1 styleRef=1 (balanced PASS)`
- If failing on aesthetics, explicitly state which rubric dimensions are below acceptable threshold.

## Evidence standards

- Every PASS/FAIL statement must cite concrete evidence:
  - a file path,
  - gate result,
  - or explicit browser evidence (snapshot/console/errors output).
- Do not use vague statements like "looks good".

## Safety

- Use read-oriented browser checks only for verification.
- Do not modify source files in verifier mode.
