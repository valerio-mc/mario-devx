import type { PrdJson } from "./prd";

// This file previously contained deterministic interview update logic.
// The PRD wizard now relies entirely on LLM-based parsing through the interview prompt.
// This file is kept for backward compatibility but no longer contains active logic.

export type DeterministicInterviewResult = {
  handled: boolean;
  prd: PrdJson;
  error?: string;
};

// No-op function - all interview processing is now LLM-driven
export const applyDeterministicInterviewUpdate = (
  prd: PrdJson,
  _missingField: string,
  _answer: string,
): DeterministicInterviewResult => {
  return { handled: false, prd };
};
