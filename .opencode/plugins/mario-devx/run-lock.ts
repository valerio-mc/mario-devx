import { mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { TIMEOUTS } from "./config";
import { logError } from "./errors";
import { writeTextAtomic } from "./fs";
import { pidLooksAlive } from "./process";
import { readRunState } from "./state";

const nowIso = (): string => new Date().toISOString();

type ParsedRunLock = {
  at?: unknown;
  heartbeatAt?: unknown;
  pid?: unknown;
  controlSessionId?: unknown;
  runId?: unknown;
};

const parseIsoMs = (value: unknown): number | null => {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
};

const lockReferenceMs = (parsed: ParsedRunLock): number | null => {
  const heartbeatMs = parseIsoMs(parsed.heartbeatAt);
  if (heartbeatMs !== null) return heartbeatMs;
  return parseIsoMs(parsed.at);
};

export const runLockPath = (repoRoot: string): string => path.join(repoRoot, ".mario", "state", "run.lock");

export const acquireRunLock = async (
  repoRoot: string,
  runId: string,
  controlSessionId: string | undefined,
  onEvent?: (event: { type: "stale-lock-removed"; lockPath: string; reason: string; stalePid?: number }) => Promise<void>,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const lockPath = runLockPath(repoRoot);
  await mkdir(path.dirname(lockPath), { recursive: true });

  const staleAfterMs = TIMEOUTS.STALE_LOCK_TIMEOUT_MS;
  try {
    const lockStat = await stat(lockPath);
    const existing = await readFile(lockPath, "utf8");
    const lockIsOld = Date.now() - lockStat.mtimeMs > staleAfterMs;

    let parsed: ParsedRunLock | null = null;
    try {
      parsed = JSON.parse(existing) as ParsedRunLock;
    } catch {
      parsed = null;
    }

    const runState = await readRunState(repoRoot);
    const stateUpdatedMs = parseIsoMs(runState.updatedAt);

    if (parsed) {
      const refMs = lockReferenceMs(parsed);
      const staleByState = (
        runState.status !== "DOING"
        && stateUpdatedMs !== null
        && refMs !== null
        && stateUpdatedMs >= refMs
      );
      const staleByRunIdMismatch = (
        runState.status === "DOING"
        && typeof runState.runId === "string"
        && runState.runId.length > 0
        && typeof parsed.runId === "string"
        && parsed.runId.length > 0
        && runState.runId !== parsed.runId
      );
      const staleByDeadPid = (
        typeof parsed.pid === "number"
        && Number.isFinite(parsed.pid)
        && pidLooksAlive(parsed.pid) === false
      );

      if (staleByState || staleByRunIdMismatch || staleByDeadPid) {
        await unlink(lockPath);
        await onEvent?.({
          type: "stale-lock-removed",
          lockPath,
          reason: staleByRunIdMismatch
            ? "run-id-mismatch"
            : staleByState
              ? "state-not-doing-updated-after-lock"
              : "dead-pid",
          ...(typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? { stalePid: parsed.pid } : {}),
        });
      } else if (lockIsOld && (refMs === null || stateUpdatedMs === null)) {
        await unlink(lockPath);
        await onEvent?.({
          type: "stale-lock-removed",
          lockPath,
          reason: "fallback-old-malformed-lock",
          ...(typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? { stalePid: parsed.pid } : {}),
        });
      } else {
        return {
          ok: false,
          message: `Another mario-devx run appears to be in progress (lock: ${lockPath}).\n${existing.trim()}`,
        };
      }
    } else if (lockIsOld) {
      await unlink(lockPath);
      await onEvent?.({
        type: "stale-lock-removed",
        lockPath,
        reason: "fallback-old-unparseable-lock",
      });
    } else {
      return {
        ok: false,
        message: `Another mario-devx run appears to be in progress (lock: ${lockPath}).\n${existing.trim()}`,
      };
    }
  } catch {
    // No lock.
  }

  const payload = {
    at: nowIso(),
    pid: process.pid,
    controlSessionId: controlSessionId ?? null,
    runId,
  };
  try {
    await writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch {
    const existing = await readFile(lockPath, "utf8").catch(() => "");
    return {
      ok: false,
      message: `Another mario-devx run appears to be in progress (lock: ${lockPath}).\n${existing.trim()}`,
    };
  }
  return { ok: true };
};

export const heartbeatRunLock = async (repoRoot: string, runId: string): Promise<boolean> => {
  const lockPath = runLockPath(repoRoot);
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number; runId?: string; heartbeatAt?: string };
    if (parsed.runId !== runId) {
      logError("heartbeat", `Lock belongs to run ${String(parsed.runId)}, current run is ${runId}`);
      return false;
    }
    if (parsed.pid !== process.pid) {
      logError("heartbeat", `Lock belongs to pid ${parsed.pid}, current pid is ${process.pid}`);
      return false;
    }
    const next = { ...parsed, heartbeatAt: nowIso() };
    await writeTextAtomic(lockPath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch (err) {
    logError("heartbeat", `Update failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
};

export const releaseRunLock = async (repoRoot: string, runId: string): Promise<void> => {
  const lockPath = runLockPath(repoRoot);
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { runId?: string };
    if (parsed.runId !== runId) {
      logError("release", `Skip lock release for run ${runId}; lock belongs to ${String(parsed.runId)}`);
      return;
    }
    await unlink(lockPath);
  } catch {
    // Best-effort only.
  }
};
