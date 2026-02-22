import { mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { TIMEOUTS } from "./config";
import { logError } from "./errors";
import { writeTextAtomic } from "./fs";
import { pidLooksAlive } from "./process";

const nowIso = (): string => new Date().toISOString();
const LEGACY_LOCK_STALE_MS = 2 * 60 * 1000;

type ParsedRunLock = {
  pid?: unknown;
  i?: unknown;
  t?: unknown;
};

const legacyLockTimestampMs = (parsed: ParsedRunLock): number | null => {
  const hasLegacyCounters = typeof parsed.i === "number" && Number.isFinite(parsed.i);
  const hasLegacyTime = typeof parsed.t === "number" && Number.isFinite(parsed.t);
  const hasPid = typeof parsed.pid === "number" && Number.isFinite(parsed.pid);
  if (hasPid || !hasLegacyCounters || !hasLegacyTime) return null;
  return parsed.t as number;
};

export const runLockPath = (repoRoot: string): string => path.join(repoRoot, ".mario", "state", "run.lock");

export const acquireRunLock = async (
  repoRoot: string,
  controlSessionId: string | undefined,
  onEvent?: (event: { type: "stale-pid-removed"; lockPath: string; stalePid: number }) => Promise<void>,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const lockPath = runLockPath(repoRoot);
  await mkdir(path.dirname(lockPath), { recursive: true });

  const staleAfterMs = TIMEOUTS.STALE_LOCK_TIMEOUT_MS;
  try {
    const s = await stat(lockPath);
    const existing = await readFile(lockPath, "utf8");
    const lockIsOld = Date.now() - s.mtimeMs > staleAfterMs;
    try {
      const parsed = JSON.parse(existing) as ParsedRunLock;
      const legacyTs = legacyLockTimestampMs(parsed);
      if (legacyTs !== null) {
        const legacyAgeMs = Math.max(0, Date.now() - legacyTs);
        const staleByTimestamp = legacyAgeMs >= LEGACY_LOCK_STALE_MS;
        const staleByMtime = Date.now() - s.mtimeMs > staleAfterMs;
        if (staleByTimestamp || staleByMtime) {
          await unlink(lockPath);
        } else {
          // Legacy lock shape has no pid ownership info; self-heal immediately.
          await unlink(lockPath);
        }
        // Proceed to acquire a modern lock below.
      } else {
      const alive = pidLooksAlive(parsed.pid);
      if (alive === false || (lockIsOld && alive !== true)) {
        if (typeof parsed.pid === "number") {
          await onEvent?.({
            type: "stale-pid-removed",
            lockPath,
            stalePid: parsed.pid,
          });
        }
        await unlink(lockPath);
      } else {
        return {
          ok: false,
          message: `Another mario-devx run appears to be in progress (lock: ${lockPath}).\n${existing.trim()}`,
        };
      }
      }
    } catch {
      try {
        await unlink(lockPath);
      } catch {
        return {
          ok: false,
          message: `Another mario-devx run appears to be in progress (lock: ${lockPath}).\n${existing.trim()}`,
        };
      }
    }
  } catch {
    // No lock.
  }

  const payload = {
    at: nowIso(),
    pid: process.pid,
    controlSessionId: controlSessionId ?? null,
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

export const heartbeatRunLock = async (repoRoot: string): Promise<boolean> => {
  const lockPath = runLockPath(repoRoot);
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number; heartbeatAt?: string };
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

export const releaseRunLock = async (repoRoot: string): Promise<void> => {
  const lockPath = runLockPath(repoRoot);
  try {
    await unlink(lockPath);
  } catch {
    // Best-effort only.
  }
};
