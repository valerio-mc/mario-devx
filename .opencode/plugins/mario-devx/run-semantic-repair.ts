import { RUN_REASON } from "./run-contracts";
import type { PrdGateFailure, PrdJudgeAttempt, PrdTask, PrdUiAttempt } from "./prd";

type UiVerificationReceipt = {
  ok: boolean;
  note?: string;
  evidence?: PrdUiAttempt["evidence"];
};

export const runSemanticRepairLoop = async (opts: {
  ctx: any;
  repoRoot: string;
  workspaceAbs: string;
  task: PrdTask;
  doneWhen: string[];
  runId: string;
  gateCommands: Array<{ name: string; command: string }>;
  carryForwardIssues: string[];
  maxTotalRepairAttempts: number;
  totalRepairAttempts: number;
  latestGateResult: Awaited<ReturnType<any>>;
  latestUiResult: UiVerificationReceipt | null;
  uiVerifyEnabled: boolean;
  uiVerifyRequired: boolean;
  isWebApp: boolean;
  cliOk: boolean;
  skillOk: boolean;
  browserOk: boolean;
  uiVerifyUrl: string;
  uiVerifyCmd: string;
  visualDirection: string;
  uxRequirements: string[];
  styleReferences: string[];
  agentBrowserCaps: {
    available: boolean;
    version: string | null;
    commands: string[];
    openUsage: string | null;
    notes: string[];
  };
  verifyAgent?: string;
  limits: { maxVerifierRepairAttempts: number };
  buildPrompt: (repoRoot: string, mode: "verify", extra?: string) => Promise<string>;
  buildVerifierContextText: (opts: any) => string;
  buildCapabilitySummary: (caps: {
    available: boolean;
    version: string | null;
    openUsage: string | null;
    commands: string[];
    notes: string[];
  }) => string;
  resolveVerifierJudge: (opts: {
    ctx: any;
    repoRoot: string;
    verifierPrompt: string;
    runId: string;
    taskId: string;
    capabilitySummary: string;
    agent?: string;
  }) => Promise<{ judge: PrdJudgeAttempt } | { transportFailure: PrdJudgeAttempt; errorMessage: string }>;
  applyRepeatedFailureBackpressure: (previous: any, judge: PrdJudgeAttempt) => PrdJudgeAttempt;
  firstActionableJudgeReason: (judge: PrdJudgeAttempt | undefined) => string | null;
  buildSemanticRepairPrompt: (opts: {
    taskId: string;
    acceptance: string[];
    actionableReason: string;
    judge: PrdJudgeAttempt;
    carryForwardIssues: string[];
    strictChecklist: string;
    gateFailure?: PrdGateFailure | null;
    uiUrl?: string | null;
    uiEvidence?: PrdUiAttempt["evidence"] | null;
  }) => string;
  promptWorkSessionWithTimeout: (phase: "semantic-repair", text: string) => Promise<{ ok: true; idleSequenceBeforePrompt: number; baselineAssistantCount: number } | { ok: false }>;
  waitForWorkIdleAfterPrompt: (dispatch: { idleSequenceBeforePrompt: number; baselineAssistantCount: number }, phase: "semantic-repair") => Promise<boolean>;
  heartbeatRunLock: () => Promise<boolean>;
  blockForHeartbeatFailure: (phase: string) => Promise<void>;
  captureWorkspaceSnapshot: (repoRoot: string) => Promise<Map<string, string>>;
  summarizeWorkspaceDelta: (before: Map<string, string>, after: Map<string, string>) => { changed: number };
  runGateCommands: (commands: Array<{ name: string; command: string }>, $: any, workdirAbs?: string) => Promise<any>;
  logGateRunResults: (phase: "repair", taskId: string, gateResults: any[]) => Promise<void>;
  runUiVerifyForTask: (taskId: string) => Promise<UiVerificationReceipt | null>;
  toGatesAttempt: (result: any) => any;
  toUiAttempt: (opts: {
    gateOk: boolean;
    uiResult: UiVerificationReceipt | null;
    uiVerifyEnabled: boolean;
    isWebApp: boolean;
    cliOk: boolean;
    skillOk: boolean;
    browserOk: boolean;
  }) => any;
  failEarly: (reasonLines: string[], nextActions?: string[]) => Promise<void>;
  showToast: (ctx: any, message: string, variant?: "info" | "success" | "warning" | "error") => Promise<void>;
}): Promise<{
  blockedByVerifierFailure: boolean;
  semanticGateRegression: boolean;
  judge: PrdJudgeAttempt | null;
  totalRepairAttempts: number;
  latestGateResult: any;
  latestUiResult: UiVerificationReceipt | null;
  gates: any;
  ui: any;
}> => {
  const {
    ctx,
    repoRoot,
    workspaceAbs,
    task,
    doneWhen,
    runId,
    gateCommands,
    carryForwardIssues,
    maxTotalRepairAttempts,
    uiVerifyEnabled,
    uiVerifyRequired,
    isWebApp,
    cliOk,
    skillOk,
    browserOk,
    uiVerifyUrl,
    uiVerifyCmd,
    visualDirection,
    uxRequirements,
    styleReferences,
    agentBrowserCaps,
    verifyAgent,
    limits,
    buildPrompt,
    buildVerifierContextText,
    buildCapabilitySummary,
    resolveVerifierJudge,
    applyRepeatedFailureBackpressure,
    firstActionableJudgeReason,
    buildSemanticRepairPrompt,
    promptWorkSessionWithTimeout,
    waitForWorkIdleAfterPrompt,
    heartbeatRunLock,
    blockForHeartbeatFailure,
    captureWorkspaceSnapshot,
    summarizeWorkspaceDelta,
    runGateCommands,
    logGateRunResults,
    runUiVerifyForTask,
    toGatesAttempt,
    toUiAttempt,
    failEarly,
    showToast,
  } = opts;

  let blockedByVerifierFailure = false;
  let semanticGateRegression = false;
  let judge: PrdJudgeAttempt | null = null;
  let semanticRepairAttempts = 0;
  let semanticNoProgressStreak = 0;
  let verifierPassAttempts = 0;
  let totalRepairAttempts = opts.totalRepairAttempts;
  let latestGateResult = opts.latestGateResult;
  let latestUiResult = opts.latestUiResult;
  let gates = toGatesAttempt(latestGateResult);
  let ui = toUiAttempt({ gateOk: latestGateResult.ok, uiResult: latestUiResult, uiVerifyEnabled, isWebApp, cliOk, skillOk, browserOk });

  while (true) {
    verifierPassAttempts += 1;
    await showToast(ctx, `Run: verifier pass ${verifierPassAttempts} started for ${task.id}`, "info");

    const verifierPrompt = await buildPrompt(repoRoot, "verify", buildVerifierContextText({
      repoRoot,
      task,
      doneWhen,
      gates: latestGateResult.results,
      uiResult: latestUiResult,
      ...(latestUiResult?.note ? { uiNote: latestUiResult.note } : {}),
      visualDirection,
      uxRequirements,
      styleReferences,
      caps: agentBrowserCaps,
      uiUrl: uiVerifyUrl,
      uiCmd: uiVerifyCmd,
    }));

    const verifierOutcome = await resolveVerifierJudge({
      ctx,
      repoRoot,
      verifierPrompt,
      runId,
      taskId: task.id,
      capabilitySummary: buildCapabilitySummary(agentBrowserCaps),
      ...(verifyAgent ? { agent: verifyAgent } : {}),
    });
    await showToast(ctx, `Run: verifier response received for ${task.id}`, "info");

    if (!(await heartbeatRunLock())) {
      await blockForHeartbeatFailure("after-judge");
      blockedByVerifierFailure = true;
      break;
    }

    if ("transportFailure" in verifierOutcome) {
      await failEarly(verifierOutcome.transportFailure.reason, verifierOutcome.transportFailure.nextActions);
      blockedByVerifierFailure = true;
      break;
    }

    judge = applyRepeatedFailureBackpressure(task.lastAttempt, verifierOutcome.judge);
    if (judge.status === "PASS" && judge.exitSignal) break;

    if (semanticRepairAttempts >= limits.maxVerifierRepairAttempts || totalRepairAttempts >= maxTotalRepairAttempts) {
      break;
    }

    semanticRepairAttempts += 1;
    totalRepairAttempts += 1;
    await showToast(
      ctx,
      `Run: verifier requested changes; returning to work for ${task.id} (${semanticRepairAttempts}/${limits.maxVerifierRepairAttempts})`,
      "warning",
    );
    const actionableReason = firstActionableJudgeReason(judge) ?? "Verifier failed to confirm acceptance.";
    const strictChecklist = semanticNoProgressStreak > 0
      ? "Repeated finding detected with no clear progress. Make explicit file edits that directly satisfy acceptance criteria; avoid generic refinements."
      : "";
    const semanticRepairPrompt = buildSemanticRepairPrompt({
      taskId: task.id,
      acceptance: task.acceptance ?? [],
      actionableReason,
      judge,
      carryForwardIssues,
      strictChecklist,
      gateFailure: task.lastAttempt?.gates?.failure ?? null,
      uiUrl: uiVerifyUrl,
      uiEvidence: latestUiResult?.evidence ?? task.lastAttempt?.ui?.evidence ?? null,
    });

    const semanticSnapshotBefore = await captureWorkspaceSnapshot(repoRoot);
    const semanticPromptDispatch = await promptWorkSessionWithTimeout("semantic-repair", semanticRepairPrompt);
    if (!semanticPromptDispatch.ok) {
      blockedByVerifierFailure = true;
      break;
    }
    await showToast(
      ctx,
      `Run: semantic repair dispatched for ${task.id} (${semanticRepairAttempts}/${limits.maxVerifierRepairAttempts})`,
      "info",
    );

    if (!(await heartbeatRunLock())) {
      await blockForHeartbeatFailure("during-semantic-repair");
      blockedByVerifierFailure = true;
      break;
    }

    const semanticIdleOk = await waitForWorkIdleAfterPrompt(semanticPromptDispatch, "semantic-repair");
    if (!semanticIdleOk) {
      blockedByVerifierFailure = true;
      break;
    }
    await showToast(ctx, `Run: semantic repair idle for ${task.id}`, "success");

    const semanticSnapshotAfter = await captureWorkspaceSnapshot(repoRoot);
    const semanticDelta = summarizeWorkspaceDelta(semanticSnapshotBefore, semanticSnapshotAfter);
    if (semanticDelta.changed === 0) {
      semanticNoProgressStreak += 1;
      if (semanticNoProgressStreak >= 2 || semanticRepairAttempts >= limits.maxVerifierRepairAttempts) {
        await failEarly([
          `ReasonCode: ${RUN_REASON.WORK_SESSION_NO_PROGRESS}`,
          `No source file changes detected after semantic repair attempt ${semanticRepairAttempts}.`,
          `Primary blocker remains: ${actionableReason}`,
        ]);
        blockedByVerifierFailure = true;
        break;
      }
    } else {
      semanticNoProgressStreak = 0;
    }

    latestGateResult = await runGateCommands(gateCommands, ctx.$, workspaceAbs);
    await logGateRunResults("repair", task.id, latestGateResult.results);
    latestUiResult = latestGateResult.ok ? await runUiVerifyForTask(task.id) : null;
    gates = toGatesAttempt(latestGateResult);
    ui = toUiAttempt({ gateOk: latestGateResult.ok, uiResult: latestUiResult, uiVerifyEnabled, isWebApp, cliOk, skillOk, browserOk });

    if (uiVerifyEnabled && isWebApp && uiVerifyRequired) {
      const uiFailed = latestUiResult ? !latestUiResult.ok : true;
      if (uiFailed) {
        await failEarly([
          `ReasonCode: ${RUN_REASON.UI_VERIFY_FAILED}`,
          latestUiResult?.note?.trim() || "UI verification failed.",
        ]);
        blockedByVerifierFailure = true;
        judge = null;
        break;
      }
    }

    if (!latestGateResult.ok) {
      semanticGateRegression = true;
      break;
    }
  }

  return {
    blockedByVerifierFailure,
    semanticGateRegression,
    judge,
    totalRepairAttempts,
    latestGateResult,
    latestUiResult,
    gates,
    ui,
  };
};
