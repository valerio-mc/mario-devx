import { clearToastStreamChannel } from "./toast-stream";

export const finalizeRunSuccess = async (opts: {
  ctx: any;
  repoRoot: string;
  runId: string;
  nowIso: () => string;
  attempted: number;
  completed: number;
  maxItems: number;
  prd: { tasks?: any[]; uiVerificationRequired?: boolean };
  runStartIteration: number;
  controlSessionId?: string;
  updateRunState: (repoRoot: string, patch: Record<string, unknown>) => Promise<unknown>;
  buildRunSummary: (opts: {
    attempted: number;
    completed: number;
    maxItems: number;
    tasks: any[];
    runNotes: string[];
    uiVerifyRequired: boolean;
  }) => { result: string; latestTask?: { id: string } | null; judgeTopReason?: string | null };
  logRunEvent: (
    ctx: any,
    repoRoot: string,
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    runCtx?: { runId?: string; taskId?: string; reasonCode?: string },
  ) => Promise<void>;
  readTasks: () => any[];
  finishedEvent: string;
}): Promise<string> => {
  const {
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
    readTasks,
    finishedEvent,
  } = opts;

  const blockedThisRun = readTasks().some((t) => {
    if (t.status !== "blocked" || !t.lastAttempt) return false;
    return t.lastAttempt.iteration > runStartIteration;
  });
  const finalRunStatus = blockedThisRun ? "BLOCKED" : "DONE";

  await updateRunState(repoRoot, {
    status: finalRunStatus,
    phase: "run",
    ...(controlSessionId ? { controlSessionId } : {}),
    updatedAt: nowIso(),
  });

  const { result, latestTask, judgeTopReason } = buildRunSummary({
    attempted,
    completed,
    maxItems,
    tasks: readTasks(),
    runNotes: [],
    uiVerifyRequired: prd.uiVerificationRequired === true,
  });

  await updateRunState(repoRoot, {
    ...(controlSessionId ? { lastRunControlSessionId: controlSessionId } : {}),
    lastRunAt: nowIso(),
    lastRunResult: result,
  });

  await logRunEvent(ctx, repoRoot, finalRunStatus === "DONE" ? "info" : "warn", finishedEvent, "Run finished", {
    attempted,
    completed,
    status: finalRunStatus,
    latestTaskId: latestTask?.id ?? null,
    reason: judgeTopReason,
  }, { runId, ...(latestTask?.id ? { taskId: latestTask.id } : {}) });

  return result;
};

export const finalizeRunCrash = async (opts: {
  ctx: any;
  repoRoot: string;
  runId: string;
  nowIso: () => string;
  controlSessionId?: string;
  error: unknown;
  fatalEvent: string;
  fatalReasonCode: string;
  readRunState: (repoRoot: string) => Promise<any>;
  writeRunState: (repoRoot: string, next: any) => Promise<void>;
  logRunEvent: (
    ctx: any,
    repoRoot: string,
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    runCtx?: { runId?: string; taskId?: string; reasonCode?: string },
  ) => Promise<void>;
  showToast: (ctx: any, message: string, variant?: "info" | "success" | "warning" | "error") => Promise<void>;
}): Promise<string> => {
  const {
    ctx,
    repoRoot,
    runId,
    nowIso,
    controlSessionId,
    error,
    fatalEvent,
    fatalReasonCode,
    readRunState,
    writeRunState,
    logRunEvent,
    showToast,
  } = opts;

  const errorMessage = error instanceof Error ? error.message : String(error);
  await logRunEvent(ctx, repoRoot, "error", fatalEvent, "Run crashed with unhandled exception", {
    error: errorMessage,
    stack: error instanceof Error ? error.stack ?? "" : "",
  }, { runId, reasonCode: fatalReasonCode });
  const current = await readRunState(repoRoot);
  await writeRunState(repoRoot, {
    ...current,
    status: "BLOCKED",
    phase: "run",
    updatedAt: nowIso(),
    ...(controlSessionId ? { controlSessionId } : {}),
    lastRunAt: nowIso(),
    lastRunResult: `Run failed unexpectedly: ${errorMessage}. See .mario/state/mario-devx.log for details.`,
  });
  await showToast(ctx, "Run crashed unexpectedly; see mario-devx.log for details", "warning");
  return `Run failed unexpectedly: ${errorMessage}\nCheck .mario/state/mario-devx.log and rerun /mario-devx:run 1.`;
};

export const finalizeRunCleanup = async (opts: {
  ctx: any;
  repoRoot: string;
  runId: string;
  controlSessionId?: string;
  clearSessionCaches: (repoRoot: string) => Promise<void>;
  readRunState: (repoRoot: string) => Promise<any>;
  updateRunState: (repoRoot: string, patch: Record<string, unknown>) => Promise<unknown>;
  deleteSessionBestEffort: (ctx: any, sessionId: string | undefined, controlSessionId?: string) => Promise<"deleted" | "not-found" | "skipped-control" | "failed" | "none">;
  releaseRunLock: (repoRoot: string) => Promise<void>;
  logRunEvent: (
    ctx: any,
    repoRoot: string,
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    runCtx?: { runId?: string; taskId?: string; reasonCode?: string },
  ) => Promise<void>;
}): Promise<void> => {
  const {
    ctx,
    repoRoot,
    runId,
    controlSessionId,
    clearSessionCaches,
    readRunState,
    updateRunState,
    deleteSessionBestEffort,
    releaseRunLock,
    logRunEvent,
  } = opts;

  try {
    await logRunEvent(ctx, repoRoot, "info", "run.session.cleanup.start", "Cleaning ephemeral phase sessions", {
      controlSessionId: controlSessionId ?? null,
    }, { runId });

    const runForCleanup = await readRunState(repoRoot);

    const deleteResults: Record<string, string> = {};
    const deletedIds = new Set<string>();
    const sessionsToDelete = [
      { key: "work", id: runForCleanup.workSessionId },
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
      const result = await deleteSessionBestEffort(ctx, session.id, controlSessionId);
      deleteResults[session.key] = result;
      if (result === "deleted" || result === "not-found") {
        deletedIds.add(session.id);
      }
    }

    await clearSessionCaches(repoRoot);
    await updateRunState(repoRoot, {
      workSessionId: undefined,
      verifierSessionId: undefined,
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

  if (controlSessionId) {
    clearToastStreamChannel(controlSessionId);
  }
  await releaseRunLock(repoRoot);
};
