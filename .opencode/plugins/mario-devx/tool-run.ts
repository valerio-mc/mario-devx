import { tool } from "@opencode-ai/plugin";

import {
  ensureT0002QualityBootstrap,
  type GateRunItem,
  hasNodeModules,
  missingPackageScriptForCommand,
  resolveNodeWorkspaceRoot,
  runGateCommands,
} from "./gates";
import {
  firstScaffoldHintFromNotes,
  getNextPrdTask,
  getTaskDependencyBlockers,
  isScaffoldMissingGateCommand,
  setPrdTaskLastAttempt,
  setPrdTaskStatus,
  validateTaskGraph,
} from "./planner";
import {
  deleteSessionBestEffort,
  ensureNotInWorkSession,
  resetWorkSession,
  setWorkSessionTitle,
  updateRunState,
  waitForSessionIdleStableDetailed,
} from "./runner";
import { clearSessionCaches, ensureMario, readRunState, writeRunState, bumpIteration } from "./state";
import { createRunId, logTaskBlocked, logTaskComplete } from "./logging";
import { acquireRunLock, heartbeatRunLock, releaseRunLock, runLockPath } from "./run-lock";
import { parseMaxItems, resolveSessionAgents, syncFrontendAgentsConfig, validateRunPrerequisites } from "./run-preflight";
import { RUN_PHASE, type RunLogMeta, type RunPhaseName } from "./run-types";
import { resolveUiRunSetup } from "./run-ui";
import { buildRunSummary } from "./run-report";
import { discoverAgentBrowserCapabilities } from "./agent-browser-capabilities";
import { RUN_EVENT, RUN_REASON } from "./run-contracts";
import {
  captureWorkspaceSnapshot,
  checkAcceptanceArtifacts,
  logGateRunResults as logGateRunResultsPhase,
  resolveEffectiveDoneWhen,
  runUiVerifyForTask as runUiVerifyForTaskPhase,
  summarizeWorkspaceDelta,
  toGateCommands,
  toGatesAttempt,
  toUiAttempt,
} from "./run-phase-helpers";
import { buildGateRepairPrompt, buildIterationTaskPlan, buildSemanticRepairPrompt } from "./run-prompts";
import { buildPrompt } from "./prompt";
import { getSessionIdleSequence } from "./session-idle-signal";
import { buildVerifierContextText } from "./run-verifier";
import { clearToastStreamChannel } from "./toast-stream";
import { LIMITS, TIMEOUTS } from "./config";
import { runPreflightStep } from "./run-preflight-step";
import { promptWorkSessionWithTimeout as promptWorkSessionWithTimeoutStep, resetWorkSessionWithTimeout as resetWorkSessionWithTimeoutStep } from "./run-work-session";
import { runGateRepairLoop } from "./run-gate-repair";
import { runSemanticRepairLoop } from "./run-semantic-repair";
import { finalizeRunCleanup, finalizeRunCrash, finalizeRunSuccess } from "./run-finalize";
import type { PrdGatesAttempt, PrdJudgeAttempt, PrdJson, PrdTask, PrdTaskAttempt, PrdUiAttempt } from "./prd";
import { writePrdJson } from "./prd";
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

          let prd = preflight.prd;
          const workspaceRoot = preflight.workspaceRoot;
          const workspaceAbs = preflight.workspaceAbs;
          const maxItems = preflight.maxItems;
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
            shouldRunUiVerify,
          } = preflight.uiSetup;
          const sessionAgents = preflight.sessionAgents;
          const agentBrowserCaps = preflight.agentBrowserCaps;
          const runStartIteration = preflight.runStartIteration;
          let attempted = 0;
          let completed = 0;

          const runLog = async (
            level: "info" | "warn" | "error",
            event: string,
            message: string,
            extra?: Record<string, unknown>,
            meta?: RunLogMeta,
          ): Promise<void> => {
            await logRunEvent(ctx, repoRoot, level, event, message, extra, meta);
          };

          const logGateRunResults = async (phase: RunPhaseName, taskId: string, gateResults: GateRunItem[]): Promise<void> => {
            await logGateRunResultsPhase({
              phase,
              taskId,
              gateResults,
              runCtx: { runId, repoRoot, workspaceRoot, workspaceAbs, ...(context.sessionID ? { controlSessionId: context.sessionID } : {}) },
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
              runCtx: { runId, repoRoot, workspaceRoot, workspaceAbs, ...(context.sessionID ? { controlSessionId: context.sessionID } : {}) },
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
              });
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
              });
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
                controlSessionId: context.sessionID,
              });
            };

            if (!(await heartbeatRunLock(repoRoot))) {
              await blockForHeartbeatFailure("pre-work-session-reset");
              break;
            }

            ws = await resetWorkSessionWithTimeout();
            if (!ws) {
              break;
            }
            await setWorkSessionTitle(ctx, ws.sessionId, `mario-devx (work) - ${task.id}`);
            await updateRunState(repoRoot, {
              status: "DOING",
              phase: "run",
              currentPI: task.id,
              controlSessionId: context.sessionID,
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
            if (!buildPromptDispatch.ok) {
              break;
            }

            if (!(await heartbeatRunLock(repoRoot))) {
              await blockForHeartbeatFailure("after-build-prompt");
              break;
            }

            const idle = await waitForSessionIdleStableDetailed(
              ctx,
              ws.sessionId,
              0,
              1,
              {
                afterSequence: buildPromptDispatch.idleSequenceBeforePrompt,
                abortSignal: context.abort,
              },
            );
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
              const idle = await waitForSessionIdleStableDetailed(
                ctx,
                ws.sessionId,
                0,
                1,
                {
                  afterSequence: idleSequenceBeforePrompt,
                  abortSignal: context.abort,
                },
              );
              return idle.ok;
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
              logGateRunResults: (phase, taskId, gateResults) => logGateRunResults(RUN_PHASE.REPAIR, taskId, gateResults),
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
              const elapsedMs = Date.now() - taskRepairStartedAt;
              await failEarly([
                `Deterministic gate failed: ${failed}.`,
                `Auto-repair stopped after ${Math.round(elapsedMs / 1000)}s across ${repairAttempts} attempt(s) (total repair turns: ${totalRepairAttempts}/${maxTotalRepairAttempts}; no-progress or time budget reached).`,
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
              await failEarly([
                "UI verification failed.",
              ]);
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
              controlSessionId: context.sessionID,
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
            controlSessionId: context.sessionID,
            updateRunState,
            buildRunSummary,
            logRunEvent,
            readTasks: () => prd.tasks ?? [],
            finishedEvent: RUN_EVENT.FINISHED,
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
