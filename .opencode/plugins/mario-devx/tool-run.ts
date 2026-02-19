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
import { clearSessionCaches, ensureMario, readRunState, readVerifierSessionState, readWorkSessionState, writeRunState, bumpIteration } from "./state";
import { createRunId, logTaskBlocked, logTaskComplete } from "./logging";
import { acquireRunLock, heartbeatRunLock, releaseRunLock, runLockPath } from "./run-lock";
import { parseMaxItems, syncFrontendAgentsConfig, validateRunPrerequisites } from "./run-preflight";
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
import { buildVerifierContextText } from "./run-verifier";
import { LIMITS, TIMEOUTS } from "./config";
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

          let prd = await ensurePrd(repoRoot);
          const workspaceRoot = await resolveNodeWorkspaceRoot(repoRoot);
          const workspaceAbs = workspaceRoot === "." ? repoRoot : `${repoRoot}/${workspaceRoot}`;
          const prerequisites = validateRunPrerequisites(prd);
          if (!prerequisites.ok) {
            const event = prerequisites.reasonCode === RUN_REASON.PRD_INCOMPLETE
              ? RUN_EVENT.BLOCKED_PRD_INCOMPLETE
              : prerequisites.reasonCode === RUN_REASON.NO_TASKS
                ? RUN_EVENT.BLOCKED_NO_TASKS
                : RUN_EVENT.BLOCKED_NO_QUALITY_GATES;
            await logRunEvent(ctx, repoRoot, "warn", event, "Run blocked during preflight validation", {
              ...(prerequisites.extra ?? {}),
            }, { runId, ...(prerequisites.reasonCode ? { reasonCode: prerequisites.reasonCode } : {}) });
            return prerequisites.message ?? "Run blocked during preflight validation.";
          }

          const inProgress = (prd.tasks ?? []).filter((t) => t.status === "in_progress");
          if (inProgress.length > 1) {
            const focus = inProgress[0];
            const ids = new Set(inProgress.map((t) => t.id));
            const state = await bumpIteration(repoRoot);
            const attemptAt = nowIso();
            const gates: PrdGatesAttempt = { ok: false, commands: [] };
            const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
            const judge: PrdJudgeAttempt = {
              status: "FAIL",
              exitSignal: false,
              reason: [
                `Invalid task state: multiple tasks are in_progress (${inProgress.map((t) => t.id).join(", ")}).`,
              ],
              nextActions: [
                "Edit .mario/prd.json so at most one task is in_progress (set the others to open/blocked/cancelled).",
                "Then rerun /mario-devx:run 1.",
              ],
            };
            const lastAttempt: PrdTaskAttempt = {
              at: attemptAt,
              iteration: state.iteration,
              gates,
              ui,
              judge,
            };
            prd = {
              ...prd,
              tasks: (prd.tasks ?? []).map((t) => (ids.has(t.id) ? { ...t, status: "blocked" as const } : t)),
            };
            for (const t of inProgress) {
              prd = setPrdTaskLastAttempt(prd, t.id, lastAttempt);
            }
            await writePrdJson(repoRoot, prd);
            await writeRunState(repoRoot, {
              iteration: state.iteration,
              status: "BLOCKED",
              phase: "run",
              ...(focus?.id ? { currentPI: focus.id } : {}),
              ...(context.sessionID ? { controlSessionId: context.sessionID } : {}),
              updatedAt: nowIso(),
            });
            await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_INVALID_TASK_STATE, "Run blocked: invalid in_progress task state", {
              inProgressTaskIds: inProgress.map((t) => t.id),
            }, { runId, reasonCode: RUN_REASON.INVALID_TASK_STATE });
            return judge.reason.concat(["", "See tasks[].lastAttempt.judge.nextActions in .mario/prd.json."]).join("\n");
          }

          const taskGraphIssue = validateTaskGraph(prd);
          if (taskGraphIssue) {
            const focusTask = (prd.tasks ?? []).find((t) => t.id === taskGraphIssue.taskId) ?? (prd.tasks ?? [])[0];
            if (focusTask) {
              const state = await bumpIteration(repoRoot);
              const attemptAt = nowIso();
              const gates: PrdGatesAttempt = { ok: false, commands: [] };
              const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
              const judge: PrdJudgeAttempt = {
                status: "FAIL",
                exitSignal: false,
                reason: [
                  formatReasonCode(taskGraphIssue.reasonCode),
                  taskGraphIssue.message,
                ],
                nextActions: taskGraphIssue.nextActions,
              };
              prd = await persistBlockedTaskAttempt({
                ctx,
                repoRoot,
                prd,
                task: focusTask,
                attemptAt,
                iteration: state.iteration,
                gates,
                ui,
                judge,
                runId,
              });
            }
            await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_TASK_GRAPH, "Run blocked: invalid task dependency graph", {
              reasonCode: taskGraphIssue.reasonCode,
              taskId: taskGraphIssue.taskId,
              message: taskGraphIssue.message,
            }, { runId, taskId: taskGraphIssue.taskId, reasonCode: taskGraphIssue.reasonCode });
            return [
              formatReasonCode(taskGraphIssue.reasonCode),
              taskGraphIssue.message,
              ...taskGraphIssue.nextActions,
            ].join("\n");
          }

          const frontendSync = await syncFrontendAgentsConfig({
            repoRoot,
            workspaceRoot,
            prd,
          });
          if (frontendSync.parseWarnings > 0) {
            await showToast(ctx, `Run warning: AGENTS.md parse warnings (${frontendSync.parseWarnings})`, "warning");
          }

          const maxItems = parseMaxItems(args.max_items);
          const uiSetup = await resolveUiRunSetup({
            ctx,
            repoRoot,
            workspaceRoot,
            onWarnings: async (count) => {
              await showToast(ctx, `Run warning: AGENTS.md parse warnings (${count})`, "warning");
            },
            onPrereqLog: async (entry) => {
              if (entry.event === "ui.prereq.browser-install.start") {
                await showToast(ctx, "Run: installing browser runtime for UI verification (may take a few minutes)", "info");
              }
              await logRunEvent(
                ctx,
                repoRoot,
                entry.level,
                entry.event,
                entry.message,
                entry.extra,
                { runId, ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) },
              );
            },
          });

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
          } = uiSetup;
          const defaultAgentBrowserCaps = {
            available: false,
            version: null,
            commands: [] as string[],
            openUsage: null,
            notes: [] as string[],
          };
          const agentBrowserCaps = (uiVerifyEnabled && isWebApp)
            ? await Promise.race([
              discoverAgentBrowserCapabilities(ctx),
              new Promise<typeof defaultAgentBrowserCaps>((resolve) => {
                setTimeout(() => {
                  resolve({
                    ...defaultAgentBrowserCaps,
                    notes: ["Capability probe timed out after 8s; continuing without capability metadata."],
                  });
                }, 8000);
              }),
            ])
            : defaultAgentBrowserCaps;

          if (uiVerifyEnabled && isWebApp) {
            await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.UI_CAPABILITIES, "Discovered agent-browser capabilities", {
              available: agentBrowserCaps.available,
              version: agentBrowserCaps.version,
              openUsage: agentBrowserCaps.openUsage,
              commands: agentBrowserCaps.commands,
              notes: agentBrowserCaps.notes,
            }, { runId });
          }

          await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.STARTED, "Run started", {
            maxItems,
            uiVerifyEnabled,
            uiVerifyRequired,
            shouldRunUiVerify,
            uiVerifyWaitMs: TIMEOUTS.UI_VERIFY_WAIT_MS,
            agentBrowserVersion: agentBrowserCaps.version,
            agentBrowserOpenUsage: agentBrowserCaps.openUsage,
            agentBrowserCommands: agentBrowserCaps.commands,
            agentBrowserNotes: agentBrowserCaps.notes,
          }, { runId });

          const runStartIteration = (await readRunState(repoRoot)).iteration;
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

          const runUiVerifyForTask = async (taskId: string): Promise<{ ok: boolean; note?: string } | null> => {
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

            const promptWorkSessionWithTimeout = async (
              phase: "build" | "repair" | "semantic-repair",
              text: string,
            ): Promise<boolean> => {
              const maxTransportAttempts = 3;
              const isTransportParseError = (message: string): boolean => {
                const m = message.toLowerCase();
                return m.includes("unexpected eof") || (m.includes("json parse") && m.includes("eof")) || m.includes("empty response");
              };
              try {
                for (let attempt = 1; attempt <= maxTransportAttempts; attempt += 1) {
                  try {
                    await Promise.race([
                      ctx.client.session.prompt({
                        path: { id: ws.sessionId },
                        body: {
                          ...(context.agent ? { agent: context.agent } : {}),
                          parts: [{ type: "text", text }],
                        },
                      }),
                      new Promise<never>((_, reject) => {
                        setTimeout(() => {
                          reject(new Error(`prompt dispatch timeout (${phase})`));
                        }, TIMEOUTS.PROMPT_DISPATCH_TIMEOUT_MS);
                      }),
                    ]);
                    return true;
                  } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    const timedOut = errorMessage.toLowerCase().includes("timeout");
                    const isTransport = isTransportParseError(errorMessage);
                    if (isTransport && attempt < maxTransportAttempts) {
                      await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
                      continue;
                    }
                    await blockForPromptDispatchFailure(
                      phase,
                      errorMessage,
                      timedOut ? RUN_REASON.WORK_PROMPT_DISPATCH_TIMEOUT : RUN_REASON.WORK_PROMPT_TRANSPORT_ERROR,
                    );
                    return false;
                  }
                }
                return false;
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                await blockForPromptDispatchFailure(phase, errorMessage, RUN_REASON.WORK_PROMPT_TRANSPORT_ERROR);
                return false;
              }
            };

            if (!(await heartbeatRunLock(repoRoot))) {
              await blockForHeartbeatFailure("pre-work-session-reset");
              break;
            }

            const ws = await Promise.race([
              resetWorkSession(ctx, repoRoot, context.agent),
              new Promise<never>((_, reject) => {
                setTimeout(() => {
                  reject(new Error("resetWorkSession timeout"));
                }, TIMEOUTS.WORK_SESSION_RESET_TIMEOUT_MS);
              }),
            ]).catch(async (error) => {
              const gates: PrdGatesAttempt = { ok: false, commands: [] };
              const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
              const errorMessage = error instanceof Error ? error.message : String(error);
              const judge: PrdJudgeAttempt = {
                status: "FAIL",
                exitSignal: false,
                reason: [
                  formatReasonCode(RUN_REASON.WORK_SESSION_RESET_TIMEOUT),
                  `Work session reset timed out (${TIMEOUTS.WORK_SESSION_RESET_TIMEOUT_MS}ms).`,
                  errorMessage,
                ],
                nextActions: [
                  "Retry /mario-devx:run 1.",
                  "If this repeats, restart OpenCode and rerun.",
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
              await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_WORK_SESSION_RESET_TIMEOUT, "Run blocked: work-session reset timed out", {
                taskId: task.id,
                timeoutMs: TIMEOUTS.WORK_SESSION_RESET_TIMEOUT_MS,
                error: errorMessage,
              }, { runId, taskId: task.id, reasonCode: RUN_REASON.WORK_SESSION_RESET_TIMEOUT });
              return null;
            });
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
              startedAt: nowIso(),
            });

            const buildPromptSent = await promptWorkSessionWithTimeout("build", buildModePrompt);
            if (!buildPromptSent) {
              break;
            }

            if (!(await heartbeatRunLock(repoRoot))) {
              await blockForHeartbeatFailure("after-build-prompt");
              break;
            }

            const idle = await waitForSessionIdleStableDetailed(ctx, ws.sessionId, TIMEOUTS.SESSION_IDLE_TIMEOUT_MS);
            if (!idle.ok) {
              const gates: PrdGatesAttempt = { ok: false, commands: [] };
              const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
              const judge: PrdJudgeAttempt = {
                status: "FAIL",
                exitSignal: false,
                reason: ["Build timed out waiting for the work session to go idle."],
                nextActions: ["Rerun /mario-devx:status; if it remains stuck, inspect the work session via /sessions."],
              };
              prd = await persistBlockedTaskAttempt({ ctx, repoRoot, prd, task, attemptAt, iteration: state.iteration, gates, ui, judge, runId });
              break;
            }

            let gateResult = await runGateCommands(gateCommands, ctx.$, workspaceAbs);
            await logGateRunResults(RUN_PHASE.REPAIR, task.id, gateResult.results);

            const taskRepairStartedAt = Date.now();
            let repairAttempts = 0;
            let totalRepairAttempts = 0;
            const maxTotalRepairAttempts = LIMITS.MAX_TOTAL_REPAIR_ATTEMPTS;
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

              if (repairAttempts > 0 && (elapsedMs >= TIMEOUTS.MAX_TASK_REPAIR_MS || noProgressStreak >= LIMITS.MAX_NO_PROGRESS_STREAK || totalRepairAttempts >= maxTotalRepairAttempts)) {
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
                await logGateRunResults(RUN_PHASE.REPAIR, task.id, gateResult.results);
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
              const repairPromptSent = await promptWorkSessionWithTimeout("repair", repairPrompt);
              if (!repairPromptSent) {
                break;
              }

              if (!(await heartbeatRunLock(repoRoot))) {
                await blockForHeartbeatFailure("during-auto-repair");
                break;
              }

              const repairIdle = await waitForSessionIdleStableDetailed(ctx, ws.sessionId, TIMEOUTS.REPAIR_IDLE_TIMEOUT_MS);
              if (!repairIdle.ok) break;

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
              await logGateRunResults(RUN_PHASE.REPAIR, task.id, gateResult.results);
            }

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

            let blockedByVerifierFailure = false;
            let judge: PrdJudgeAttempt | null = null;
            let semanticRepairAttempts = 0;
            let semanticNoProgressStreak = 0;

            while (true) {
              const verifierPrompt = await buildPrompt(repoRoot, "verify", buildVerifierContextText({
                task,
                doneWhen: effectiveDoneWhen,
                gates: latestGateResult.results,
                uiResult: latestUiResult,
                ...(latestUiResult?.note ? { uiNote: latestUiResult.note } : {}),
                visualDirection: prd.ui.visualDirection,
                uxRequirements: prd.ui.uxRequirements,
                styleReferences: prd.ui.styleReferences,
                caps: agentBrowserCaps,
                uiUrl: uiVerifyUrl,
              }));

              const verifierOutcome = await resolveVerifierJudge({
                ctx,
                repoRoot,
                verifierPrompt,
                runId,
                taskId: task.id,
                capabilitySummary: buildCapabilitySummary(agentBrowserCaps),
                ...(context.agent ? { agent: context.agent } : {}),
              });

              if (!(await heartbeatRunLock(repoRoot))) {
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

              if (semanticRepairAttempts >= LIMITS.MAX_VERIFIER_REPAIR_ATTEMPTS || totalRepairAttempts >= maxTotalRepairAttempts) {
                break;
              }

              semanticRepairAttempts += 1;
              totalRepairAttempts += 1;
              const actionableReason = firstActionableJudgeReason(judge) ?? "Verifier failed to confirm acceptance.";
              const strictChecklist = semanticNoProgressStreak > 0
                ? "Repeated finding detected with no clear progress. Make explicit file edits that directly satisfy acceptance criteria; avoid generic refinements."
                : "";
              const semanticRepairPrompt = buildSemanticRepairPrompt({ taskId: task.id, acceptance: task.acceptance ?? [], actionableReason, judge, carryForwardIssues, strictChecklist });

              const semanticSnapshotBefore = await captureWorkspaceSnapshot(repoRoot);
              const semanticPromptSent = await promptWorkSessionWithTimeout("semantic-repair", semanticRepairPrompt);
              if (!semanticPromptSent) {
                blockedByVerifierFailure = true;
                break;
              }

              if (!(await heartbeatRunLock(repoRoot))) {
                await blockForHeartbeatFailure("during-semantic-repair");
                blockedByVerifierFailure = true;
                break;
              }

              const semanticIdle = await waitForSessionIdleStableDetailed(ctx, ws.sessionId, TIMEOUTS.REPAIR_IDLE_TIMEOUT_MS);
              if (!semanticIdle.ok) {
                blockedByVerifierFailure = true;
                break;
              }

              const semanticSnapshotAfter = await captureWorkspaceSnapshot(repoRoot);
              const semanticDelta = summarizeWorkspaceDelta(semanticSnapshotBefore, semanticSnapshotAfter);
              if (semanticDelta.changed === 0) {
                semanticNoProgressStreak += 1;
                if (semanticNoProgressStreak >= 2 || semanticRepairAttempts >= LIMITS.MAX_VERIFIER_REPAIR_ATTEMPTS) {
                  await failEarly([
                    formatReasonCode(RUN_REASON.WORK_SESSION_NO_PROGRESS),
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
              latestUiResult = latestGateResult.ok ? await runUiVerifyForTask(task.id) : null;
              gates = toGatesAttempt(latestGateResult);
              ui = toUiAttempt({ gateOk: latestGateResult.ok, uiResult: latestUiResult, uiVerifyEnabled, isWebApp, cliOk, skillOk, browserOk });

              if (!latestGateResult.ok) {
                await failEarly([
                  formatReasonCode(RUN_REASON.SEMANTIC_REPAIR_GATE_REGRESSION),
                  `Deterministic gate failed after semantic repair: ${latestGateResult.failed ? `${latestGateResult.failed.command} (exit ${latestGateResult.failed.exitCode})` : "(unknown command)"}.`,
                ]);
                blockedByVerifierFailure = true;
                break;
              }
            }

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

          const blockedThisRun = (prd.tasks ?? []).some((t) => {
            if (t.status !== "blocked" || !t.lastAttempt) return false;
            return t.lastAttempt.iteration > runStartIteration;
          });
          const finalRunStatus = blockedThisRun ? "BLOCKED" : "DONE";

          await updateRunState(repoRoot, {
            status: finalRunStatus,
            phase: "run",
            ...(context.sessionID ? { controlSessionId: context.sessionID } : {}),
            updatedAt: nowIso(),
          });

          const { result, latestTask, judgeTopReason } = buildRunSummary({
            attempted,
            completed,
            maxItems,
            tasks: prd.tasks ?? [],
            runNotes: [],
            uiVerifyRequired,
          });

          await updateRunState(repoRoot, {
            ...(context.sessionID ? { lastRunControlSessionId: context.sessionID } : {}),
            lastRunAt: nowIso(),
            lastRunResult: result,
          });

          await logRunEvent(ctx, repoRoot, finalRunStatus === "DONE" ? "info" : "warn", RUN_EVENT.FINISHED, "Run finished", {
            attempted,
            completed,
            status: finalRunStatus,
            latestTaskId: latestTask?.id ?? null,
            reason: judgeTopReason,
          }, { runId, ...(latestTask?.id ? { taskId: latestTask.id } : {}) });

          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.FATAL_EXCEPTION, "Run crashed with unhandled exception", {
            error: errorMessage,
            stack: error instanceof Error ? error.stack ?? "" : "",
          }, { runId, reasonCode: RUN_REASON.RUN_FATAL_EXCEPTION });
          const current = await readRunState(repoRoot);
          await writeRunState(repoRoot, {
            ...current,
            status: "BLOCKED",
            phase: "run",
            updatedAt: nowIso(),
            ...(context.sessionID ? { controlSessionId: context.sessionID } : {}),
            lastRunAt: nowIso(),
            lastRunResult: `Run failed unexpectedly: ${errorMessage}. See .mario/state/mario-devx.log for details.`,
          });
          await showToast(ctx, "Run crashed unexpectedly; see mario-devx.log for details", "warning");
          return `Run failed unexpectedly: ${errorMessage}\nCheck .mario/state/mario-devx.log and rerun /mario-devx:run 1.`;
        } finally {
          try {
            await logRunEvent(ctx, repoRoot, "info", "run.session.cleanup.start", "Cleaning cached work/verifier sessions", {
              controlSessionId: context.sessionID ?? null,
            }, { runId });

            const [workSessionState, verifierSessionState] = await Promise.all([
              readWorkSessionState(repoRoot),
              readVerifierSessionState(repoRoot),
            ]);

            const deleteResults: Record<string, string> = {};
            const deletedIds = new Set<string>();
            const sessionsToDelete = [
              { key: "work", id: workSessionState?.sessionId },
              { key: "verifier", id: verifierSessionState?.sessionId },
            ];

            for (const session of sessionsToDelete) {
              if (!session.id) {
                deleteResults[session.key] = "none";
                continue;
              }
              if (deletedIds.has(session.id)) {
                deleteResults[session.key] = "deduped";
                continue;
              }
              const result = await deleteSessionBestEffort(ctx, session.id, context.sessionID);
              deleteResults[session.key] = result;
              if (result === "deleted" || result === "not-found") {
                deletedIds.add(session.id);
              }
            }

            await clearSessionCaches(repoRoot);
            await updateRunState(repoRoot, {
              workSessionId: undefined,
              baselineMessageId: undefined,
            });

            await logRunEvent(ctx, repoRoot, "info", "run.session.cleanup.ok", "Session cleanup complete", {
              ...deleteResults,
            }, { runId });
          } catch (cleanupError) {
            await logRunEvent(ctx, repoRoot, "warn", "run.session.cleanup.failed", "Session cleanup failed (best-effort)", {
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            }, { runId });
          }
          await releaseRunLock(repoRoot);
        }
      },
    }),
  };
};
