import type { PrdGateFailure, PrdJson, PrdJudgeAttempt, PrdTask } from "./prd";

export const formatGateFailureBackpressure = (failure: PrdGateFailure | null | undefined): string => {
  if (!failure) return "";
  return [
    "Backpressure payload (deterministic gate failure):",
    `- command: ${failure.command}`,
    `- exitCode: ${failure.exitCode}`,
    ...(failure.fingerprint ? [`- fingerprint: ${failure.fingerprint}`] : []),
    ...(failure.outputExcerpt ? [`- output (clipped):\n${failure.outputExcerpt}`] : []),
  ].join("\n");
};

export const buildIterationTaskPlan = (opts: {
  task: PrdTask;
  prd: PrdJson;
  effectiveDoneWhen: string[];
  carryForwardIssues: string[];
}): string => {
  const { task, prd, effectiveDoneWhen, carryForwardIssues } = opts;
  const gateBackpressure = task.status === "blocked"
    ? formatGateFailureBackpressure(task.lastAttempt?.gates?.failure)
    : "";
  return [
    `# Iteration Task (${task.id})`,
    "",
    `Title: ${task.title}`,
    "",
    `Status: ${task.status}`,
    gateBackpressure,
    task.scope.length > 0 ? `Scope: ${task.scope.join(", ")}` : "",
    task.acceptance && task.acceptance.length > 0 ? `Acceptance:\n${task.acceptance.map((a) => `- ${a}`).join("\n")}` : "Acceptance: (none)",
    effectiveDoneWhen.length > 0 ? `Done when:\n${effectiveDoneWhen.map((d) => `- ${d}`).join("\n")}` : "Done when: (none)",
    task.notes && task.notes.length > 0 ? `Notes:\n${task.notes.map((n) => `- ${n}`).join("\n")}` : "",
    prd.frontend
      ? [
          "UI context:",
          `- Design system: ${prd.ui.designSystem ?? "unspecified"}`,
          `- Visual direction: ${prd.ui.visualDirection || "unspecified"}`,
          `- UX requirements: ${(prd.ui.uxRequirements ?? []).join("; ") || "unspecified"}`,
          `- Style references: ${(prd.ui.styleReferences ?? []).join(", ") || "none"}`,
        ].join("\n")
      : "",
    prd.docs.readmeRequired
      ? `README policy: required sections -> ${(prd.docs.readmeSections ?? []).join(", ")}`
      : "README policy: optional",
    carryForwardIssues.length > 0
      ? `Previous verifier findings to fix now:\n${carryForwardIssues.map((x) => `- ${x}`).join("\n")}`
      : "",
  ]
    .filter((x) => x)
    .join("\n");
};

export const buildGateRepairPrompt = (opts: {
  taskId: string;
  gateFailure: PrdGateFailure | null;
  carryForwardIssues: string[];
  missingScript: string | null;
  scaffoldHint: string | null;
  scaffoldGateFailure: boolean;
}): string => {
  const { taskId, gateFailure, carryForwardIssues, missingScript, scaffoldHint, scaffoldGateFailure } = opts;
  const failedGate = gateFailure
    ? `${gateFailure.command} (exit ${gateFailure.exitCode})`
    : "(unknown command)";
  const gateBackpressure = formatGateFailureBackpressure(gateFailure);
  return [
    `Task ${taskId} failed deterministic gate: ${failedGate}.`,
    gateBackpressure,
    carryForwardIssues.length > 0
      ? `Carry-forward findings from previous verifier attempt:\n${carryForwardIssues.map((x) => `- ${x}`).join("\n")}`
      : "",
    scaffoldGateFailure
      ? "If project scaffold is missing, scaffold the app first before feature edits."
      : "",
    missingScript
      ? `Detected missing npm script '${missingScript}'. Add it to package.json and required config/files so it passes.`
      : "",
    scaffoldHint ? `Optional scaffold default: ${scaffoldHint}` : "",
    carryForwardIssues.length > 0
      ? "Prioritize fixing the carry-forward findings before adding unrelated changes."
      : "",
    "Fix the repository so all deterministic gates pass.",
    "Do not ask questions. Apply edits and stop when done.",
  ].join("\n");
};

export const buildSemanticRepairPrompt = (opts: {
  taskId: string;
  acceptance: string[];
  actionableReason: string;
  judge: PrdJudgeAttempt;
  carryForwardIssues: string[];
  strictChecklist: string;
  gateFailure?: PrdGateFailure | null;
}): string => {
  const { taskId, acceptance, actionableReason, judge, carryForwardIssues, strictChecklist, gateFailure } = opts;
  const gateBackpressure = formatGateFailureBackpressure(gateFailure);
  return [
    `Verifier failed for ${taskId}. Apply a focused semantic repair and stop when acceptance is clearly satisfied.`,
    acceptance.length > 0
      ? `Acceptance checklist:\n${acceptance.map((a) => `- ${a}`).join("\n")}`
      : "Acceptance checklist: (none)",
    `Primary failing reason: ${actionableReason}`,
    gateBackpressure,
    judge.reason && judge.reason.length > 0
      ? `Verifier reasons:\n${judge.reason.map((r) => `- ${r}`).join("\n")}`
      : "",
    judge.nextActions && judge.nextActions.length > 0
      ? `Verifier next actions:\n${judge.nextActions.map((a) => `- ${a}`).join("\n")}`
      : "",
    carryForwardIssues.length > 0
      ? `Carry-forward findings:\n${carryForwardIssues.map((x) => `- ${x}`).join("\n")}`
      : "",
    strictChecklist,
    "After edits, ensure deterministic gates pass, then verifier will run again.",
    "Do not ask questions. Make concrete file changes now.",
  ].filter(Boolean).join("\n\n");
};
