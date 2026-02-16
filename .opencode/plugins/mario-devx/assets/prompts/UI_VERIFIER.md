# mario-devx UI Verifier Playbook

This playbook defines how to autonomously verify website UI with `agent-browser`.

## Core command contract

- Use `agent-browser open <url>` to navigate.
- Use `agent-browser snapshot` to inspect page structure and refs.
- Use `agent-browser console --limit=50` to inspect console logs.
- Use `agent-browser errors` to inspect page/runtime errors.
- Use `agent-browser close` to close the browser session.

Do not assume unsupported flags. If uncertain, run `agent-browser --help` first.

## Autonomous verification workflow

1. Open the UI URL.
2. Collect one full snapshot and at least one interactive snapshot (`snapshot -i`) when available.
3. Validate PRD scope for the current task using concrete evidence from snapshot/text.
4. Check console and runtime errors.
5. Evaluate aesthetics using the balanced rubric below.

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

## Evidence standards

- Every PASS/FAIL statement must cite concrete evidence:
  - a file path,
  - gate result,
  - or explicit browser evidence (snapshot/console/errors output).
- Do not use vague statements like "looks good".

## Safety

- Use read-oriented browser checks only for verification.
- Do not modify source files in verifier mode.
