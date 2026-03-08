import { RUN_EVENT, RUN_REASON } from "./run-contracts";
import type { PrdGatesAttempt, PrdJudgeAttempt, PrdJson, PrdTask, PrdTaskAttempt, PrdUiAttempt } from "./prd";

export const createFailedGatesAttempt = (): PrdGatesAttempt => ({
  ok: false,
  commands: [],
});

export const createUnranUiAttempt = (note = "UI verification not run."): PrdUiAttempt => ({
  ran: false,
  ok: null,
  note,
});

export const createFailureJudge = (opts: {
  reason: string[];
  nextActions?: string[];
}): PrdJudgeAttempt => {
  const { reason, nextActions } = opts;
  return {
    status: "FAIL",
    exitSignal: false,
    reason,
    nextActions: nextActions && nextActions.length > 0 ? nextActions : ["Fix the failing checks, then rerun /mario-devx:run 1."],
  };
};

export const createBlockedTaskAttempt = (opts: {
  at: string;
  iteration: number;
  judge: PrdJudgeAttempt;
  gates?: PrdGatesAttempt;
  ui?: PrdUiAttempt;
}): PrdTaskAttempt => {
  const { at, iteration, judge, gates, ui } = opts;
  return {
    at,
    iteration,
    gates: gates ?? createFailedGatesAttempt(),
    ui: ui ?? createUnranUiAttempt(),
    judge,
  };
};

export const persistTaskFailureAttempt = async (opts: {
  ctx: any;
  repoRoot: string;
  prd: PrdJson;
  task: PrdTask;
  attemptAt: string;
  iteration: number;
  runId: string;
  gates: PrdGatesAttempt;
  ui: PrdUiAttempt;
  reasonLines: string[];
  nextActions?: string[];
  keepRunActive?: boolean;
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
}): Promise<PrdJson> => {
  const {
    ctx,
    repoRoot,
    prd,
    task,
    attemptAt,
    iteration,
    runId,
    gates,
    ui,
    reasonLines,
    nextActions,
    keepRunActive,
    persistBlockedTaskAttempt,
  } = opts;
  const judge = createFailureJudge({
    reason: reasonLines,
    nextActions,
  });
  return persistBlockedTaskAttempt({
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
    ...(keepRunActive ? { runStateStatus: "DOING" as const, logAsRunBlocked: false } : {}),
  });
};

export const handleHeartbeatFailure = async (opts: {
  ctx: any;
  repoRoot: string;
  prd: PrdJson;
  task: PrdTask;
  attemptAt: string;
  iteration: number;
  runId: string;
  phase: string;
  lockPath: string;
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
  logRunEvent: (
    ctx: any,
    repoRoot: string,
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    runCtx?: { runId?: string; taskId?: string; reasonCode?: string },
  ) => Promise<void>;
}): Promise<PrdJson> => {
  const {
    ctx,
    repoRoot,
    prd,
    task,
    attemptAt,
    iteration,
    runId,
    phase,
    lockPath,
    persistBlockedTaskAttempt,
    logRunEvent,
  } = opts;
  const nextPrd = await persistTaskFailureAttempt({
    ctx,
    repoRoot,
    prd,
    task,
    attemptAt,
    iteration,
    runId,
    gates: createFailedGatesAttempt(),
    ui: createUnranUiAttempt(),
    reasonLines: [`Failed to update run.lock heartbeat during ${phase} (${lockPath}).`],
    nextActions: ["Check disk space/permissions for .mario/state/run.lock, then rerun /mario-devx:run 1."],
    persistBlockedTaskAttempt,
  });

  await logRunEvent(
    ctx,
    repoRoot,
    "error",
    RUN_EVENT.BLOCKED_HEARTBEAT,
    `Run blocked: lock heartbeat failed during ${phase}`,
    {
      taskId: task.id,
      phase,
      lockPath,
    },
    { runId, taskId: task.id, reasonCode: RUN_REASON.HEARTBEAT_FAILED },
  );
  return nextPrd;
};

export const handlePromptDispatchFailure = async (opts: {
  ctx: any;
  repoRoot: string;
  prd: PrdJson;
  task: PrdTask;
  attemptAt: string;
  iteration: number;
  runId: string;
  phase: "build" | "repair" | "semantic-repair";
  errorMessage: string;
  reasonCode: typeof RUN_REASON.WORK_PROMPT_DISPATCH_TIMEOUT | typeof RUN_REASON.WORK_PROMPT_TRANSPORT_ERROR;
  timeoutMs: number;
  formatReasonCode: (code: string) => string;
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
  logRunEvent: (
    ctx: any,
    repoRoot: string,
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    runCtx?: { runId?: string; taskId?: string; reasonCode?: string },
  ) => Promise<void>;
}): Promise<PrdJson> => {
  const {
    ctx,
    repoRoot,
    prd,
    task,
    attemptAt,
    iteration,
    runId,
    phase,
    errorMessage,
    reasonCode,
    timeoutMs,
    formatReasonCode,
    persistBlockedTaskAttempt,
    logRunEvent,
  } = opts;
  const isTimeout = reasonCode === RUN_REASON.WORK_PROMPT_DISPATCH_TIMEOUT;
  const nextPrd = await persistTaskFailureAttempt({
    ctx,
    repoRoot,
    prd,
    task,
    attemptAt,
    iteration,
    runId,
    gates: createFailedGatesAttempt(),
    ui: createUnranUiAttempt(),
    reasonLines: [
      formatReasonCode(reasonCode),
      isTimeout
        ? `Work-session prompt dispatch timed out during ${phase} (${timeoutMs}ms).`
        : `Work-session prompt dispatch failed during ${phase} (transport parse failure).`,
      errorMessage,
    ],
    nextActions: [
      "Retry /mario-devx:run 1.",
      "If it repeats, restart OpenCode to refresh session RPC state.",
    ],
    persistBlockedTaskAttempt,
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
      timeoutMs,
      error: errorMessage,
    },
    { runId, taskId: task.id, reasonCode },
  );
  return nextPrd;
};
