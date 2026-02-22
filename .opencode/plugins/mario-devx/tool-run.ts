import { tool } from "@opencode-ai/plugin";

import {
  deleteSessionBestEffort,
  ensureNotInWorkSession,
  resetWorkSession,
  updateRunState,
} from "./runner";
import { clearSessionCaches, ensureMario, readRunState, writeRunState } from "./state";
import { createRunId, logTaskBlocked, logTaskComplete } from "./logging";
import { acquireRunLock, heartbeatRunLock, releaseRunLock, runLockPath } from "./run-lock";
import type { RunLogMeta } from "./run-types";
import { buildRunSummary } from "./run-report";
import { RUN_EVENT, RUN_REASON } from "./run-contracts";
import { clearToastStreamChannel } from "./toast-stream";
import { TIMEOUTS } from "./config";
import { runPreflightStep } from "./run-preflight-step";
import { finalizeRunCleanup, finalizeRunCrash } from "./run-finalize";
import { runEngine } from "./run-engine";
import type { PrdGatesAttempt, PrdJudgeAttempt, PrdJson, PrdTask, PrdTaskAttempt, PrdUiAttempt } from "./prd";
import type { ToolContext } from "./tool-common";
import type { PluginContext } from "./tool-common";

export const createRunTool = (opts: {
  ctx: PluginContext;
  repoRoot: string;
  ensurePrd: (repoRoot: string) => Promise<PrdJson>;
  nowIso: () => string;
  formatReasonCode: (code: string) => string;
  firstActionableJudgeReason: (judge: PrdJudgeAttempt | undefined) => string | null;
  collectCarryForwardIssues: (task: PrdTask) => string[];
  applyRepeatedFailureBackpressure: (previous: PrdTaskAttempt | undefined, judge: PrdJudgeAttempt) => PrdJudgeAttempt;
  resolveVerifierJudge: (opts: {
    ctx: PluginContext;
    repoRoot: string;
    verifierPrompt: string;
    runId: string;
    taskId: string;
    capabilitySummary: string;
    agent?: string;
  }) => Promise<{ judge: PrdJudgeAttempt } | { transportFailure: PrdJudgeAttempt; errorMessage: string }>;
  persistBlockedTaskAttempt: (opts: {
    ctx: PluginContext;
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
  showToast: (ctx: PluginContext, message: string, variant?: "info" | "success" | "warning" | "error") => Promise<void>;
  logRunEvent: (
    ctx: PluginContext,
    repoRoot: string,
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    runCtx?: RunLogMeta,
  ) => Promise<void>;
  runShellWithFailureLog: (
    ctx: PluginContext,
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
  buildCapabilitySummary: (caps: {
    available: boolean;
    version: string | null;
    openUsage: string | null;
    commands: string[];
    notes: string[];
  }) => string;
}) => {
  const {
    ctx,
    repoRoot,
    ensurePrd,
    nowIso,
    formatReasonCode,
    firstActionableJudgeReason,
    collectCarryForwardIssues,
    applyRepeatedFailureBackpressure,
    resolveVerifierJudge,
    persistBlockedTaskAttempt,
    showToast,
    logRunEvent,
    runShellWithFailureLog,
    buildCapabilitySummary,
  } = opts;

  return {
    mario_devx_run: tool({
      description: "Run next tasks (build + verify, stops on failure)",
      args: {
        max_items: tool.schema.string().optional().describe("Maximum number of tasks to attempt (default: 1)"),
      },
      async execute(args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }

        await ensureMario(repoRoot, false);
        const runId = createRunId();
        const controlSessionId = context.sessionID;
        if (controlSessionId) {
          clearToastStreamChannel(controlSessionId);
        }
        await showToast(ctx, "Run: preflight started", "info");
        await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.PRECHECK_START, "Run preflight started", {
          controlSessionId: context.sessionID ?? null,
        }, { runId });

        const previousRun = await readRunState(repoRoot);
        const sameControlSession = context.sessionID
          ? previousRun.lastRunControlSessionId === context.sessionID
          : !previousRun.lastRunControlSessionId;
        if (
          sameControlSession
          && previousRun.lastRunAt
          && previousRun.lastRunResult
          && Number.isFinite(Date.parse(previousRun.lastRunAt))
          && (Date.now() - Date.parse(previousRun.lastRunAt)) <= TIMEOUTS.RUN_DUPLICATE_WINDOW_MS
        ) {
          await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.PRECHECK_DUPLICATE_WINDOW, "Returning cached run result in duplicate window", {
            cachedAt: previousRun.lastRunAt,
            duplicateWindowMs: TIMEOUTS.RUN_DUPLICATE_WINDOW_MS,
          }, { runId, reasonCode: RUN_REASON.DUPLICATE_WINDOW });
          await showToast(ctx, "Run: returning cached result (duplicate window)", "info");
          return previousRun.lastRunResult;
        }

        const lock = await acquireRunLock(repoRoot, context.sessionID, async (event) => {
          if (event.type === "stale-pid-removed") {
            await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.LOCK_STALE_PID, "Removed stale run lock owned by dead process", {
              lockPath: event.lockPath,
              stalePid: event.stalePid,
            }, { runId, reasonCode: RUN_REASON.STALE_LOCK_REMOVED });
          }
        });
        if (!lock.ok) {
          await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.LOCK_ACQUIRE_FAILED, "Run lock acquire failed", {
            lockMessage: lock.message,
          }, { runId, reasonCode: RUN_REASON.RUN_LOCK_HELD });
          await showToast(ctx, "Run blocked: another run is already active", "warning");
          return lock.message;
        }

        try {
          if (!(await heartbeatRunLock(repoRoot))) {
            await writeRunState(repoRoot, {
              iteration: (await readRunState(repoRoot)).iteration,
              status: "BLOCKED",
              phase: "run",
              ...(context.sessionID ? { controlSessionId: context.sessionID } : {}),
              updatedAt: nowIso(),
            });
            await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_HEARTBEAT, "Run blocked: preflight heartbeat failed", {
              phase: "preflight",
              lockPath: runLockPath(repoRoot),
            }, { runId, reasonCode: RUN_REASON.HEARTBEAT_FAILED });
            return `Failed to update run.lock heartbeat during run preflight (${runLockPath(repoRoot)}). Check disk space/permissions, then rerun /mario-devx:run 1.`;
          }
          const currentRun = await readRunState(repoRoot);
          if (currentRun.status === "DOING") {
            const recoveredState = {
              ...currentRun,
              status: "BLOCKED" as const,
              updatedAt: nowIso(),
            };
            await writeRunState(repoRoot, recoveredState);
            await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.STATE_STALE_DOING_RECOVERED, "Recovered stale in-progress run state", {
              previousPhase: currentRun.phase,
              previousCurrentPI: currentRun.currentPI ?? null,
              previousStartedAt: currentRun.startedAt ?? null,
              previousControlSessionId: currentRun.controlSessionId ?? null,
            }, { runId, reasonCode: RUN_REASON.STALE_DOING_RECOVERED });
            await showToast(ctx, "Run: recovered stale in-progress state from interrupted session", "warning");
          }

          const preflight = await runPreflightStep({
            ctx,
            repoRoot,
            args,
            controlSessionId: context.sessionID,
            runId,
            nowIso,
            ensurePrd,
            formatReasonCode,
            persistBlockedTaskAttempt,
            showToast,
            logRunEvent,
            buildCapabilitySummary,
          });
          if (preflight.blocked) {
            return preflight.message;
          }

          return runEngine({
            runCtx: {
              ctx,
              repoRoot,
              runId,
              controlSessionId: context.sessionID,
              workspaceRoot: preflight.workspaceRoot,
              workspaceAbs: preflight.workspaceAbs,
              sessionAgents: preflight.sessionAgents,
              uiSetup: preflight.uiSetup,
              agentBrowserCaps: preflight.agentBrowserCaps,
              nowIso,
              runStartIteration: preflight.runStartIteration,
            },
            preflightPrd: preflight.prd,
            maxItems: preflight.maxItems,
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
          });
        } catch (error) {
          return finalizeRunCrash({
            ctx,
            repoRoot,
            runId,
            nowIso,
            controlSessionId: context.sessionID,
            error,
            fatalEvent: RUN_EVENT.FATAL_EXCEPTION,
            fatalReasonCode: RUN_REASON.RUN_FATAL_EXCEPTION,
            readRunState,
            writeRunState,
            logRunEvent,
            showToast,
          });
        } finally {
          await finalizeRunCleanup({
            ctx,
            repoRoot,
            runId,
            controlSessionId: context.sessionID,
            clearSessionCaches,
            readRunState,
            updateRunState,
            deleteSessionBestEffort,
            releaseRunLock,
            logRunEvent,
          });
        }
      },
    }),
  };
};
