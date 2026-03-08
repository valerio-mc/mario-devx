import { tool } from "@opencode-ai/plugin";

import {
  deleteSessionBestEffort,
  ensureNotInWorkSession,
  resetWorkSession,
  updateRunState,
} from "./runner";
import { ensureMario, readRunState, writeRunState } from "./state";
import { createRunId, logTaskBlocked, logTaskComplete } from "./logging";
import { acquireRunLock, heartbeatRunLock, releaseRunLock, runLockPath } from "./run-lock";
import type { RunLogMeta } from "./run-types";
import { buildRunSummary } from "./run-report";
import { RUN_EVENT, RUN_REASON } from "./run-contracts";
import { clearToastStreamChannel } from "./toast-stream";
import { TIMEOUTS } from "./config";
import { runPreflightStep } from "./run-preflight-step";
import { parseMaxItems } from "./run-preflight";
import { finalizeRunCleanup, finalizeRunCrash } from "./run-finalize";
import { runEngine } from "./run-engine";
import type { PrdGatesAttempt, PrdJudgeAttempt, PrdJson, PrdTask, PrdTaskAttempt, PrdUiAttempt } from "./prd";
import type { ToolContext } from "./tool-common";
import type { PluginContext } from "./tool-common";

export type RunToolEngineDeps = {
  ensurePrd: (repoRoot: string) => Promise<PrdJson>;
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
    runStateStatus?: "DOING" | "BLOCKED";
    logAsRunBlocked?: boolean;
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
};

export const createRunTool = (opts: {
  ctx: PluginContext;
  repoRoot: string;
  nowIso: () => string;
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
  engine: RunToolEngineDeps;
}) => {
  const {
    ctx,
    repoRoot,
    nowIso,
    showToast,
    logRunEvent,
    engine,
  } = opts;
  const {
    ensurePrd,
    formatReasonCode,
    firstActionableJudgeReason,
    collectCarryForwardIssues,
    applyRepeatedFailureBackpressure,
    resolveVerifierJudge,
    persistBlockedTaskAttempt,
    runShellWithFailureLog,
    buildCapabilitySummary,
  } = engine;

  return {
    mario_devx_run: tool({
      description: "Run up to N iterations (continues on task failures, stops on global blockers)",
      args: {
        max_items: tool.schema.string().optional().describe("Maximum number of tasks to attempt (default: 1)"),
      },
      async execute(args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (notInWork.ok === false) {
          return notInWork.message;
        }

        await ensureMario(repoRoot, false);
        const runId = createRunId();
        const requestedMaxItems = parseMaxItems(args.max_items);
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
          requestedMaxItems <= 1
          &&
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

        const lock = await acquireRunLock(repoRoot, runId, context.sessionID, async (event) => {
          if (event.type === "stale-lock-removed") {
            await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.LOCK_RECLAIMED, "Removed stale run lock during acquire", {
              lockPath: event.lockPath,
              reason: event.reason,
              ...(typeof event.stalePid === "number" ? { stalePid: event.stalePid } : {}),
            }, { runId, reasonCode: RUN_REASON.STALE_LOCK_REMOVED });
          }
        });
        if (lock.ok === false) {
          await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.LOCK_ACQUIRE_FAILED, "Run lock acquire failed", {
            lockMessage: lock.message,
          }, { runId, reasonCode: RUN_REASON.RUN_LOCK_HELD });
          await showToast(ctx, "Run blocked: another run is already active", "warning");
          return lock.message;
        }

        await writeRunState(repoRoot, {
          ...(await readRunState(repoRoot)),
          status: "DOING",
          phase: "run",
          runId,
          ...(context.sessionID ? { controlSessionId: context.sessionID } : {}),
          startedAt: nowIso(),
          updatedAt: nowIso(),
        });

        try {
          if (!(await heartbeatRunLock(repoRoot, runId))) {
            await writeRunState(repoRoot, {
              iteration: (await readRunState(repoRoot)).iteration,
              status: "BLOCKED",
              phase: "run",
              runId: null,
              ...(context.sessionID ? { controlSessionId: context.sessionID } : {}),
              updatedAt: nowIso(),
            });
            await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_HEARTBEAT, "Run blocked: preflight heartbeat failed", {
              phase: "preflight",
              lockPath: runLockPath(repoRoot),
            }, { runId, reasonCode: RUN_REASON.HEARTBEAT_FAILED });
            return `Failed to update run.lock heartbeat during run preflight (${runLockPath(repoRoot)}). Check disk space/permissions, then rerun /mario-devx:run 1.`;
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
          if (preflight.blocked === true) {
            await writeRunState(repoRoot, {
              ...(await readRunState(repoRoot)),
              status: "BLOCKED",
              phase: "run",
              runId: null,
              ...(context.sessionID ? { controlSessionId: context.sessionID } : {}),
              updatedAt: nowIso(),
            });
            return preflight.message;
          }
          const readyPreflight = preflight;

          return await runEngine({
            runCtx: {
              ctx,
              repoRoot,
              runId,
              controlSessionId: context.sessionID,
              workspaceRoot: readyPreflight.workspaceRoot,
              workspaceAbs: readyPreflight.workspaceAbs,
              sessionAgents: readyPreflight.sessionAgents,
              uiSetup: readyPreflight.uiSetup,
              agentBrowserCaps: readyPreflight.agentBrowserCaps,
              nowIso,
              runStartIteration: readyPreflight.runStartIteration,
              abortSignal: context.abort,
            },
            preflightPrd: readyPreflight.prd,
            maxItems: readyPreflight.maxItems,
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
          return await finalizeRunCrash({
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
