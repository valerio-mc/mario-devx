import path from "path";
import { ensureDir, readTextIfExists, writeText } from "./fs";
import { marioStateDir } from "./paths";
import { RunState, WorkSessionState } from "./types";
import { seedMarioAssets } from "./assets";

const stateFile = (repoRoot: string): string => path.join(marioStateDir(repoRoot), "state.json");

type MarioState = {
  version: 1;
  run?: RunState;
  workSession?: WorkSessionState;
};

const defaultRunState = (): RunState => ({
  iteration: 0,
  status: "NONE",
  phase: "run",
  updatedAt: new Date().toISOString(),
});

const readState = async (repoRoot: string): Promise<MarioState> => {
  const raw = await readTextIfExists(stateFile(repoRoot));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<MarioState>;
      return {
        version: 1,
        run: parsed.run,
        workSession: parsed.workSession,
      };
    } catch {
      // Back up the corrupt state file and reset.
      const backupPath = `${stateFile(repoRoot)}.corrupt-${new Date().toISOString().replace(/[:.]/g, "")}`;
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
};

export const readWorkSessionState = async (repoRoot: string): Promise<WorkSessionState | null> => {
  const state = await readState(repoRoot);
  const ws = state.workSession;
  if (!ws?.sessionId || !ws.baselineMessageId) {
    return null;
  }
  return ws;
};

export const writeWorkSessionState = async (
  repoRoot: string,
  state: WorkSessionState,
): Promise<void> => {
  const current = await readState(repoRoot);
  await writeState(repoRoot, { ...current, workSession: state });
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
