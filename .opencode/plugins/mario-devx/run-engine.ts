import { RUN_EVENT, RUN_REASON } from "./run-contracts";
import { RUN_PHASE, type RunPhaseName } from "./run-types";
import { LIMITS, TIMEOUTS } from "./config";
import { getNextPrdTask, getTaskDependencyBlockers, setPrdTaskLastAttempt, setPrdTaskStatus } from "./planner";
import { bumpIteration } from "./state";
import { updateRunState, waitForSessionIdleStableDetailed, setWorkSessionTitle } from "./runner";
import { writePrdJson, type PrdGatesAttempt, type PrdJudgeAttempt, type PrdJson, type PrdTask, type PrdTaskAttempt, type PrdUiAttempt } from "./prd";
import { runUiVerifyForTask as runUiVerifyForTaskPhase, checkAcceptanceArtifacts, resolveEffectiveDoneWhen, toGateCommands, toGatesAttempt, toUiAttempt, logGateRunResults as logGateRunResultsPhase, captureWorkspaceSnapshot, summarizeWorkspaceDelta } from "./run-phase-helpers";
import { buildIterationTaskPlan, buildGateRepairPrompt, buildSemanticRepairPrompt } from "./run-prompts";
import { buildPrompt } from "./prompt";
import { heartbeatRunLock, runLockPath } from "./run-lock";
import { getSessionIdleSequence } from "./session-idle-signal";
import { promptWorkSessionWithTimeout as promptWorkSessionWithTimeoutStep, resetWorkSessionWithTimeout as resetWorkSessionWithTimeoutStep } from "./run-work-session";
import { runGateRepairLoop } from "./run-gate-repair";
import { runSemanticRepairLoop } from "./run-semantic-repair";
import { finalizeRunSuccess } from "./run-finalize";

export type RunContext = {
  ctx: any;
  repoRoot: string;
  runId: string;
  controlSessionId?: string;
  workspaceRoot: "." | "app";
  workspaceAbs: string;
  sessionAgents: { workAgent: string; verifyAgent: string; streamWorkEvents: boolean; streamVerifyEvents: boolean };
  uiSetup: {
    uiVerifyEnabled: boolean;
    uiVerifyCmd: string;
    uiVerifyUrl: string;
    uiVerifyRequired: boolean;
    agentBrowserRepo: string;
    isWebApp: boolean;
    cliOk: boolean;
    skillOk: boolean;
    browserOk: boolean;
    autoInstallAttempted: string[];
    shouldRunUiVerify: boolean;
  };
  agentBrowserCaps: { available: boolean; version: string | null; commands: string[]; openUsage: string | null; notes: string[] };
  nowIso: () => string;
  runStartIteration: number;
};

export type TaskRunInput = {
  task: PrdTask;
  prd: PrdJson;
  effectiveDoneWhen: string[];
  carryForwardIssues: string[];
  gateCommands: Array<{ name: string; command: string }>;
};

export const runEngine = async (opts: {
  runCtx: RunContext;
  preflightPrd: PrdJson;
  maxItems: number;
  collectCarryForwardIssues: (task: PrdTask) => string[];
  formatReasonCode: (code: string) => string;
  firstActionableJudgeReason: (judge: PrdJudgeAttempt | undefined) => string | null;
  applyRepeatedFailureBackpressure: (previous: PrdTaskAttempt | undefined, judge: PrdJudgeAttempt) => PrdJudgeAttempt;
  resolveVerifierJudge: (opts: {
    ctx: any;
    repoRoot: string;
    verifierPrompt: string;
    runId: string;
    taskId: string;
    capabilitySummary: string;
    agent?: string;
  }) => Promise<{ judge: PrdJudgeAttempt } | { transportFailure: PrdJudgeAttempt; errorMessage: string }>;
  persistBlockedTaskAttempt: (opts: {
    ctx: any;
    repoRoot: string;
    prd: PrdJson;
    task: PrdTask;
    attemptAt: string;
    iteration: number;
    gates: PrdGatesAttempt;
    ui: PrdUiAttempt;
    judge: PrdJudgeAttempt;
    runId: string;
  }) => Promise<PrdJson>;
  showToast: (ctx: any, message: string, variant?: "info" | "success" | "warning" | "error") => Promise<void>;
  logRunEvent: (
    ctx: any,
    repoRoot: string,
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    runCtx?: { runId?: string; taskId?: string; reasonCode?: string },
  ) => Promise<void>;
  runShellWithFailureLog: (
    ctx: any,
    repoRoot: string,
    command: string,
    logMeta: {
      event: string;
      message: string;
      reasonCode?: string;
      runId?: string;
      taskId?: string;
      extra?: Record<string, unknown>;
    },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
  buildCapabilitySummary: (caps: { available: boolean; version: string | null; openUsage: string | null; commands: string[]; notes: string[] }) => string;
  buildRunSummary: (opts: { attempted: number; completed: number; maxItems: number; tasks: PrdTask[]; runNotes: string[]; uiVerifyRequired: boolean }) => { result: string; latestTask?: { id: string } | null; judgeTopReason?: string | null };
  logTaskComplete: (ctx: any, repoRoot: string, taskId: string, completed: number, total: number) => Promise<void>;
  logTaskBlocked: (ctx: any, repoRoot: string, taskId: string, reason: string) => Promise<void>;
  resetWorkSession: (ctx: any, repoRoot: string, agent: string | undefined) => Promise<{ sessionId: string; baselineMessageId: string }>;
  deleteSessionBestEffort: (ctx: any, sessionId: string | undefined, controlSessionId?: string) => Promise<"deleted" | "not-found" | "skipped-control" | "failed" | "none">;
}): Promise<string> => {
  const {
    runCtx,
    preflightPrd,
    maxItems,
    collectCarryForwardIssues,
    formatReasonCode,
    firstActionableJudgeReason,
    applyRepeatedFailureBackpressure,
    resolveVerifierJudge,
    persistBlockedTaskAttempt,
    showToast,
    logRunEvent,
    runShellWithFailureLog,
    buildCapabilitySummary,
    buildRunSummary,
    logTaskComplete,
    logTaskBlocked,
    resetWorkSession,
    deleteSessionBestEffort,
  } = opts;
  const { ctx, repoRoot, runId, controlSessionId, workspaceRoot, workspaceAbs, sessionAgents, uiSetup, agentBrowserCaps, nowIso, runStartIteration } = runCtx;
  const { uiVerifyEnabled, uiVerifyCmd, uiVerifyUrl, uiVerifyRequired, agentBrowserRepo, isWebApp, cliOk, skillOk, browserOk, autoInstallAttempted, shouldRunUiVerify } = uiSetup;

  let prd = preflightPrd;
  let attempted = 0;
  let completed = 0;

  const runLog = async (level: "info" | "warn" | "error", event: string, message: string, extra?: Record<string, unknown>, meta?: { runId?: string; taskId?: string; reasonCode?: string }): Promise<void> => {
    await logRunEvent(ctx, repoRoot, level, event, message, extra, meta);
  };

  const logGateRunResults = async (phase: RunPhaseName, taskId: string, gateResults: any[]): Promise<void> => {
    await logGateRunResultsPhase({
      phase,
      taskId,
      gateResults,
      runCtx: { runId, repoRoot, workspaceRoot, workspaceAbs, ...(controlSessionId ? { controlSessionId } : {}) },
      logRunEvent: runLog,
    });
  };

  const runUiVerifyForTask = async (taskId: string): Promise<{ ok: boolean; note?: string; evidence?: { snapshot?: string; snapshotInteractive?: string; console?: string; errors?: string } } | null> => {
    return runUiVerifyForTaskPhase({
      shouldRunUiVerify,
      taskId,
      ctx,
      uiVerifyCmd,
      uiVerifyUrl,
      waitMs: TIMEOUTS.UI_VERIFY_WAIT_MS,
      runCtx: { runId, repoRoot, workspaceRoot, workspaceAbs, ...(controlSessionId ? { controlSessionId } : {}) },
      logRunEvent: runLog,
    });
  };

  while (attempted < maxItems) {
    const task = getNextPrdTask(prd);
    if (!task) break;

    const dependencyBlockers = getTaskDependencyBlockers(prd, task);
    if (dependencyBlockers.pending.length > 0 || dependencyBlockers.missing.length > 0) {
      const blockerTask = dependencyBlockers.pending[0];
      const missingDep = dependencyBlockers.missing[0] ?? "unknown";
      const state = await bumpIteration(repoRoot);
      const attemptAt = nowIso();
      const gates: PrdGatesAttempt = { ok: false, commands: [] };
      const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
      const detail = blockerTask
        ? `Cannot execute ${task.id} before dependency ${blockerTask.id} (${blockerTask.title}) is completed.`
        : `Cannot execute ${task.id} because dependency ${missingDep} is missing from .mario/prd.json.`;
      const judge: PrdJudgeAttempt = {
        status: "FAIL",
        exitSignal: false,
        reason: [formatReasonCode(RUN_REASON.PREREQ_TASK_PENDING), detail],
        nextActions: [
          blockerTask
            ? `Complete ${blockerTask.id} first, then rerun /mario-devx:run 1.`
            : `Fix missing dependency ${missingDep} in .mario/prd.json, then rerun /mario-devx:run 1.`,
        ],
      };
      prd = await persistBlockedTaskAttempt({ ctx, repoRoot, prd, task, attemptAt, iteration: state.iteration, gates, ui, judge, runId });
      await showToast(ctx, blockerTask ? `Run blocked: ${task.id} requires ${blockerTask.id}` : `Run blocked: ${task.id} has missing dependency ${missingDep}`, "warning");
      break;
    }

    const effectiveDoneWhen = resolveEffectiveDoneWhen(prd, task);
    const gateCommands = toGateCommands(effectiveDoneWhen);
    attempted += 1;

    prd = setPrdTaskStatus(prd, task.id, "in_progress");
    await writePrdJson(repoRoot, prd);
    const state = await bumpIteration(repoRoot);
    const attemptAt = nowIso();
    const carryForwardIssues = collectCarryForwardIssues(task);
    const iterationPlan = buildIterationTaskPlan({ task, prd, effectiveDoneWhen, carryForwardIssues });
    const buildModePrompt = await buildPrompt(repoRoot, "build", iterationPlan);
    let workPhaseAnnounced = false;
    let verifyPhaseAnnounced = false;
    let workIdleAnnounced = false;
    let verifyIdleAnnounced = false;

    await showToast(ctx, `Run: started ${task.id} (${attempted}/${maxItems})`, "info");

    const blockForHeartbeatFailure = async (phase: string): Promise<void> => {
      const gates: PrdGatesAttempt = { ok: false, commands: [] };
      const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
      const judge: PrdJudgeAttempt = {
        status: "FAIL",
        exitSignal: false,
        reason: [`Failed to update run.lock heartbeat during ${phase} (${runLockPath(repoRoot)}).`],
        nextActions: ["Check disk space/permissions for .mario/state/run.lock, then rerun /mario-devx:run 1."],
      };
      prd = await persistBlockedTaskAttempt({ ctx, repoRoot, prd, task, attemptAt, iteration: state.iteration, gates, ui, judge, runId });
      await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_HEARTBEAT, `Run blocked: lock heartbeat failed during ${phase}`, {
        taskId: task.id,
        phase,
        lockPath: runLockPath(repoRoot),
      }, { runId, taskId: task.id, reasonCode: RUN_REASON.HEARTBEAT_FAILED });
    };

    const blockForPromptDispatchFailure = async (
      phase: "build" | "repair" | "semantic-repair",
      errorMessage: string,
      reasonCode: typeof RUN_REASON.WORK_PROMPT_DISPATCH_TIMEOUT | typeof RUN_REASON.WORK_PROMPT_TRANSPORT_ERROR,
    ): Promise<void> => {
      const isTimeout = reasonCode === RUN_REASON.WORK_PROMPT_DISPATCH_TIMEOUT;
      const gates: PrdGatesAttempt = { ok: false, commands: [] };
      const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
      const judge: PrdJudgeAttempt = {
        status: "FAIL",
        exitSignal: false,
        reason: [
          formatReasonCode(reasonCode),
          isTimeout
            ? `Work-session prompt dispatch timed out during ${phase} (${TIMEOUTS.PROMPT_DISPATCH_TIMEOUT_MS}ms).`
            : `Work-session prompt dispatch failed during ${phase} (transport parse failure).`,
          errorMessage,
        ],
        nextActions: [
          "Retry /mario-devx:run 1.",
          "If it repeats, restart OpenCode to refresh session RPC state.",
        ],
      };
      prd = await persistBlockedTaskAttempt({ ctx, repoRoot, prd, task, attemptAt, iteration: state.iteration, gates, ui, judge, runId });
      await logRunEvent(
        ctx,
        repoRoot,
        "error",
        isTimeout ? RUN_EVENT.BLOCKED_WORK_PROMPT_TIMEOUT : RUN_EVENT.BLOCKED_WORK_PROMPT_TRANSPORT,
        isTimeout ? "Run blocked: work-session prompt dispatch timed out" : "Run blocked: work-session prompt transport failed",
        {
          taskId: task.id,
          phase,
          timeoutMs: TIMEOUTS.PROMPT_DISPATCH_TIMEOUT_MS,
          error: errorMessage,
        },
        { runId, taskId: task.id, reasonCode },
      );
    };

    let ws: { sessionId: string; baselineMessageId: string } | null = null;
    const resetWorkSessionWithTimeout = async (): Promise<{ sessionId: string; baselineMessageId: string } | null> => {
      const resetResult = await resetWorkSessionWithTimeoutStep({
        ctx,
        repoRoot,
        runId,
        task,
        prd,
        attemptAt,
        iteration: state.iteration,
        formatReasonCode,
        resetWorkSession,
        persistBlockedTaskAttempt,
        logRunEvent,
        blockedEvent: RUN_EVENT.BLOCKED_WORK_SESSION_RESET_TIMEOUT,
        workAgent: sessionAgents.workAgent,
      });
      prd = resetResult.prd;
      return resetResult.session;
    };

    const promptWorkSessionWithTimeout = async (
      phase: "build" | "repair" | "semantic-repair",
      text: string,
    ): Promise<{ ok: true; idleSequenceBeforePrompt: number } | { ok: false }> => {
      return promptWorkSessionWithTimeoutStep({
        ctx,
        repoRoot,
        runId,
        taskId: task.id,
        phase,
        text,
        getWorkSession: () => ws,
        setWorkSession: async (value) => {
          ws = value;
        },
        resetWorkSession: resetWorkSessionWithTimeout,
        deleteSessionBestEffort,
        setWorkSessionTitle,
        updateRunState,
        getIdleSequence: getSessionIdleSequence,
        logRunEvent,
        onDispatchFailure: (failedPhase, errorMessage, reasonCode) => blockForPromptDispatchFailure(
          failedPhase,
          errorMessage,
          reasonCode as typeof RUN_REASON.WORK_PROMPT_DISPATCH_TIMEOUT | typeof RUN_REASON.WORK_PROMPT_TRANSPORT_ERROR,
        ),
        workAgent: sessionAgents.workAgent,
        controlSessionId,
      });
    };

    if (!(await heartbeatRunLock(repoRoot))) {
      await blockForHeartbeatFailure("pre-work-session-reset");
      break;
    }

    ws = await resetWorkSessionWithTimeout();
    if (!ws) break;

    await setWorkSessionTitle(ctx, ws.sessionId, `mario-devx (work) - ${task.id}`);
    await updateRunState(repoRoot, {
      status: "DOING",
      phase: "run",
      currentPI: task.id,
      ...(controlSessionId ? { controlSessionId } : {}),
      workSessionId: ws.sessionId,
      baselineMessageId: ws.baselineMessageId,
      streamWorkEvents: sessionAgents.streamWorkEvents,
      streamVerifyEvents: sessionAgents.streamVerifyEvents,
      startedAt: nowIso(),
    });

    if (!workPhaseAnnounced) {
      workPhaseAnnounced = true;
      await showToast(ctx, `Run: work phase started for ${task.id}`, "info");
    }

    const buildPromptDispatch = await promptWorkSessionWithTimeout("build", buildModePrompt);
    if (!buildPromptDispatch.ok) break;

    if (!(await heartbeatRunLock(repoRoot))) {
      await blockForHeartbeatFailure("after-build-prompt");
      break;
    }

    const idle = await waitForSessionIdleStableDetailed(ctx, ws.sessionId, 0, 1, { afterSequence: buildPromptDispatch.idleSequenceBeforePrompt, abortSignal: undefined });
    if (!idle.ok) {
      const gates: PrdGatesAttempt = { ok: false, commands: [] };
      const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
      const judge: PrdJudgeAttempt = {
        status: "FAIL",
        exitSignal: false,
        reason: [
          idle.reason === "aborted"
            ? "Run interrupted while waiting for work-session idle signal."
            : "Work-session idle wait failed before deterministic gates.",
        ],
        nextActions: [
          "Rerun /mario-devx:run 1 from the control session.",
          "If it repeats, inspect the work session via /sessions.",
        ],
      };
      prd = await persistBlockedTaskAttempt({ ctx, repoRoot, prd, task, attemptAt, iteration: state.iteration, gates, ui, judge, runId });
      break;
    }
    if (!workIdleAnnounced) {
      workIdleAnnounced = true;
      await showToast(ctx, `Run: work phase idle for ${task.id}`, "success");
    }

    const maxTotalRepairAttempts = LIMITS.MAX_TOTAL_REPAIR_ATTEMPTS;
    const waitForWorkIdleAfterPrompt = async (idleSequenceBeforePrompt: number): Promise<boolean> => {
      if (!ws) return false;
      const nextIdle = await waitForSessionIdleStableDetailed(ctx, ws.sessionId, 0, 1, { afterSequence: idleSequenceBeforePrompt, abortSignal: undefined });
      return nextIdle.ok;
    };

    const gateRepair = await runGateRepairLoop({
      ctx,
      repoRoot,
      workspaceRoot,
      workspaceAbs,
      task,
      gateCommands,
      carryForwardIssues,
      runId,
      maxTotalRepairAttempts,
      initialWorkIdleAnnounced: workIdleAnnounced,
      promptWorkSessionWithTimeout: (phase, text) => promptWorkSessionWithTimeout(phase, text),
      waitForWorkIdleAfterPrompt,
      heartbeatRunLock,
      blockForHeartbeatFailure,
      showToast,
      buildGateRepairPrompt,
      captureWorkspaceSnapshot,
      summarizeWorkspaceDelta,
      logGateRunResults: (_phase, taskId, gateResults) => logGateRunResults(RUN_PHASE.REPAIR, taskId, gateResults),
      runShellWithFailureLog,
      timeouts: { maxTaskRepairMs: TIMEOUTS.MAX_TASK_REPAIR_MS },
      limits: { maxNoProgressStreak: LIMITS.MAX_NO_PROGRESS_STREAK },
    });

    workIdleAnnounced = gateRepair.workIdleAnnounced;
    let gateResult = gateRepair.gateResult;
    let repairAttempts = gateRepair.repairAttempts;
    let totalRepairAttempts = gateRepair.totalRepairAttempts;
    const stoppedForNoChanges = gateRepair.stoppedForNoChanges;
    const lastNoChangeGate = gateRepair.lastNoChangeGate;

    let latestGateResult = gateResult;
    let latestUiResult = latestGateResult.ok ? await runUiVerifyForTask(task.id) : null;
    let gates = toGatesAttempt(latestGateResult);
    let ui = toUiAttempt({ gateOk: latestGateResult.ok, uiResult: latestUiResult, uiVerifyEnabled, isWebApp, cliOk, skillOk, browserOk });

    const failEarly = async (reasonLines: string[], nextActions?: string[]): Promise<void> => {
      const judge: PrdJudgeAttempt = {
        status: "FAIL",
        exitSignal: false,
        reason: reasonLines,
        nextActions: nextActions && nextActions.length > 0 ? nextActions : ["Fix the failing checks, then rerun /mario-devx:run 1."],
      };
      prd = await persistBlockedTaskAttempt({ ctx, repoRoot, prd, task, attemptAt, iteration: state.iteration, gates, ui, judge, runId });
    };

    if (!latestGateResult.ok && stoppedForNoChanges) {
      await failEarly([
        formatReasonCode(RUN_REASON.WORK_SESSION_NO_PROGRESS),
        `Repair loop produced no source-file changes across consecutive attempts (last failing gate: ${lastNoChangeGate ?? "unknown"}).`,
      ]);
      break;
    }
    if (!latestGateResult.ok) {
      const failed = latestGateResult.failed ? `${latestGateResult.failed.command} (exit ${latestGateResult.failed.exitCode})` : "(unknown command)";
      await failEarly([
        `Deterministic gate failed: ${failed}.`,
        `Auto-repair stopped across ${repairAttempts} attempt(s) (total repair turns: ${totalRepairAttempts}/${maxTotalRepairAttempts}; no-progress or time budget reached).`,
      ]);
      break;
    }

    if (uiVerifyEnabled && isWebApp && uiVerifyRequired && (!cliOk || !skillOk || !browserOk)) {
      await failEarly(
        [
          "UI verification is required but agent-browser prerequisites are missing.",
          ...(autoInstallAttempted.length > 0 ? [`Auto-install attempted: ${autoInstallAttempted.join("; ")}`] : []),
          `Repo: ${agentBrowserRepo}`,
        ],
        [
          "Install prerequisites, then rerun /mario-devx:run 1.",
          "Or set UI_VERIFY_REQUIRED=0 in .mario/AGENTS.md to make UI verification best-effort.",
        ],
      );
      break;
    }

    if (uiVerifyEnabled && isWebApp && uiVerifyRequired && latestUiResult && !latestUiResult.ok) {
      await failEarly(["UI verification failed."]);
      break;
    }

    const artifactCheck = await checkAcceptanceArtifacts(repoRoot, task.acceptance ?? []);
    if (artifactCheck.missingFiles.length > 0 || artifactCheck.missingLabels.length > 0) {
      await failEarly([
        formatReasonCode(RUN_REASON.ACCEPTANCE_ARTIFACTS_MISSING),
        ...(artifactCheck.missingFiles.length > 0 ? [`Missing expected files: ${artifactCheck.missingFiles.join(", ")}.`] : []),
        ...(artifactCheck.missingLabels.length > 0 ? [`Missing expected navigation labels in app shell: ${artifactCheck.missingLabels.join(", ")}.`] : []),
      ]);
      break;
    }

    if (!verifyPhaseAnnounced) {
      verifyPhaseAnnounced = true;
      await showToast(ctx, `Run: verify phase started for ${task.id}`, "info");
    }

    const semanticResult = await runSemanticRepairLoop({
      ctx,
      repoRoot,
      workspaceAbs,
      task,
      doneWhen: effectiveDoneWhen,
      runId,
      gateCommands,
      carryForwardIssues,
      maxTotalRepairAttempts,
      totalRepairAttempts,
      latestGateResult,
      latestUiResult,
      uiVerifyEnabled,
      isWebApp,
      cliOk,
      skillOk,
      browserOk,
      uiVerifyUrl,
      uiVerifyCmd,
      visualDirection: prd.ui.visualDirection,
      uxRequirements: prd.ui.uxRequirements,
      styleReferences: prd.ui.styleReferences,
      agentBrowserCaps,
      verifyAgent: sessionAgents.verifyAgent,
      limits: { maxVerifierRepairAttempts: LIMITS.MAX_VERIFIER_REPAIR_ATTEMPTS },
      buildPrompt,
      buildVerifierContextText,
      buildCapabilitySummary,
      resolveVerifierJudge,
      applyRepeatedFailureBackpressure,
      firstActionableJudgeReason,
      buildSemanticRepairPrompt,
      promptWorkSessionWithTimeout: (phase, text) => promptWorkSessionWithTimeout(phase, text),
      waitForWorkIdleAfterPrompt,
      heartbeatRunLock,
      blockForHeartbeatFailure,
      captureWorkspaceSnapshot,
      summarizeWorkspaceDelta,
      runGateCommands,
      runUiVerifyForTask,
      toGatesAttempt,
      toUiAttempt,
      failEarly,
      showToast,
    });

    if (!verifyIdleAnnounced) {
      verifyIdleAnnounced = true;
      await showToast(ctx, `Run: verify phase idle for ${task.id}`, "success");
    }

    const blockedByVerifierFailure = semanticResult.blockedByVerifierFailure;
    const judge = semanticResult.judge;
    totalRepairAttempts = semanticResult.totalRepairAttempts;
    latestGateResult = semanticResult.latestGateResult;
    latestUiResult = semanticResult.latestUiResult;
    gates = semanticResult.gates;
    ui = semanticResult.ui;

    if (blockedByVerifierFailure || !judge) {
      break;
    }

    const lastAttempt: PrdTaskAttempt = {
      at: attemptAt,
      iteration: state.iteration,
      gates,
      ui,
      judge,
    };
    await updateRunState(repoRoot, {
      status: judge.status === "PASS" ? "DOING" : "BLOCKED",
      phase: "run",
      currentPI: task.id,
      ...(controlSessionId ? { controlSessionId } : {}),
    });

    const isPass = judge.status === "PASS" && judge.exitSignal;
    prd = setPrdTaskStatus(prd, task.id, isPass ? "completed" : "blocked");
    prd = setPrdTaskLastAttempt(prd, task.id, lastAttempt);
    await writePrdJson(repoRoot, prd);

    if (isPass) {
      completed += 1;
      await logTaskComplete(ctx, repoRoot, task.id, completed, maxItems);
      await showToast(ctx, `Run: completed ${task.id} (${completed}/${maxItems})`, "success");
    } else {
      const blockedReason = firstActionableJudgeReason(judge) ?? judge.reason?.[0] ?? "No reason provided";
      await logTaskBlocked(ctx, repoRoot, task.id, blockedReason);
      break;
    }
  }

  return finalizeRunSuccess({
    ctx,
    repoRoot,
    runId,
    nowIso,
    attempted,
    completed,
    maxItems,
    prd,
    runStartIteration,
    controlSessionId,
    updateRunState,
    buildRunSummary,
    logRunEvent,
    readTasks: () => prd.tasks ?? [],
    finishedEvent: RUN_EVENT.FINISHED,
  });
};
