import path from "path";
import { readTextIfExists, writeText } from "./fs";

export type PrdTaskStatus = "open" | "in_progress" | "blocked" | "completed" | "cancelled";

export type PrdTask = {
  id: string;
  status: PrdTaskStatus;
  title: string;
  scope: string[];
  doneWhen: string[];
  evidence: string[];
  notes?: string[];
  rollback?: string[];
};

export type PrdJson = {
  version: 1;
  idea: string;
  frontend: boolean | null;
  stack: string | null;
  qualityGates: string[];
  llm: {
    provider: string;
    model: string;
  };
  env: {
    keyFile: string;
    keyVar: string;
  };
  tasks: PrdTask[];
};

export const prdJsonPath = (repoRoot: string): string => path.join(repoRoot, ".mario", "prd.json");

export const readPrdJsonIfExists = async (repoRoot: string): Promise<PrdJson | null> => {
  const raw = await readTextIfExists(prdJsonPath(repoRoot));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as PrdJson;
    if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const writePrdJson = async (repoRoot: string, prd: PrdJson): Promise<void> => {
  await writeText(prdJsonPath(repoRoot), `${JSON.stringify(prd, null, 2)}\n`);
};
