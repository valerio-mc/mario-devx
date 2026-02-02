import path from "path";
import { ensureDir, readTextIfExists, writeText } from "./fs";
import { marioStateDir, marioRunsDir } from "./paths";
import { IterationState, RunState, WorkSessionState } from "./types";
import { seedMarioAssets } from "./assets";

const stateFile = (repoRoot: string): string => path.join(marioStateDir(repoRoot), "state.json");

type MarioState = {
  version: 1;
  iteration?: IterationState;
  run?: RunState;
  workSession?: WorkSessionState;
};

const defaultIterationState = (): IterationState => ({
  iteration: 0,
  lastMode: null,
  lastStatus: "NONE",
});

const defaultRunState = (): RunState => ({
  status: "NONE",
  phase: "build",
  updatedAt: new Date().toISOString(),
});

const readState = async (repoRoot: string): Promise<MarioState> => {
  const raw = await readTextIfExists(stateFile(repoRoot));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<MarioState>;
      return {
        version: 1,
        iteration: parsed.iteration,
        run: parsed.run,
        workSession: parsed.workSession,
      };
    } catch {
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
  await ensureDir(marioRunsDir(repoRoot));
};

export const readIterationState = async (repoRoot: string): Promise<IterationState> => {
  const state = await readState(repoRoot);
  return state.iteration ?? defaultIterationState();
};

export const writeIterationState = async (
  repoRoot: string,
  state: IterationState,
): Promise<void> => {
  const current = await readState(repoRoot);
  await writeState(repoRoot, { ...current, iteration: state });
};

export const bumpIteration = async (
  repoRoot: string,
  mode: IterationState["lastMode"],
): Promise<IterationState> => {
  const current = await readIterationState(repoRoot);
  const next = {
    ...current,
    iteration: current.iteration + 1,
    lastMode: mode,
  };
  await writeIterationState(repoRoot, next);
  return next;
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
