import path from "path";
import { readTextIfExists, writeText } from "./fs";

export type PrdTaskStatus = "open" | "in_progress" | "blocked" | "completed" | "cancelled";

export type PrdGateAttempt = {
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
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
  parentId?: string;
  dependsOn?: string[];
  labels?: string[];
  acceptance?: string[];
  doneWhen: string[];
  evidence: string[];
  lastAttempt?: PrdTaskAttempt;
  notes?: string[];
};

export type PrdBacklogItem = {
  id: string;
  title: string;
  request: string;
  createdAt: string;
  status: "open" | "planned" | "implemented";
  taskIds: string[];
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
  version: 4;
  meta: {
    createdAt: string;
    updatedAt: string;
  };
  wizard: PrdWizard;
  idea: string;
  platform: "web" | "api" | "cli" | "library" | null;
  frontend: boolean | null;
  uiVerificationRequired: boolean | null;
  language: "typescript" | "python" | "go" | "rust" | "other" | null;
  framework: string | null;
  qualityGates: string[];
  planning: {
    decompositionStrategy: string;
    granularityRules: string[];
    stopWhen: string[];
  };
  verificationPolicy: {
    globalGates: string[];
    taskGates: Record<string, string[]>;
    uiPolicy: "required" | "best_effort" | "off";
  };
  ui: {
    designSystem: "none" | "tailwind" | "shadcn" | "custom" | null;
    styleReferences: string[];
    visualDirection: string;
    uxRequirements: string[];
  };
  docs: {
    readmeRequired: boolean;
    readmeSections: string[];
  };
  backlog: {
    featureRequests: PrdBacklogItem[];
  };
  product: {
    targetUsers: string[];
    userProblems: string[];
    mustHaveFeatures: string[];
    nonGoals: string[];
    successMetrics: string[];
    constraints: string[];
  };
  tasks: PrdTask[];
};

export const prdJsonPath = (repoRoot: string): string => path.join(repoRoot, ".mario", "prd.json");

const defaultWizard = (): PrdWizard => ({
  status: "in_progress",
  step: 0,
  totalSteps: 17,
  lastQuestionId: null,
  answers: {},
});

export const defaultPrdJson = (): PrdJson => {
  const now = new Date().toISOString();
  return {
    version: 4,
    meta: { createdAt: now, updatedAt: now },
    wizard: defaultWizard(),
    idea: "",
    platform: null,
    frontend: null,
    uiVerificationRequired: null,
    language: null,
    framework: null,
    qualityGates: [],
    planning: {
      decompositionStrategy: "Split features into smallest independently verifiable tasks.",
      granularityRules: [
        "Each task should fit in one focused iteration.",
        "Each task must include explicit acceptance criteria.",
      ],
      stopWhen: [
        "All must-have features are mapped to tasks.",
        "All tasks have deterministic verification.",
      ],
    },
    verificationPolicy: {
      globalGates: [],
      taskGates: {},
      uiPolicy: "best_effort",
    },
    ui: {
      designSystem: null,
      styleReferences: [],
      visualDirection: "",
      uxRequirements: [],
    },
    docs: {
      readmeRequired: true,
      readmeSections: [
        "Overview",
        "Tech Stack",
        "Setup",
        "Environment Variables",
        "Scripts",
        "Usage",
      ],
    },
    backlog: {
      featureRequests: [],
    },
    product: {
      targetUsers: [],
      userProblems: [],
      mustHaveFeatures: [],
      nonGoals: [],
      successMetrics: [],
      constraints: [],
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
    if (v !== 3 && v !== 4) {
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
    version: 4,
    meta: {
      createdAt: prd.meta?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
  await writeText(prdJsonPath(repoRoot), `${JSON.stringify(next, null, 2)}\n`);
};
