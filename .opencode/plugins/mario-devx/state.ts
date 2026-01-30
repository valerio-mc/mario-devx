import path from "path";
import { ensureDir, readTextIfExists, writeText } from "./fs";
import { marioRoot, marioStateDir, marioRunsDir } from "./paths";
import { IterationState, PendingPlan, WorkSessionState } from "./types";
import { seedMarioAssets } from "./assets";

const iterationFile = (repoRoot: string): string =>
  path.join(marioStateDir(repoRoot), "iteration.json");

const pendingPlanFile = (repoRoot: string): string =>
  path.join(marioStateDir(repoRoot), "pending_plan.md");

const pendingMetaFile = (repoRoot: string): string =>
  path.join(marioStateDir(repoRoot), "pending_plan.json");

const workSessionFile = (repoRoot: string): string =>
  path.join(marioStateDir(repoRoot), "work_session.json");

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

export const writePendingPlan = async (
  repoRoot: string,
  pending: PendingPlan,
  content: string,
): Promise<void> => {
  await ensureDir(marioStateDir(repoRoot));
  await writeText(pendingPlanFile(repoRoot), content);
  await writeText(pendingMetaFile(repoRoot), JSON.stringify(pending, null, 2));
};

export const readPendingPlan = async (
  repoRoot: string,
): Promise<{ pending: PendingPlan | null; content: string | null }> => {
  const content = await readTextIfExists(pendingPlanFile(repoRoot));
  const raw = await readTextIfExists(pendingMetaFile(repoRoot));
  if (!content || !raw) {
    return { pending: null, content: null };
  }
  try {
    const pending = JSON.parse(raw) as PendingPlan;
    return { pending, content };
  } catch {
    return { pending: null, content: null };
  }
};

export const clearPendingPlan = async (repoRoot: string): Promise<void> => {
  await writeText(pendingPlanFile(repoRoot), "");
  await writeText(pendingMetaFile(repoRoot), "");
};

export const getPendingPlanPath = (repoRoot: string): string =>
  pendingPlanFile(repoRoot);

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
