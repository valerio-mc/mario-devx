import type { PrdJudgeAttempt, PrdTaskAttempt } from "./prd";

export const isPassEvidenceLine = (line: string): boolean => {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return false;
  if (/^ui verification:\s*pass\b/i.test(trimmed)) return true;
  return /^[\w./:\-\s]+:\s*PASS\b/i.test(trimmed);
};

export const firstActionableJudgeReason = (judge: PrdJudgeAttempt | undefined): string | null => {
  if (!judge) return null;
  const reasons = (judge.reason ?? []).map((x) => String(x).trim()).filter(Boolean);
  if (reasons.length === 0) return null;
  const actionable = reasons.find((line) => {
    if (/^ReasonCode:\s*[A-Z0-9_]+/i.test(line)) return false;
    return !isPassEvidenceLine(line);
  });
  return actionable ?? reasons[0] ?? null;
};

export const selectTopJudgeReason = (attempt: PrdTaskAttempt | undefined): string => {
  const reasons = (attempt?.judge.reason ?? []).map((x) => String(x).trim()).filter(Boolean);
  if (reasons.length === 0) return "No judge reason recorded.";
  if (attempt?.judge.status === "FAIL") {
    const reasonCode = reasons.find((line) => /^ReasonCode:\s*[A-Z0-9_]+/i.test(line));
    const actionable = reasons.find((line) => !/^ReasonCode:\s*[A-Z0-9_]+/i.test(line) && !isPassEvidenceLine(line));
    if (actionable && reasonCode) return `${actionable} (${reasonCode})`;
    if (actionable) return actionable;
    if (reasonCode) return reasonCode;
  }
  return reasons[0] ?? "No judge reason recorded.";
};
