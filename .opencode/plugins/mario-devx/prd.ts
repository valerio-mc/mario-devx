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

export type PrdJsonV1 = {
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

export type PrdJsonV2 = {
  version: 2;
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

const upgradeV1ToV2 = (v1: PrdJsonV1): PrdJsonV2 => {
  const base = defaultPrdJson();
  const now = nowIso();
  return {
    ...(base as unknown as PrdJsonV2),
    meta: { createdAt: now, updatedAt: now },
    idea: v1.idea ?? "",
    frontend: v1.frontend ?? null,
    stack: v1.stack ?? null,
    qualityGates: Array.isArray(v1.qualityGates) ? v1.qualityGates : [],
    llm: v1.llm?.provider && v1.llm?.model ? v1.llm : base.llm,
    env: v1.env?.keyFile && v1.env?.keyVar ? v1.env : base.env,
    tasks: Array.isArray(v1.tasks) ? v1.tasks : [],
  };
};

const upgradeV2ToV3 = (v2: PrdJsonV2): PrdJson => {
  const base = defaultPrdJson();
  return {
    ...base,
    meta: {
      createdAt: v2.meta?.createdAt?.trim() ? v2.meta.createdAt : base.meta.createdAt,
      updatedAt: base.meta.updatedAt,
    },
    wizard: v2.wizard ?? base.wizard,
    idea: v2.idea ?? base.idea,
    platform: v2.platform ?? base.platform,
    frontend: v2.frontend ?? base.frontend,
    language: v2.language ?? base.language,
    framework: v2.framework ?? base.framework,
    persistence: v2.persistence ?? base.persistence,
    auth: v2.auth ?? base.auth,
    deploy: v2.deploy ?? base.deploy,
    stack: v2.stack ?? base.stack,
    qualityGates: Array.isArray(v2.qualityGates) ? v2.qualityGates : base.qualityGates,
    llm: v2.llm?.provider && v2.llm?.model ? v2.llm : base.llm,
    env: v2.env?.keyFile && v2.env?.keyVar ? v2.env : base.env,
    product: v2.product ?? base.product,
    tasks: Array.isArray(v2.tasks) ? v2.tasks : [],
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
    if (v === 3) {
      const prd = parsed as PrdJson;
      if (!Array.isArray(prd.tasks)) {
        return null;
      }
      return prd;
    }
    if (v === 1) {
      const v2 = upgradeV1ToV2(parsed as PrdJsonV1);
      return upgradeV2ToV3(v2);
    }
    if (v === 2) {
      return upgradeV2ToV3(parsed as PrdJsonV2);
    }
    return null;
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
