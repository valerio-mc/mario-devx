import path from "path";
import { ensureDir, readTextIfExists, writeText } from "./fs";
import { marioRoot, marioStateDir, marioRunsDir } from "./paths";
import { IterationState, RunState, WorkSessionState } from "./types";
import { seedMarioAssets } from "./assets";

const iterationFile = (repoRoot: string): string =>
  path.join(marioStateDir(repoRoot), "iteration.json");

const workSessionFile = (repoRoot: string): string =>
  path.join(marioStateDir(repoRoot), "work_session.json");

const runStateFile = (repoRoot: string): string =>
  path.join(marioStateDir(repoRoot), "run.json");

export const ensureMario = async (repoRoot: string, force = false): Promise<void> => {
  await seedMarioAssets(repoRoot, force);
  await ensureDir(marioRunsDir(repoRoot));
};

export const readIterationState = async (repoRoot: string): Promise<IterationState> => {
  const raw = await readTextIfExists(iterationFile(repoRoot));
  if (!raw) {
    return { iteration: 0, lastMode: null, lastStatus: "NONE" };
  }
  try {
    return JSON.parse(raw) as IterationState;
  } catch {
    return { iteration: 0, lastMode: null, lastStatus: "NONE" };
  }
};

export const writeIterationState = async (
  repoRoot: string,
  state: IterationState,
): Promise<void> => {
  await ensureDir(marioStateDir(repoRoot));
  await writeText(iterationFile(repoRoot), JSON.stringify(state, null, 2));
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
  const raw = await readTextIfExists(workSessionFile(repoRoot));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as WorkSessionState;
    if (!parsed.sessionId || !parsed.baselineMessageId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const writeWorkSessionState = async (
  repoRoot: string,
  state: WorkSessionState,
): Promise<void> => {
  await ensureDir(marioStateDir(repoRoot));
  await writeText(workSessionFile(repoRoot), JSON.stringify(state, null, 2));
};

export const readRunState = async (repoRoot: string): Promise<RunState> => {
  const raw = await readTextIfExists(runStateFile(repoRoot));
  if (!raw) {
    return { status: "NONE", phase: "build", updatedAt: new Date().toISOString() };
  }
  try {
    return JSON.parse(raw) as RunState;
  } catch {
    return { status: "NONE", phase: "build", updatedAt: new Date().toISOString() };
  }
};

export const writeRunState = async (repoRoot: string, state: RunState): Promise<void> => {
  await ensureDir(marioStateDir(repoRoot));
  await writeText(runStateFile(repoRoot), JSON.stringify(state, null, 2));
};
