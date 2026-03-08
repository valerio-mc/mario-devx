import { RUN_EVENT, RUN_REASON } from "./run-contracts";
import { RUN_PHASE, type RunPhaseName } from "./run-types";
import { LIMITS, TIMEOUTS } from "./config";
import { getNextPrdTask, getTaskDependencyBlockers, setPrdTaskLastAttempt, setPrdTaskStatus } from "./planner";
import { bumpIteration } from "./state";
import { updateRunState, waitForSessionIdleOrAssistantQuiet, setWorkSessionTitle } from "./runner";
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
import { buildVerifierContextText } from "./run-verifier";
import { runGateCommands } from "./gates";
import {
  createFailedGatesAttempt,
  createFailureJudge,
  createUnranUiAttempt,
  handleHeartbeatFailure,
  handlePromptDispatchFailure,
  persistTaskFailureAttempt,
} from "./run-failure-helpers";
import { buildUiVerifyFailedNextActions } from "./run-ui-failure-actions";
import { shouldBlockRunForUiPrereqs } from "./run-ui";
import { createTaskFailureHandlers } from "./run-task-failure";

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
    prereqNote?: string;
    shouldRunUiVerify: boolean;
  };
  agentBrowserCaps: { available: boolean; version: string | null; commands: string[]; openUsage: string | null; notes: string[] };
  nowIso: () => string;
  runStartIteration: number;
  abortSignal?: AbortSignal;
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
    runStateStatus?: "DOING" | "BLOCKED";
    logAsRunBlocked?: boolean;
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
  buildRunSummary: (opts: {
    attempted: number;
    completed: number;
    maxItems: number;
    tasks: PrdTask[];
    runNotes: string[];
    uiVerifyRequired: boolean;
    stopReason: "max_items" | "todo_exhausted" | "task_failure" | "global_blocker";
  }) => { result: string; latestTask?: { id: string } | null; judgeTopReason?: string | null };
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
  const { ctx, repoRoot, runId, controlSessionId, workspaceRoot, workspaceAbs, sessionAgents, uiSetup, agentBrowserCaps, nowIso, runStartIteration, abortSignal } = runCtx;
  const {
    uiVerifyEnabled,
    uiVerifyCmd,
    uiVerifyUrl,
    uiVerifyRequired,
    agentBrowserRepo,
    isWebApp,
    cliOk,
    skillOk,
    browserOk,
    autoInstallAttempted,
    prereqNote,
    shouldRunUiVerify,
  } = uiSetup;
  const blockRunForUiPrereqs = shouldBlockRunForUiPrereqs({
    uiVerifyEnabled,
    isWebApp,
    cliOk,
    skillOk,
    browserOk,
  });

  let prd = preflightPrd;
  let attempted = 0;
  let completed = 0;
  const continueOnTaskFailure = maxItems > 1;
  const nextTaskMode = continueOnTaskFailure ? "batch" : "single";
  const runNotes: string[] = [];
  let stopReason: "max_items" | "todo_exhausted" | "task_failure" | "global_blocker" = "max_items";

  const noteGlobalBlocker = (note: string): void => {
    stopReason = "global_blocker";
    if (!runNotes.includes(note)) {
      runNotes.push(note);
    }
  };

  const noteTaskFailureStop = (): void => {
    if (stopReason !== "global_blocker") {
      stopReason = "task_failure";
    }
  };

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

  const runUiVerifyForTask = async (taskId: string): Promise<{
    ok: boolean;
    note?: string;
    failure?: PrdUiAttempt["failure"];
    evidence?: PrdUiAttempt["evidence"];
  } | null> => {
    return runUiVerifyForTaskPhase({
      shouldRunUiVerify,
      taskId,
      ctx,
      repoRoot,
      uiVerifyCmd,
      uiVerifyUrl,
      waitMs: TIMEOUTS.UI_VERIFY_WAIT_MS,
      runCtx: { runId, repoRoot, workspaceRoot, workspaceAbs, ...(controlSessionId ? { controlSessionId } : {}) },
      logRunEvent: runLog,
    });
  };

  while (attempted < maxItems) {
    const task = getNextPrdTask(prd, { mode: nextTaskMode });
    if (!task) {
      const hasNonTerminalTasks = (prd.tasks ?? []).some((t) => t.status !== "completed" && t.status !== "cancelled");
      if (hasNonTerminalTasks) {
        noteGlobalBlocker("No runnable tasks are currently eligible (all remaining tasks are dependency-blocked).");
      } else {
        stopReason = "todo_exhausted";
      }
      break;
    }

    attempted += 1;

    const dependencyBlockers = getTaskDependencyBlockers(prd, task);
    if (dependencyBlockers.pending.length > 0 || dependencyBlockers.missing.length > 0) {
      const blockerTask = dependencyBlockers.pending[0];
      const missingDep = dependencyBlockers.missing[0] ?? "unknown";
      const state = await bumpIteration(repoRoot);
      const attemptAt = nowIso();
      const gates = createFailedGatesAttempt();
      const ui = createUnranUiAttempt();
      const detail = blockerTask
        ? `Cannot execute ${task.id} before dependency ${blockerTask.id} (${blockerTask.title}) is completed.`
        : `Cannot execute ${task.id} because dependency ${missingDep} is missing from .mario/prd.json.`;
      const judge = createFailureJudge({
        reason: [formatReasonCode(RUN_REASON.PREREQ_TASK_PENDING), detail],
        nextActions: [
          blockerTask
            ? `Complete ${blockerTask.id} first, then rerun /mario-devx:run 1.`
            : `Fix missing dependency ${missingDep} in .mario/prd.json, then rerun /mario-devx:run 1.`,
        ],
      });
      prd = await persistBlockedTaskAttempt({
        ctx,
        repoRoot,
        prd,
        task,
        attemptAt,
        iteration: state.iteration,
        gates,
        ui,
        judge,
        runId,
        ...(continueOnTaskFailure ? { runStateStatus: "DOING" as const, logAsRunBlocked: false } : {}),
      });
      await showToast(ctx, blockerTask ? `Run blocked: ${task.id} requires ${blockerTask.id}` : `Run blocked: ${task.id} has missing dependency ${missingDep}`, "warning");
      if ((await stopOrContinueTaskFailure(detail)) === "break") {
        stopReason = "task_failure";
        break;
      }
      continue;
    }

    const effectiveDoneWhen = resolveEffectiveDoneWhen(prd, task);
    const gateCommands = toGateCommands(effectiveDoneWhen);

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
      prd = await handleHeartbeatFailure({
        ctx,
        repoRoot,
        prd,
        task,
        attemptAt,
        iteration: state.iteration,
        runId,
        phase,
        lockPath: runLockPath(repoRoot),
        persistBlockedTaskAttempt,
        logRunEvent,
      });
    };

    const blockForPromptDispatchFailure = async (
      phase: "build" | "repair" | "semantic-repair",
      errorMessage: string,
      reasonCode: typeof RUN_REASON.WORK_PROMPT_DISPATCH_TIMEOUT | typeof RUN_REASON.WORK_PROMPT_TRANSPORT_ERROR,
    ): Promise<void> => {
      prd = await handlePromptDispatchFailure({
        ctx,
        repoRoot,
        prd,
        task,
        attemptAt,
        iteration: state.iteration,
        runId,
        phase,
        errorMessage,
        reasonCode,
        timeoutMs: TIMEOUTS.PROMPT_DISPATCH_TIMEOUT_MS,
        formatReasonCode,
        persistBlockedTaskAttempt,
        logRunEvent,
      });
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
    ): Promise<{ ok: true; idleSequenceBeforePrompt: number; baselineAssistantCount: number } | { ok: false }> => {
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

    if (!(await heartbeatRunLock(repoRoot, runId))) {
      await blockForHeartbeatFailure("pre-work-session-reset");
      noteGlobalBlocker("Failed to update run lock heartbeat before work-session reset.");
      break;
    }

    ws = await resetWorkSessionWithTimeout();
    if (!ws) {
      noteGlobalBlocker("Work session reset failed.");
      break;
    }

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

    prd = setPrdTaskStatus(prd, task.id, "in_progress");
    await writePrdJson(repoRoot, prd);

    if (!workPhaseAnnounced) {
      workPhaseAnnounced = true;
      await showToast(ctx, `Run: work phase started for ${task.id}`, "info");
    }

    const buildPromptDispatch = await promptWorkSessionWithTimeout("build", buildModePrompt);
    if (!buildPromptDispatch.ok) {
      noteGlobalBlocker("Work prompt dispatch failed during build phase.");
      break;
    }

    if (!(await heartbeatRunLock(repoRoot, runId))) {
      await blockForHeartbeatFailure("after-build-prompt");
      noteGlobalBlocker("Failed to update run lock heartbeat after build prompt.");
      break;
    }

    const BUILD_WAIT_MAX_MS = 10 * 60 * 1000;
    const REPAIR_WAIT_MAX_MS = 5 * 60 * 1000;
    const SEMANTIC_WAIT_MAX_MS = 5 * 60 * 1000;

    const idle = await waitForSessionIdleOrAssistantQuiet(ctx, ws.sessionId, {
      afterSequence: buildPromptDispatch.idleSequenceBeforePrompt,
      baselineAssistantCount: buildPromptDispatch.baselineAssistantCount,
      maxWaitMs: BUILD_WAIT_MAX_MS,
      abortSignal,
    });
    if (!idle.ok) {
      const gates = createFailedGatesAttempt();
      const ui = createUnranUiAttempt();
      const judge = createFailureJudge({
        reason: [
          idle.reason === "aborted"
            ? "Run interrupted while waiting for work-session progress."
            : idle.reason === "timeout"
              ? "Work-session did not reach idle or stable assistant output before timeout."
              : "Work-session idle/progress wait failed before deterministic gates.",
        ],
        nextActions: [
          "Rerun /mario-devx:run 1 from the control session.",
          "If it repeats, inspect the work session via /sessions.",
        ],
      });
      prd = await persistBlockedTaskAttempt({ ctx, repoRoot, prd, task, attemptAt, iteration: state.iteration, gates, ui, judge, runId });
      noteGlobalBlocker(
        idle.reason === "aborted"
          ? "Run interrupted while waiting for work-session progress."
          : idle.reason === "timeout"
            ? "Work session did not become idle before timeout."
            : "Work-session idle/progress wait failed before deterministic gates.",
      );
      break;
    }
    if (!workIdleAnnounced) {
      workIdleAnnounced = true;
      await showToast(ctx, `Run: work phase idle for ${task.id}`, "success");
    }

    const maxTotalRepairAttempts = LIMITS.MAX_TOTAL_REPAIR_ATTEMPTS;
    const waitForWorkIdleAfterPrompt = async (
      dispatch: { idleSequenceBeforePrompt: number; baselineAssistantCount: number },
      phase: "repair" | "semantic-repair",
    ): Promise<boolean> => {
      if (!ws) return false;
      const maxWaitMs = phase === "repair" ? REPAIR_WAIT_MAX_MS : SEMANTIC_WAIT_MAX_MS;
      const nextIdle = await waitForSessionIdleOrAssistantQuiet(ctx, ws.sessionId, {
        afterSequence: dispatch.idleSequenceBeforePrompt,
        baselineAssistantCount: dispatch.baselineAssistantCount,
        maxWaitMs,
        abortSignal,
      });
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
      heartbeatRunLock: () => heartbeatRunLock(repoRoot, runId),
      blockForHeartbeatFailure,
      showToast,
      logRunEvent: runLog,
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
    const stoppedForGlobalBlocker = gateRepair.stoppedForGlobalBlocker;
    const lastNoChangeGate = gateRepair.lastNoChangeGate;

    let latestGateResult = gateResult;
    let latestUiResult = latestGateResult.ok ? await runUiVerifyForTask(task.id) : null;
    let gates = toGatesAttempt(latestGateResult);
    let ui = toUiAttempt({ gateOk: latestGateResult.ok, uiResult: latestUiResult, previousUi: task.lastAttempt?.ui, uiVerifyEnabled, isWebApp, cliOk, skillOk, browserOk });
    const {
      failEarly,
      stopOrContinueTaskFailure,
      recordAndHandleTaskFailure,
      latestBlockedReasonForTask,
      logUiVerifyBlocked,
      wasTaskFailureRecorded,
    } = createTaskFailureHandlers({
      ctx,
      repoRoot,
      runId,
      task,
      attemptAt,
      iteration: state.iteration,
      continueOnTaskFailure,
      getPrd: () => prd,
      setPrd: (next) => {
        prd = next;
      },
      getGates: () => gates,
      getUi: () => ui,
      firstActionableJudgeReason,
      persistTaskFailureAttempt,
      persistBlockedTaskAttempt,
      logTaskBlocked,
      noteTaskFailureStop,
      runLog,
    });

    if (!latestGateResult.ok && stoppedForGlobalBlocker) {
      noteGlobalBlocker("Gate auto-repair was interrupted by an infrastructure failure (prompt/heartbeat/idle). See latest task.lastAttempt.");
      break;
    }

    if (!latestGateResult.ok && stoppedForNoChanges) {
      const failureReason = latestGateResult.failed
        ? `${latestGateResult.failed.command} (exit ${latestGateResult.failed.exitCode})`
        : "unknown gate";
      if ((await recordAndHandleTaskFailure({
        reasonLines: [
          formatReasonCode(RUN_REASON.WORK_SESSION_NO_PROGRESS),
          `Repair loop produced no source-file changes across consecutive attempts (last failing gate: ${lastNoChangeGate ?? "unknown"}).`,
        ],
        blockedReason: `Repair loop made no progress (last failing gate: ${failureReason}).`,
      })) === "break") {
        break;
      }
      continue;
    }
    if (!latestGateResult.ok) {
      const failed = latestGateResult.failed ? `${latestGateResult.failed.command} (exit ${latestGateResult.failed.exitCode})` : "(unknown command)";
      if ((await recordAndHandleTaskFailure({
        reasonLines: [
          formatReasonCode(RUN_REASON.TASK_FAIL_EARLY),
          `Deterministic gate failed: ${failed}.`,
          `Auto-repair stopped across ${repairAttempts} attempt(s) (total repair turns: ${totalRepairAttempts}/${maxTotalRepairAttempts}; no-progress or time budget reached).`,
        ],
        blockedReason: `Deterministic gate failed: ${failed}.`,
      })) === "break") {
        break;
      }
      continue;
    }

    if (blockRunForUiPrereqs) {
      await failEarly(
        [
          formatReasonCode(RUN_REASON.UI_PREREQ_MISSING),
          "UI verification is enabled but agent-browser prerequisites are missing.",
          ...(prereqNote ? [prereqNote] : []),
          ...(autoInstallAttempted.length > 0 ? [`Install commands: ${autoInstallAttempted.join("; ")}`] : []),
          `Repo: ${agentBrowserRepo}`,
        ],
        [
          "Install the missing prerequisites, then rerun /mario-devx:run 1.",
        ],
        "global",
      );
      noteGlobalBlocker("UI verification prerequisites are missing.");
      break;
    }

    if (uiVerifyEnabled && isWebApp && uiVerifyRequired && latestUiResult && !latestUiResult.ok) {
      await logUiVerifyBlocked("post-gates");
      const uiReason = latestUiResult.note?.trim() || "UI verification failed.";
      if ((await recordAndHandleTaskFailure({
        reasonLines: [
          formatReasonCode(RUN_REASON.UI_VERIFY_FAILED),
          uiReason,
        ],
        blockedReason: uiReason,
        nextActions: buildUiVerifyFailedNextActions(latestUiResult.note, ui.failure),
      })) === "break") {
        break;
      }
      continue;
    }

    const artifactCheck = await checkAcceptanceArtifacts(repoRoot, task.acceptance ?? []);
    if (artifactCheck.missingFiles.length > 0 || artifactCheck.missingLabels.length > 0) {
      if ((await recordAndHandleTaskFailure({
        reasonLines: [
          formatReasonCode(RUN_REASON.ACCEPTANCE_ARTIFACTS_MISSING),
          ...(artifactCheck.missingFiles.length > 0 ? [`Missing expected files: ${artifactCheck.missingFiles.join(", ")}.`] : []),
          ...(artifactCheck.missingLabels.length > 0 ? [`Missing expected navigation labels in app shell: ${artifactCheck.missingLabels.join(", ")}.`] : []),
        ],
        blockedReason: "Acceptance artifacts missing.",
      })) === "break") {
        break;
      }
      continue;
    }

    if (!verifyPhaseAnnounced) {
      verifyPhaseAnnounced = true;
      await showToast(ctx, `Run: verify phase started for ${task.id}`, "info");
    }

    let blockedByVerifierFailure = false;
    let judge: PrdJudgeAttempt | null = null;

    while (true) {
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
        uiVerifyRequired,
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
        heartbeatRunLock: () => heartbeatRunLock(repoRoot, runId),
        blockForHeartbeatFailure,
        captureWorkspaceSnapshot,
        summarizeWorkspaceDelta,
        runGateCommands,
        logGateRunResults: (_phase, taskId, gateResults) => logGateRunResults(RUN_PHASE.REPAIR, taskId, gateResults),
        runUiVerifyForTask,
        toGatesAttempt,
        toUiAttempt,
        failEarly,
        showToast,
      });

      blockedByVerifierFailure = semanticResult.blockedByVerifierFailure;
      judge = semanticResult.judge;
      totalRepairAttempts = semanticResult.totalRepairAttempts;
      latestGateResult = semanticResult.latestGateResult;
      latestUiResult = semanticResult.latestUiResult;
      gates = semanticResult.gates;
      ui = semanticResult.ui;

      if (!(semanticResult.semanticGateRegression && !latestGateResult.ok)) {
        break;
      }

      await showToast(ctx, `Run: semantic repair regressed gates for ${task.id}; entering gate auto-repair`, "warning");
      const semanticGateRepair = await runGateRepairLoop({
        ctx,
        repoRoot,
        workspaceRoot,
        workspaceAbs,
        task,
        gateCommands,
        carryForwardIssues,
        runId,
        maxTotalRepairAttempts,
        initialTotalRepairAttempts: totalRepairAttempts,
        initialGateResult: latestGateResult,
        initialWorkIdleAnnounced: workIdleAnnounced,
        promptWorkSessionWithTimeout: (phase, text) => promptWorkSessionWithTimeout(phase, text),
        waitForWorkIdleAfterPrompt,
        heartbeatRunLock: () => heartbeatRunLock(repoRoot, runId),
        blockForHeartbeatFailure,
        showToast,
        logRunEvent: runLog,
        buildGateRepairPrompt,
        captureWorkspaceSnapshot,
        summarizeWorkspaceDelta,
        logGateRunResults: (_phase, taskId, gateResults) => logGateRunResults(RUN_PHASE.REPAIR, taskId, gateResults),
        runShellWithFailureLog,
        timeouts: { maxTaskRepairMs: TIMEOUTS.MAX_TASK_REPAIR_MS },
        limits: { maxNoProgressStreak: LIMITS.MAX_NO_PROGRESS_STREAK },
      });

      workIdleAnnounced = semanticGateRepair.workIdleAnnounced;
      repairAttempts += semanticGateRepair.repairAttempts;
      totalRepairAttempts = semanticGateRepair.totalRepairAttempts;
      latestGateResult = semanticGateRepair.gateResult;
      latestUiResult = latestGateResult.ok ? await runUiVerifyForTask(task.id) : null;
      gates = toGatesAttempt(latestGateResult);
      const previousUi = ui;
      ui = toUiAttempt({ gateOk: latestGateResult.ok, uiResult: latestUiResult, previousUi, uiVerifyEnabled, isWebApp, cliOk, skillOk, browserOk });

      if (!latestGateResult.ok && semanticGateRepair.stoppedForGlobalBlocker) {
        blockedByVerifierFailure = true;
        judge = null;
        noteGlobalBlocker("Gate auto-repair after semantic regression was interrupted by an infrastructure failure (prompt/heartbeat/idle).");
        break;
      }

      if (!latestGateResult.ok && semanticGateRepair.stoppedForNoChanges) {
        await failEarly([
          formatReasonCode(RUN_REASON.WORK_SESSION_NO_PROGRESS),
          `Gate auto-repair after semantic regression produced no source-file changes across consecutive attempts (last failing gate: ${semanticGateRepair.lastNoChangeGate ?? "unknown"}).`,
        ]);
        blockedByVerifierFailure = true;
        judge = null;
        break;
      }

      if (!latestGateResult.ok) {
        const failed = latestGateResult.failed ? `${latestGateResult.failed.command} (exit ${latestGateResult.failed.exitCode})` : "(unknown command)";
        await failEarly([
          `ReasonCode: ${RUN_REASON.SEMANTIC_REPAIR_GATE_REGRESSION}`,
          `Deterministic gate failed after semantic repair and gate auto-repair: ${failed}.`,
        ]);
        blockedByVerifierFailure = true;
        judge = null;
        break;
      }
    }

    if (!verifyIdleAnnounced) {
      verifyIdleAnnounced = true;
      await showToast(ctx, `Run: verify phase idle for ${task.id}`, "success");
    }

    if (blockedByVerifierFailure && latestGateResult.ok && uiVerifyEnabled && isWebApp && uiVerifyRequired && ui.ok === false) {
      await logUiVerifyBlocked("semantic-repair");
    }

    if (latestGateResult.ok && uiVerifyEnabled && isWebApp && uiVerifyRequired && ui.ok !== true) {
      await logUiVerifyBlocked("post-verifier");
      if ((await recordAndHandleTaskFailure({
        reasonLines: [
          formatReasonCode(RUN_REASON.UI_VERIFY_FAILED),
          typeof ui.note === "string" && ui.note.trim().length > 0
            ? ui.note.trim()
            : latestUiResult?.note?.trim() || "UI verification failed.",
        ],
        blockedReason: latestBlockedReasonForTask(),
        nextActions: buildUiVerifyFailedNextActions(typeof ui.note === "string" ? ui.note : latestUiResult?.note, ui.failure),
      })) === "break") {
        break;
      }
      continue;
    }

    if (blockedByVerifierFailure || !judge) {
      if (wasTaskFailureRecorded()) {
        if ((await stopOrContinueTaskFailure(latestBlockedReasonForTask())) === "break") {
          break;
        }
        continue;
      }
      noteGlobalBlocker(`Global blocker while verifying ${task.id}.`);
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
      status: judge.status === "PASS" || continueOnTaskFailure ? "DOING" : "BLOCKED",
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
      if ((await stopOrContinueTaskFailure(blockedReason)) === "break") {
        break;
      }
      continue;
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
    runNotes,
    stopReason,
    readTasks: () => prd.tasks ?? [],
    finishedEvent: RUN_EVENT.FINISHED,
  });
};
