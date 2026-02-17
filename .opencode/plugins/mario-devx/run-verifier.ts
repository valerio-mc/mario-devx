import type { AgentBrowserCapabilities } from "./agent-browser-capabilities";
import type { PrdGateAttempt, PrdJudgeAttempt, PrdTask, PrdUiAttempt } from "./prd";

const sanitizeForPrompt = (text: string): string => {
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
};

export const buildVerifierContextText = (opts: {
  task: PrdTask;
  doneWhen: string[];
  gates: PrdGateAttempt[];
  uiResult: { ok: boolean } | null;
  uiNote?: string;
  visualDirection?: string | null;
  uxRequirements?: string[];
  styleReferences?: string[];
  caps: AgentBrowserCapabilities;
  uiUrl: string;
}): string => {
  const {
    task,
    doneWhen,
    gates,
    uiResult,
    uiNote,
    visualDirection,
    uxRequirements,
    styleReferences,
    caps,
    uiUrl,
  } = opts;

  return sanitizeForPrompt([
    `Task: ${task.id} - ${task.title}`,
    doneWhen.length > 0
      ? `Done when:\n${doneWhen.map((d) => `- ${d}`).join("\n")}`
      : "Done when: (none)",
    "",
    "Deterministic gates:",
    ...gates.map((r) => `- ${r.command}: ${r.ok ? "PASS" : `FAIL (exit ${r.exitCode})`}`),
    uiResult ? `UI verification: ${uiResult.ok ? "PASS" : "FAIL"}` : "UI verification: (not run)",
    uiNote ? `UI note: ${uiNote}` : "",
    "",
    "UI product context:",
    `- Visual direction: ${visualDirection || "unspecified"}`,
    `- UX requirements: ${(uxRequirements ?? []).join("; ") || "unspecified"}`,
    `- Style references: ${(styleReferences ?? []).join(", ") || "none"}`,
    "",
    "agent-browser capabilities:",
    `- Available: ${caps.available ? "yes" : "no"}`,
    `- Version: ${caps.version ?? "unknown"}`,
    `- Open usage: ${caps.openUsage ?? "unknown"}`,
    `- Commands: ${caps.commands.join(", ") || "none"}`,
    ...(caps.notes.length > 0 ? [`- Notes: ${caps.notes.join("; ")}`] : []),
    "",
    "Autonomous UI check policy:",
    `- UI URL: ${uiUrl}`,
    "- You may run agent-browser commands autonomously to gather missing evidence.",
    "- Maximum 8 browser commands for this verification pass.",
    "- Prefer snapshot/console/errors evidence before issuing FAIL.",
  ]
    .filter((x) => x)
    .join("\n"));
};

export const enforceJudgeOutputQuality = (judge: PrdJudgeAttempt): PrdJudgeAttempt => {
  if (judge.status === "FAIL") {
    const nextActions = (judge.nextActions ?? []).map((x) => String(x).trim()).filter(Boolean);
    if (nextActions.length < 2) {
      nextActions.push("Retry /mario-devx:run 1.");
      nextActions.push("If it repeats, inspect .mario/state/mario-devx.log for verifier diagnostics.");
      judge = { ...judge, nextActions: Array.from(new Set(nextActions)) };
    }
  }
  return judge;
};

export const buildVerifierTransportFailureJudge = (reasonCode: string, detail: string): PrdJudgeAttempt => {
  return {
    status: "FAIL",
    exitSignal: false,
    reason: [
      `ReasonCode: ${reasonCode}`,
      detail,
    ],
    nextActions: [
      "Retry /mario-devx:run 1.",
      "If it repeats, inspect .mario/state/mario-devx.log for run.verify.transport.error.",
    ],
  };
};
