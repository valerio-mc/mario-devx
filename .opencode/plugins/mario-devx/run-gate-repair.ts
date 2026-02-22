import {
  ensureT0002QualityBootstrap,
  hasNodeModules,
  missingPackageScriptForCommand,
  runGateCommands,
  type GateCommand,
  type GateRunItem,
} from "./gates";
import { firstScaffoldHintFromNotes, isScaffoldMissingGateCommand, type PrdTask } from "./planner";
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
  initialWorkIdleAnnounced: boolean;
  promptWorkSessionWithTimeout: (phase: "repair", text: string) => Promise<{ ok: true; idleSequenceBeforePrompt: number } | { ok: false }>;
  waitForWorkIdleAfterPrompt: (idleSequenceBeforePrompt: number) => Promise<boolean>;
  heartbeatRunLock: (repoRoot: string) => Promise<boolean>;
  blockForHeartbeatFailure: (phase: string) => Promise<void>;
  showToast: (ctx: any, message: string, variant?: "info" | "success" | "warning" | "error") => Promise<void>;
  buildGateRepairPrompt: (opts: {
    taskId: string;
    failedGate: string;
    carryForwardIssues: string[];
    missingScript: string | null;
    scaffoldHint: string | null;
    scaffoldGateFailure: boolean;
  }) => string;
  captureWorkspaceSnapshot: (repoRoot: string) => Promise<Map<string, string>>;
  summarizeWorkspaceDelta: (before: Map<string, string>, after: Map<string, string>) => { changed: number };
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
    buildGateRepairPrompt,
    captureWorkspaceSnapshot,
    summarizeWorkspaceDelta,
    logGateRunResults,
    runShellWithFailureLog,
    timeouts,
    limits,
  } = opts;

  let workIdleAnnounced = opts.initialWorkIdleAnnounced;
  let gateResult = await runGateCommands(gateCommands, ctx.$, workspaceAbs);
  await logGateRunResults("repair", task.id, gateResult.results);

  const taskRepairStartedAt = Date.now();
  let repairAttempts = 0;
  let totalRepairAttempts = 0;
  let noProgressStreak = 0;
  let noChangeStreak = 0;
  let stoppedForNoChanges = false;
  let lastNoChangeGate: string | null = null;
  let lastGateFailureSig: string | null = null;
  let deterministicScaffoldTried = false;

  const usesNodePackageScripts = gateCommands.some((g) => {
    const c = g.command.trim();
    return /^npm\s+run\s+/i.test(c) || /^pnpm\s+/i.test(c) || /^yarn\s+/i.test(c) || /^bun\s+run\s+/i.test(c);
  });

  if (task.id === "T-0002" && usesNodePackageScripts) {
    const bootstrap = await ensureT0002QualityBootstrap(repoRoot, workspaceRoot, gateCommands);
    if (ctx.$ && (!(await hasNodeModules(repoRoot, workspaceRoot)) || bootstrap.changed)) {
      const installCmd = workspaceRoot === "." ? "npm install" : `npm --prefix ${workspaceRoot} install`;
      await runShellWithFailureLog(ctx, repoRoot, installCmd, {
        event: RUN_EVENT.BOOTSTRAP_INSTALL_FAILED,
        message: `Dependency install failed while bootstrapping ${task.id}`,
        reasonCode: RUN_REASON.BOOTSTRAP_INSTALL_FAILED,
        runId,
        taskId: task.id,
        extra: { workspaceRoot },
      });
    }
  }

  const failSigFromGate = (): string => {
    const failed = gateResult.failed;
    return failed ? `${failed.command}:${failed.exitCode}` : "unknown";
  };

  while (!gateResult.ok) {
    const currentSig = failSigFromGate();
    const elapsedMs = Date.now() - taskRepairStartedAt;
    if (lastGateFailureSig === currentSig) noProgressStreak += 1;
    else noProgressStreak = 0;
    lastGateFailureSig = currentSig;

    if (repairAttempts > 0 && (elapsedMs >= timeouts.maxTaskRepairMs || noProgressStreak >= limits.maxNoProgressStreak || totalRepairAttempts >= maxTotalRepairAttempts)) {
      break;
    }

    const failedGate = gateResult.failed ? `${gateResult.failed.command} (exit ${gateResult.failed.exitCode})` : "(unknown command)";
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
      failedGate,
      carryForwardIssues,
      missingScript,
      scaffoldHint,
      scaffoldGateFailure: Boolean(gateResult.failed?.command && isScaffoldMissingGateCommand(gateResult.failed.command)),
    });

    const repairSnapshotBefore = await captureWorkspaceSnapshot(repoRoot);
    const repairPromptDispatch = await promptWorkSessionWithTimeout("repair", repairPrompt);
    if (!repairPromptDispatch.ok) {
      break;
    }

    if (!(await heartbeatRunLock(repoRoot))) {
      await blockForHeartbeatFailure("during-auto-repair");
      break;
    }

    const repairIdleOk = await waitForWorkIdleAfterPrompt(repairPromptDispatch.idleSequenceBeforePrompt);
    if (!repairIdleOk) break;
    if (!workIdleAnnounced) {
      workIdleAnnounced = true;
      await showToast(ctx, `Run: work phase idle for ${task.id}`, "success");
    }

    const repairSnapshotAfter = await captureWorkspaceSnapshot(repoRoot);
    const repairDelta = summarizeWorkspaceDelta(repairSnapshotBefore, repairSnapshotAfter);
    if (repairDelta.changed === 0) {
      noChangeStreak += 1;
      lastNoChangeGate = failedGate;
      if (noChangeStreak >= 2) {
        stoppedForNoChanges = true;
        break;
      }
    } else {
      noChangeStreak = 0;
    }

    repairAttempts += 1;
    totalRepairAttempts += 1;
    gateResult = await runGateCommands(gateCommands, ctx.$, workspaceAbs);
    await logGateRunResults("repair", task.id, gateResult.results);
  }

  return {
    gateResult,
    repairAttempts,
    totalRepairAttempts,
    stoppedForNoChanges,
    lastNoChangeGate,
    workIdleAnnounced,
  };
};
