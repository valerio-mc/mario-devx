import path from "path";
import type { AgentBrowserCapabilities } from "./agent-browser-capabilities";
import type { PrdGateAttempt, PrdJudgeAttempt, PrdTask, PrdUiAttempt } from "./prd";
import { isPassEvidenceLine } from "./judge-utils";

const sanitizeForPrompt = (text: string): string => {
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
};

export const buildVerifierContextText = (opts: {
  repoRoot: string;
  task: PrdTask;
  doneWhen: string[];
  gates: PrdGateAttempt[];
  uiResult: { ok: boolean; evidence?: PrdUiAttempt["evidence"] } | null;
  uiNote?: string;
  visualDirection?: string | null;
  uxRequirements?: string[];
  styleReferences?: string[];
  caps: AgentBrowserCapabilities;
  uiUrl: string;
  uiCmd?: string;
}): string => {
  const {
    repoRoot,
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
    uiCmd,
  } = opts;

  const configHome = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "~", ".config");
  const skillPathHints = [
    path.join(repoRoot, ".opencode", "skills", "agent-browser", "SKILL.md"),
    path.join(configHome, "opencode", "skills", "agent-browser", "SKILL.md"),
  ];

  const uiEvidenceLines = uiResult?.evidence
    ? [
        uiResult.evidence.snapshot ? `- Snapshot: ${uiResult.evidence.snapshot}` : "",
        uiResult.evidence.snapshotInteractive ? `- Snapshot (-i): ${uiResult.evidence.snapshotInteractive}` : "",
        uiResult.evidence.screenshot ? `- Screenshot: ${uiResult.evidence.screenshot}` : "",
        uiResult.evidence.console ? `- Console: ${uiResult.evidence.console}` : "",
        uiResult.evidence.errors ? `- Errors: ${uiResult.evidence.errors}` : "",
      ].filter(Boolean)
    : [];

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
    "- Skill grounding (required): read the first existing agent-browser SKILL.md path below at least once per verifier phase before interactive UI exploration.",
    ...skillPathHints.map((p) => `  - ${p}`),
    "- If SKILL.md is unavailable, run `agent-browser --help` and treat that as fallback command contract.",
    "",
    "Autonomous UI check policy:",
    `- UI URL: ${uiUrl}`,
    `- UI dev command: ${uiCmd || "(not provided)"}`,
    ...(uiEvidenceLines.length > 0
      ? [
          "- UI verification evidence is already provided below; treat it as primary evidence.",
          "- Evidence paths below are repository-local artifacts under .mario/state/ui-evidence/.",
          "- Do NOT run additional agent-browser commands unless this evidence is missing or clearly inconclusive.",
          "- Prefer snapshot/console/errors. If still inconclusive and a Screenshot path is provided, you may Read that file.",
        ]
      : [
          "- You may run agent-browser commands autonomously to gather missing evidence.",
          "- If the URL is unreachable, run the UI dev command first before retrying browser checks.",
        ]),
    "- Maximum 8 browser commands for this verification pass.",
    "- Prefer snapshot/console/errors evidence before issuing FAIL.",
    ...(uiEvidenceLines.length > 0 ? ["", "UI verification evidence:", ...uiEvidenceLines] : []),
  ]
    .filter((x) => x)
    .join("\n"));
};

export const enforceJudgeOutputQuality = (judge: PrdJudgeAttempt): PrdJudgeAttempt => {
  if (judge.status === "FAIL") {
    const reasons = (judge.reason ?? []).map((x) => String(x).trim()).filter(Boolean);
    if (reasons.length > 1) {
      const reasonCodes = reasons.filter((line) => /^ReasonCode:\s*[A-Z0-9_]+/i.test(line));
      const nonPassReasons = reasons.filter((line) => !isPassEvidenceLine(line) && !/^ReasonCode:\s*[A-Z0-9_]+/i.test(line));
      const passEvidence = reasons.filter((line) => isPassEvidenceLine(line));
      const reordered = [...reasonCodes, ...nonPassReasons, ...passEvidence];
      judge = { ...judge, reason: reordered.length > 0 ? reordered : reasons };
    }

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
