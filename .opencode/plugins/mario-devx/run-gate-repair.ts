import {
  buildGateFailureFingerprint,
  buildPrdGateFailure,
  findFailedGateRunItem,
  missingPackageScriptForCommand,
  runGateCommands,
  type GateCommand,
  type GateRunItem,
} from "./gates";
import { firstScaffoldHintFromNotes, isScaffoldMissingGateCommand } from "./planner";
import type { PrdGateFailure, PrdTask } from "./prd";
import { RUN_EVENT, RUN_REASON } from "./run-contracts";

type GateResult = Awaited<ReturnType<typeof runGateCommands>>;

export const runGateRepairLoop = async (opts: {
  ctx: any;
  repoRoot: string;
  workspaceRoot: "." | "app";
  workspaceAbs: string;
  task: PrdTask;
  gateCommands: GateCommand[];
  carryForwardIssues: string[];
  runId: string;
  maxTotalRepairAttempts: number;
  initialTotalRepairAttempts?: number;
  initialGateResult?: GateResult;
  initialWorkIdleAnnounced: boolean;
  promptWorkSessionWithTimeout: (phase: "repair", text: string) => Promise<{ ok: true; idleSequenceBeforePrompt: number; baselineAssistantCount: number } | { ok: false }>;
  waitForWorkIdleAfterPrompt: (dispatch: { idleSequenceBeforePrompt: number; baselineAssistantCount: number }, phase: "repair") => Promise<boolean>;
  heartbeatRunLock: () => Promise<boolean>;
  blockForHeartbeatFailure: (phase: string) => Promise<void>;
  showToast: (ctx: any, message: string, variant?: "info" | "success" | "warning" | "error") => Promise<void>;
  logRunEvent: (
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    runCtx?: { runId?: string; taskId?: string; reasonCode?: string },
  ) => Promise<void>;
  buildGateRepairPrompt: (opts: {
    taskId: string;
    gateFailure: PrdGateFailure | null;
    carryForwardIssues: string[];
    missingScript: string | null;
    scaffoldHint: string | null;
    scaffoldGateFailure: boolean;
  }) => string;
  captureWorkspaceSnapshot: (repoRoot: string) => Promise<Map<string, string> | null>;
  summarizeWorkspaceDelta: (before: Map<string, string> | null, after: Map<string, string> | null) => { changed: number };
  logGateRunResults: (phase: "repair", taskId: string, gateResults: GateRunItem[]) => Promise<void>;
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
  timeouts: { maxTaskRepairMs: number };
  limits: { maxNoProgressStreak: number };
}): Promise<{
  gateResult: GateResult;
  repairAttempts: number;
  totalRepairAttempts: number;
  stoppedForNoChanges: boolean;
  stoppedForGlobalBlocker: boolean;
  lastNoChangeGate: string | null;
  workIdleAnnounced: boolean;
}> => {
  const {
    ctx,
    repoRoot,
    workspaceRoot,
    workspaceAbs,
    task,
    gateCommands,
    carryForwardIssues,
    runId,
    maxTotalRepairAttempts,
    promptWorkSessionWithTimeout,
    waitForWorkIdleAfterPrompt,
    heartbeatRunLock,
    blockForHeartbeatFailure,
    showToast,
    logRunEvent,
    buildGateRepairPrompt,
    captureWorkspaceSnapshot,
    summarizeWorkspaceDelta,
    logGateRunResults,
    runShellWithFailureLog,
    timeouts,
    limits,
  } = opts;

  let workIdleAnnounced = opts.initialWorkIdleAnnounced;
  let gateResult = opts.initialGateResult ?? await runGateCommands(gateCommands, ctx.$, workspaceAbs);
  await logGateRunResults("repair", task.id, gateResult.results);

  const taskRepairStartedAt = Date.now();
  let repairAttempts = 0;
  let totalRepairAttempts = opts.initialTotalRepairAttempts ?? 0;
  let noProgressStreak = 0;
  let noChangeStreak = 0;
  let stoppedForNoChanges = false;
  let stoppedForGlobalBlocker = false;
  let lastNoChangeGate: string | null = null;
  let lastGateFailureSig: string | null = null;
  let deterministicScaffoldTried = false;

  while (!gateResult.ok) {
    const currentSig = buildGateFailureFingerprint(findFailedGateRunItem(gateResult.results), { outputMaxChars: 300 }) ?? "unknown";
    const elapsedMs = Date.now() - taskRepairStartedAt;
    if (lastGateFailureSig === currentSig) noProgressStreak += 1;
    else noProgressStreak = 0;
    lastGateFailureSig = currentSig;

    if (repairAttempts > 0 && (elapsedMs >= timeouts.maxTaskRepairMs || noProgressStreak >= limits.maxNoProgressStreak || totalRepairAttempts >= maxTotalRepairAttempts)) {
      break;
    }

    const failedGate = gateResult.failed ? `${gateResult.failed.command} (exit ${gateResult.failed.exitCode})` : "(unknown command)";
    const failedGateRunItem = findFailedGateRunItem(gateResult.results);
    const gateFailure = buildPrdGateFailure(failedGateRunItem);
    const failureFingerprintBeforeRepair = gateFailure?.fingerprint ?? buildGateFailureFingerprint(failedGateRunItem);
    await logRunEvent(
      "info",
      "run.repair.backpressure",
      "Prepared repair backpressure context",
      {
        taskId: task.id,
        failedGate,
        failureFingerprint: failureFingerprintBeforeRepair ? failureFingerprintBeforeRepair.slice(0, 240) : null,
        failureFingerprintChars: failureFingerprintBeforeRepair ? failureFingerprintBeforeRepair.length : 0,
        gateOutputExcerptChars: gateFailure?.outputExcerpt ? gateFailure.outputExcerpt.length : 0,
        hasGateOutputExcerpt: Boolean(gateFailure?.outputExcerpt),
      },
      { runId, taskId: task.id },
    );
    const scaffoldHint = firstScaffoldHintFromNotes(task.notes);
    const missingScript = gateResult.failed ? await missingPackageScriptForCommand(repoRoot, workspaceRoot, gateResult.failed.command) : null;

    if (!deterministicScaffoldTried && gateResult.failed?.command && isScaffoldMissingGateCommand(gateResult.failed.command) && scaffoldHint && ctx.$) {
      deterministicScaffoldTried = true;
      const scaffoldRun = await runShellWithFailureLog(ctx, repoRoot, scaffoldHint, {
        event: RUN_EVENT.SCAFFOLD_DEFAULT_FAILED,
        message: `Default scaffold command failed for ${task.id}`,
        reasonCode: RUN_REASON.SCAFFOLD_COMMAND_FAILED,
        runId,
        taskId: task.id,
      });
      repairAttempts += 1;
      totalRepairAttempts += 1;
      if (scaffoldRun.exitCode !== 0) {
        await showToast(ctx, `Run: default scaffold failed on ${task.id}, falling back to agent repair`, "warning");
      }
      gateResult = await runGateCommands(gateCommands, ctx.$, workspaceAbs);
      await logGateRunResults("repair", task.id, gateResult.results);
      if (gateResult.ok) break;
    }

    const repairPrompt = buildGateRepairPrompt({
      taskId: task.id,
      gateFailure,
      carryForwardIssues,
      missingScript,
      scaffoldHint,
      scaffoldGateFailure: Boolean(gateResult.failed?.command && isScaffoldMissingGateCommand(gateResult.failed.command)),
    });

    const repairSnapshotBefore = await captureWorkspaceSnapshot(repoRoot);
    const repairPromptDispatch = await promptWorkSessionWithTimeout("repair", repairPrompt);
    if (!repairPromptDispatch.ok) {
      stoppedForGlobalBlocker = true;
      break;
    }

    if (!(await heartbeatRunLock())) {
      await blockForHeartbeatFailure("during-auto-repair");
      stoppedForGlobalBlocker = true;
      break;
    }

    const repairIdleOk = await waitForWorkIdleAfterPrompt(repairPromptDispatch, "repair");
    if (!repairIdleOk) {
      stoppedForGlobalBlocker = true;
      break;
    }
    if (!workIdleAnnounced) {
      workIdleAnnounced = true;
      await showToast(ctx, `Run: work phase idle for ${task.id}`, "success");
    }

    const repairSnapshotAfter = await captureWorkspaceSnapshot(repoRoot);
    const repairDelta = summarizeWorkspaceDelta(repairSnapshotBefore, repairSnapshotAfter);
    const noSourceChanges = repairDelta.changed === 0;

    repairAttempts += 1;
    totalRepairAttempts += 1;
    gateResult = await runGateCommands(gateCommands, ctx.$, workspaceAbs);
    await logGateRunResults("repair", task.id, gateResult.results);

    if (noSourceChanges) {
      const failedAfterRepair = findFailedGateRunItem(gateResult.results);
      const failureFingerprintAfterRepair = buildPrdGateFailure(failedAfterRepair)?.fingerprint
        ?? buildGateFailureFingerprint(failedAfterRepair);
      const sameFailure = Boolean(
        failureFingerprintBeforeRepair
        && failureFingerprintAfterRepair
        && failureFingerprintBeforeRepair === failureFingerprintAfterRepair,
      );
      if (sameFailure) {
        noChangeStreak += 1;
      } else {
        noChangeStreak = 0;
      }
      lastNoChangeGate = failedGate;
      if (noChangeStreak >= 2) {
        stoppedForNoChanges = true;
        break;
      }
    } else {
      noChangeStreak = 0;
    }
  }

  return {
    gateResult,
    repairAttempts,
    totalRepairAttempts,
    stoppedForNoChanges,
    stoppedForGlobalBlocker,
    lastNoChangeGate,
    workIdleAnnounced,
  };
};
