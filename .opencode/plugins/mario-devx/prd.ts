import path from "path";
import { readTextIfExists, writeText } from "./fs";

export type PrdTaskStatus = "open" | "in_progress" | "blocked" | "completed" | "cancelled";

export type PrdGateAttempt = {
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  outputTail?: string;
};

export type PrdGatesAttempt = {
  ok: boolean;
  commands: PrdGateAttempt[];
};

export type PrdUiAttempt = {
  ran: boolean;
  ok: boolean | null;
  note?: string;
};

export type PrdJudgeAttempt = {
  status: "PASS" | "FAIL";
  exitSignal: boolean;
  reason: string[];
  nextActions: string[];
  rawText?: string;
};

export type PrdTaskAttempt = {
  at: string;
  iteration: number;
  gates: PrdGatesAttempt;
  ui: PrdUiAttempt;
  judge: PrdJudgeAttempt;
};

export type PrdTask = {
  id: string;
  status: PrdTaskStatus;
  title: string;
  scope: string[];
  doneWhen: string[];
  evidence: string[];
  lastAttempt?: PrdTaskAttempt;
  notes?: string[];
  rollback?: string[];
};

export type PrdWizardStatus = "in_progress" | "completed";

export type PrdWizard = {
  status: PrdWizardStatus;
  step: number;
  totalSteps: number;
  lastQuestionId: string | null;
  answers: Record<string, string>;
};

export type PrdJson = {
  version: 3;
  meta: {
    createdAt: string;
    updatedAt: string;
  };
  wizard: PrdWizard;
  idea: string;
  platform: "web" | "api" | "cli" | "library" | null;
  frontend: boolean | null;
  language: "typescript" | "python" | "go" | "rust" | "other" | null;
  framework: string | null;
  persistence: "none" | "sqlite" | "postgres" | "supabase" | "other" | null;
  auth: "none" | "password" | "oauth" | "magic_link" | "other" | null;
  deploy: "local" | "vercel" | "docker" | "fly" | "other" | null;
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
  product: {
    users: string;
    problem: string;
    mustHaveFeatures: string[];
  };
  tasks: PrdTask[];
};

export const prdJsonPath = (repoRoot: string): string => path.join(repoRoot, ".mario", "prd.json");

const nowIso = (): string => new Date().toISOString();

const defaultWizard = (): PrdWizard => ({
  status: "in_progress",
  step: 0,
  totalSteps: 12,
  lastQuestionId: null,
  answers: {},
});

export const defaultPrdJson = (): PrdJson => {
  const now = nowIso();
  return {
    version: 3,
    meta: { createdAt: now, updatedAt: now },
    wizard: defaultWizard(),
    idea: "",
    platform: null,
    frontend: null,
    language: null,
    framework: null,
    persistence: null,
    auth: null,
    deploy: null,
    stack: null,
    qualityGates: [],
    llm: { provider: "", model: "" },
    env: { keyFile: "", keyVar: "" },
    product: {
      users: "",
      problem: "",
      mustHaveFeatures: [],
    },
    tasks: [],
  };
};

export const readPrdJsonIfExists = async (repoRoot: string): Promise<PrdJson | null> => {
  const raw = await readTextIfExists(prdJsonPath(repoRoot));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const v = (parsed as { version?: unknown }).version;
    if (v !== 3) {
      return null;
    }
    const prd = parsed as PrdJson;
    if (!Array.isArray(prd.tasks)) {
      return null;
    }
    return prd;
  } catch {
    return null;
  }
};

export const writePrdJson = async (repoRoot: string, prd: PrdJson): Promise<void> => {
  const next: PrdJson = {
    ...prd,
    version: 3,
    meta: {
      createdAt: prd.meta?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    },
  };
  await writeText(prdJsonPath(repoRoot), `${JSON.stringify(next, null, 2)}\n`);
};
