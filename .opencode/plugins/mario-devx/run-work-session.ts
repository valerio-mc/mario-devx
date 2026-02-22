import { RUN_REASON } from "./run-contracts";
import { TIMEOUTS } from "./config";
import type { PrdGatesAttempt, PrdJudgeAttempt, PrdJson, PrdTask, PrdUiAttempt } from "./prd";

export type WorkSessionInfo = { sessionId: string; baselineMessageId: string };

export const resetWorkSessionWithTimeout = async (opts: {
  ctx: any;
  repoRoot: string;
  runId: string;
  task: PrdTask;
  prd: PrdJson;
  attemptAt: string;
  iteration: number;
  formatReasonCode: (code: string) => string;
  resetWorkSession: (ctx: any, repoRoot: string, agent: string | undefined) => Promise<WorkSessionInfo>;
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
  logRunEvent: (
    ctx: any,
    repoRoot: string,
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    runCtx?: { runId?: string; taskId?: string; reasonCode?: string },
  ) => Promise<void>;
  blockedEvent: string;
  workAgent?: string;
}): Promise<{ session: WorkSessionInfo | null; prd: PrdJson }> => {
  const {
    ctx,
    repoRoot,
    runId,
    task,
    prd,
    attemptAt,
    iteration,
    formatReasonCode,
    resetWorkSession,
    persistBlockedTaskAttempt,
    logRunEvent,
    blockedEvent,
    workAgent,
  } = opts;

  const session = await Promise.race([
    resetWorkSession(ctx, repoRoot, workAgent),
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error("resetWorkSession timeout"));
      }, TIMEOUTS.WORK_SESSION_RESET_TIMEOUT_MS);
    }),
  ]).catch(async (error) => {
    const gates: PrdGatesAttempt = { ok: false, commands: [] };
    const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = /timeout/i.test(errorMessage);
    const judge: PrdJudgeAttempt = {
      status: "FAIL",
      exitSignal: false,
      reason: [
        formatReasonCode(isTimeout ? RUN_REASON.WORK_SESSION_RESET_TIMEOUT : RUN_REASON.WORK_PROMPT_TRANSPORT_ERROR),
        isTimeout
          ? `Work session reset timed out (${TIMEOUTS.WORK_SESSION_RESET_TIMEOUT_MS}ms).`
          : "Work session reset failed while recovering from transport errors.",
        errorMessage,
      ],
      nextActions: [
        "Retry /mario-devx:run 1.",
        "If this repeats, restart OpenCode and rerun.",
      ],
    };
    const nextPrd = await persistBlockedTaskAttempt({
      ctx,
      repoRoot,
      prd,
      task,
      attemptAt,
      iteration,
      gates,
      ui,
      judge,
      runId,
    });
    await logRunEvent(
      ctx,
      repoRoot,
      "error",
      blockedEvent,
      "Run blocked: work-session reset failed",
      {
        taskId: task.id,
        timeoutMs: TIMEOUTS.WORK_SESSION_RESET_TIMEOUT_MS,
        error: errorMessage,
      },
      {
        runId,
        taskId: task.id,
        reasonCode: isTimeout ? RUN_REASON.WORK_SESSION_RESET_TIMEOUT : RUN_REASON.WORK_PROMPT_TRANSPORT_ERROR,
      },
    );
    return { __failed: true as const, prd: nextPrd };
  });

  if ((session as { __failed?: boolean })?.__failed) {
    return { session: null, prd: (session as { prd: PrdJson }).prd };
  }
  return { session: session as WorkSessionInfo, prd };
};

export const promptWorkSessionWithTimeout = async (opts: {
  ctx: any;
  repoRoot: string;
  runId: string;
  taskId: string;
  phase: "build" | "repair" | "semantic-repair";
  text: string;
  getWorkSession: () => WorkSessionInfo | null;
  setWorkSession: (value: WorkSessionInfo) => Promise<void>;
  resetWorkSession: () => Promise<WorkSessionInfo | null>;
  deleteSessionBestEffort: (ctx: any, sessionId: string, controlSessionId?: string) => Promise<"deleted" | "not-found" | "skipped-control" | "failed" | "none">;
  setWorkSessionTitle: (ctx: any, sessionId: string, title: string) => Promise<void>;
  updateRunState: (repoRoot: string, patch: Record<string, unknown>) => Promise<unknown>;
  getIdleSequence: (sessionId: string) => number;
  logRunEvent: (
    ctx: any,
    repoRoot: string,
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    runCtx?: { runId?: string; taskId?: string; reasonCode?: string },
  ) => Promise<void>;
  onDispatchFailure: (phase: "build" | "repair" | "semantic-repair", errorMessage: string, reasonCode: string) => Promise<void>;
  workAgent?: string;
  controlSessionId?: string;
}): Promise<{ ok: true; idleSequenceBeforePrompt: number } | { ok: false }> => {
  const {
    ctx,
    repoRoot,
    runId,
    taskId,
    phase,
    text,
    getWorkSession,
    setWorkSession,
    resetWorkSession,
    deleteSessionBestEffort,
    setWorkSessionTitle,
    updateRunState,
    getIdleSequence,
    logRunEvent,
    onDispatchFailure,
    workAgent,
    controlSessionId,
  } = opts;

  const maxTransportAttempts = 3;
  const isTransportParseError = (message: string): boolean => {
    const m = message.toLowerCase();
    return m.includes("unexpected eof") || (m.includes("json parse") && m.includes("eof")) || m.includes("empty response");
  };

  try {
    for (let attempt = 1; attempt <= maxTransportAttempts; attempt += 1) {
      try {
        const ws = getWorkSession();
        if (!ws) {
          await onDispatchFailure(phase, "Work session was not initialized before prompt dispatch.", RUN_REASON.WORK_PROMPT_TRANSPORT_ERROR);
          return { ok: false };
        }
        const idleSequenceBeforePrompt = getIdleSequence(ws.sessionId);
        await logRunEvent(ctx, repoRoot, "info", "run.work.prompt.send", "Dispatching work prompt", {
          taskId,
          phase,
          attempt,
          workSessionId: ws.sessionId,
        }, { runId, taskId });

        await Promise.race([
          ctx.client.session.promptAsync({
            path: { id: ws.sessionId },
            body: {
              ...(workAgent ? { agent: workAgent } : {}),
              parts: [{ type: "text", text }],
            },
          }),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error(`prompt dispatch timeout (${phase})`));
            }, TIMEOUTS.PROMPT_DISPATCH_TIMEOUT_MS);
          }),
        ]);

        await logRunEvent(ctx, repoRoot, "info", "run.work.prompt.sent", "Work prompt dispatched", {
          taskId,
          phase,
          attempt,
          workSessionId: ws.sessionId,
        }, { runId, taskId });

        return { ok: true, idleSequenceBeforePrompt };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const timedOut = errorMessage.toLowerCase().includes("timeout");
        const isTransport = isTransportParseError(errorMessage);
        if (isTransport && attempt < maxTransportAttempts) {
          const previousSessionId = getWorkSession()?.sessionId ?? null;
          await logRunEvent(ctx, repoRoot, "warn", "run.work.prompt.transport-retry", "Transport parse failure, rotating work session and retrying", {
            taskId,
            phase,
            attempt,
            maxTransportAttempts,
            previousWorkSessionId: previousSessionId,
            error: errorMessage,
          }, { runId, taskId, reasonCode: RUN_REASON.WORK_PROMPT_TRANSPORT_ERROR });
          if (previousSessionId) {
            await deleteSessionBestEffort(ctx, previousSessionId, controlSessionId);
          }
          const rotated = await resetWorkSession();
          if (!rotated) {
            return { ok: false };
          }
          await setWorkSession(rotated);
          await setWorkSessionTitle(ctx, rotated.sessionId, `mario-devx (work) - ${taskId}`);
          await updateRunState(repoRoot, {
            workSessionId: rotated.sessionId,
            baselineMessageId: rotated.baselineMessageId,
            ...(controlSessionId ? { controlSessionId } : {}),
          });
          await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
          continue;
        }
        await onDispatchFailure(
          phase,
          errorMessage,
          timedOut ? RUN_REASON.WORK_PROMPT_DISPATCH_TIMEOUT : RUN_REASON.WORK_PROMPT_TRANSPORT_ERROR,
        );
        return { ok: false };
      }
    }
    return { ok: false };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await onDispatchFailure(phase, errorMessage, RUN_REASON.WORK_PROMPT_TRANSPORT_ERROR);
    return { ok: false };
  }
};
