import { RUN_EVENT, RUN_REASON } from "./run-contracts";
import { buildUiVerifyBlockedPayload } from "./run-ui-failure-actions";
import type { PrdGatesAttempt, PrdJudgeAttempt, PrdJson, PrdTask, PrdUiAttempt } from "./prd";

export const createTaskFailureHandlers = (opts: {
  ctx: any;
  repoRoot: string;
  runId: string;
  task: PrdTask;
  attemptAt: string;
  iteration: number;
  continueOnTaskFailure: boolean;
  getPrd: () => PrdJson;
  setPrd: (next: PrdJson) => void;
  getGates: () => PrdGatesAttempt;
  getUi: () => PrdUiAttempt;
  firstActionableJudgeReason: (judge: PrdJudgeAttempt | undefined) => string | null;
  persistTaskFailureAttempt: (opts: {
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
    keepRunActive: boolean;
    persistBlockedTaskAttempt: (opts: any) => Promise<PrdJson>;
  }) => Promise<PrdJson>;
  persistBlockedTaskAttempt: (opts: any) => Promise<PrdJson>;
  logTaskBlocked: (ctx: any, repoRoot: string, taskId: string, reason: string) => Promise<void>;
  noteTaskFailureStop: () => void;
  runLog: (
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    meta?: { runId?: string; taskId?: string; reasonCode?: string },
  ) => Promise<void>;
}) => {
  const {
    ctx,
    repoRoot,
    runId,
    task,
    attemptAt,
    iteration,
    continueOnTaskFailure,
    getPrd,
    setPrd,
    getGates,
    getUi,
    firstActionableJudgeReason,
    persistTaskFailureAttempt,
    persistBlockedTaskAttempt,
    logTaskBlocked,
    noteTaskFailureStop,
    runLog,
  } = opts;

  let uiVerifyBlockedLogged = false;
  let taskFailureRecorded = false;

  const failEarly = async (
    reasonLines: string[],
    nextActions?: string[],
    scope: "task" | "global" = "task",
  ): Promise<void> => {
    if (scope === "task") {
      taskFailureRecorded = true;
    }
    const nextPrd = await persistTaskFailureAttempt({
      ctx,
      repoRoot,
      prd: getPrd(),
      task,
      attemptAt,
      iteration,
      runId,
      gates: getGates(),
      ui: getUi(),
      reasonLines,
      nextActions,
      keepRunActive: scope === "task" && continueOnTaskFailure,
      persistBlockedTaskAttempt,
    });
    setPrd(nextPrd);
  };

  const stopOrContinueTaskFailure = async (blockedReason: string): Promise<"break" | "continue"> => {
    await logTaskBlocked(ctx, repoRoot, task.id, blockedReason);
    if (!continueOnTaskFailure) {
      noteTaskFailureStop();
      return "break";
    }
    return "continue";
  };

  const recordAndHandleTaskFailure = async (args: {
    reasonLines: string[];
    blockedReason: string;
    nextActions?: string[];
  }): Promise<"break" | "continue"> => {
    await failEarly(args.reasonLines, args.nextActions);
    return stopOrContinueTaskFailure(args.blockedReason);
  };

  const latestBlockedReasonForTask = (): string => {
    const latestTask = (getPrd().tasks ?? []).find((candidate) => candidate.id === task.id);
    return firstActionableJudgeReason(latestTask?.lastAttempt?.judge)
      ?? latestTask?.lastAttempt?.judge?.reason?.[0]
      ?? "No reason provided";
  };

  const logUiVerifyBlocked = async (phase: string): Promise<void> => {
    if (uiVerifyBlockedLogged) {
      return;
    }
    uiVerifyBlockedLogged = true;
    await runLog(
      "error",
      RUN_EVENT.UI_VERIFY_BLOCKED,
      `Run blocked: required UI verification failed during ${phase}`,
      buildUiVerifyBlockedPayload(getUi(), phase),
      { runId, taskId: task.id, reasonCode: RUN_REASON.UI_VERIFY_FAILED },
    );
  };

  return {
    failEarly,
    stopOrContinueTaskFailure,
    recordAndHandleTaskFailure,
    latestBlockedReasonForTask,
    logUiVerifyBlocked,
    wasTaskFailureRecorded: () => taskFailureRecorded,
  };
};
