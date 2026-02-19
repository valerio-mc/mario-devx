import path from "path";
import { ensureDir, fileExists, readTextIfExists, writeText } from "./fs";
import { marioStateDir } from "./paths";
import { RunState, UiVerifyState } from "./types";
import { seedMarioAssets } from "./assets";

const stateFile = (repoRoot: string): string => path.join(marioStateDir(repoRoot), "state.json");

type MarioState = {
  version: 1;
  run?: RunState;
  uiVerify?: UiVerifyState;
};

type LegacySessionCache = {
  sessionId?: unknown;
  baselineMessageId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

type RawMarioState = Partial<MarioState> & {
  workSession?: LegacySessionCache;
  verifierSession?: LegacySessionCache;
};

const logFile = (repoRoot: string): string => path.join(marioStateDir(repoRoot), "mario-devx.log");

const defaultRunState = (): RunState => ({
  iteration: 0,
  status: "NONE",
  phase: "run",
  updatedAt: new Date().toISOString(),
});

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
};

const readLegacySessionRun = (value: unknown): RunState | undefined => {
  const cache = asRecord(value) as LegacySessionCache | null;
  if (!cache || typeof cache.sessionId !== "string" || cache.sessionId.length === 0) {
    return undefined;
  }
  return {
    ...defaultRunState(),
    status: "BLOCKED",
    workSessionId: cache.sessionId,
    ...(typeof cache.baselineMessageId === "string" && cache.baselineMessageId.length > 0 ? { baselineMessageId: cache.baselineMessageId } : {}),
    ...(typeof cache.createdAt === "string" && cache.createdAt.length > 0 ? { startedAt: cache.createdAt } : {}),
    updatedAt: typeof cache.updatedAt === "string" && cache.updatedAt.length > 0 ? cache.updatedAt : new Date().toISOString(),
  };
};

const sanitizeState = (parsed: RawMarioState): MarioState => {
  const next: MarioState = { version: 1 };

  if (parsed.run && typeof parsed.run === "object") {
    next.run = parsed.run as RunState;
  } else {
    const migratedRun = readLegacySessionRun(parsed.workSession);
    if (migratedRun) {
      next.run = migratedRun;
    }
  }

  if (parsed.uiVerify && typeof parsed.uiVerify === "object") {
    next.uiVerify = parsed.uiVerify as UiVerifyState;
  }

  return next;
};

const readState = async (repoRoot: string): Promise<MarioState> => {
  const raw = await readTextIfExists(stateFile(repoRoot));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as RawMarioState;
      const next = sanitizeState(parsed);
      const normalized = JSON.stringify(next, null, 2);
      if (normalized !== JSON.stringify(parsed, null, 2)) {
        await writeText(stateFile(repoRoot), `${normalized}\n`);
      }
      return next;
    } catch {
      // Back up the corrupt state file and reset.
      const rand = Math.random().toString(16).slice(2, 8);
      const backupPath = `${stateFile(repoRoot)}.corrupt-${new Date().toISOString().replace(/[:.]/g, "")}-${rand}`;
      try {
        await ensureDir(marioStateDir(repoRoot));
        await writeText(backupPath, raw);
        await writeText(stateFile(repoRoot), JSON.stringify({ version: 1 }, null, 2));
      } catch {
        // Best-effort only.
      }
      return { version: 1 };
    }
  }

  return { version: 1 };
};

const writeState = async (repoRoot: string, next: MarioState): Promise<void> => {
  await ensureDir(marioStateDir(repoRoot));
  await writeText(stateFile(repoRoot), JSON.stringify({ ...next, version: 1 }, null, 2));
};

export const ensureMario = async (repoRoot: string, force = false): Promise<void> => {
  await seedMarioAssets(repoRoot, force);
  await ensureDir(marioStateDir(repoRoot));
  if (!(await fileExists(stateFile(repoRoot)))) {
    await writeState(repoRoot, {
      version: 1,
      run: defaultRunState(),
    });
  } else {
    const current = await readState(repoRoot);
    if (!current.run) {
      await writeState(repoRoot, {
        ...current,
        run: defaultRunState(),
      });
    }
  }
  if (!(await fileExists(logFile(repoRoot)))) {
    await writeText(logFile(repoRoot), "");
  }
};

export const clearSessionCaches = async (repoRoot: string): Promise<void> => {
  const current = await readState(repoRoot);
  const copy = { ...current } as Record<string, unknown>;
  delete copy.workSession;
  delete copy.verifierSession;
  await writeState(repoRoot, copy as MarioState);
};

export const readRunState = async (repoRoot: string): Promise<RunState> => {
  const state = await readState(repoRoot);
  return state.run ?? defaultRunState();
};

export const writeRunState = async (repoRoot: string, state: RunState): Promise<void> => {
  const current = await readState(repoRoot);
  await writeState(repoRoot, { ...current, run: state });
};

export const bumpIteration = async (repoRoot: string): Promise<RunState> => {
  const run = await readRunState(repoRoot);
  const next: RunState = {
    ...run,
    iteration: (run.iteration ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  await writeRunState(repoRoot, next);
  return next;
};

export const readUiVerifyState = async (repoRoot: string): Promise<UiVerifyState> => {
  const state = await readState(repoRoot);
  return state.uiVerify ?? {};
};

export const writeUiVerifyState = async (repoRoot: string, patch: Partial<UiVerifyState>): Promise<void> => {
  const current = await readState(repoRoot);
  const next: UiVerifyState = {
    ...(current.uiVerify ?? {}),
    ...patch,
  };
  await writeState(repoRoot, { ...current, uiVerify: next });
};
