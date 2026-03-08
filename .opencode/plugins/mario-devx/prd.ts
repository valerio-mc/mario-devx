import path from "path";
import { ensureDir, readTextIfExists, writeText, writeTextAtomic } from "./fs";

export type PrdTaskStatus = "open" | "in_progress" | "blocked" | "completed" | "cancelled";

export type PrdGateAttempt = {
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
};

export type PrdGateFailure = {
  command: string;
  exitCode: number;
  fingerprint?: string;
  outputExcerpt?: string;
};

export type PrdGatesAttempt = {
  ok: boolean;
  commands: PrdGateAttempt[];
  failure?: PrdGateFailure;
};

export type PrdUiAttempt = {
  ran: boolean;
  ok: boolean | null;
  note?: string;
  failure?: {
    subtype: "NEXT_DEV_LOCK_HELD" | "EADDRINUSE" | "OPEN_CONNECTION_REFUSED" | "UNKNOWN";
    pid?: number;
    lockPath?: string;
    transcript: string[];
    signature?: string;
    repeatCount?: number;
  };
  evidence?: {
    snapshot?: string;
    snapshotInteractive?: string;
    screenshot?: string;
    console?: string;
    errors?: string;
  };
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
    styleReferenceMode: "url" | "screenshot" | "mixed";
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

export type PrdReadErrorCode = "PRD_CORRUPT_JSON" | "PRD_INVALID_SCHEMA" | "PRD_UNSUPPORTED_VERSION";

export class PrdReadError extends Error {
  code: PrdReadErrorCode;
  filePath: string;
  backupPath?: string;
  detectedVersion?: unknown;

  constructor(opts: {
    code: PrdReadErrorCode;
    message: string;
    filePath: string;
    backupPath?: string;
    detectedVersion?: unknown;
  }) {
    super(opts.message);
    this.name = "PrdReadError";
    this.code = opts.code;
    this.filePath = opts.filePath;
    if (opts.backupPath) this.backupPath = opts.backupPath;
    if (Object.prototype.hasOwnProperty.call(opts, "detectedVersion")) {
      this.detectedVersion = opts.detectedVersion;
    }
  }
}

export const isPrdReadError = (error: unknown): error is PrdReadError => {
  return error instanceof PrdReadError;
};

export const formatPrdReadErrorMessage = (error: PrdReadError): string => {
  const lines: string[] = [];
  if (error.code === "PRD_UNSUPPORTED_VERSION") {
    lines.push(`PRD load blocked: unsupported .mario/prd.json version (${String(error.detectedVersion)}).`);
  } else if (error.code === "PRD_CORRUPT_JSON") {
    lines.push("PRD load blocked: .mario/prd.json is corrupt JSON.");
  } else {
    lines.push("PRD load blocked: .mario/prd.json has an invalid schema.");
  }
  if (error.backupPath) {
    lines.push(`Backup saved to: ${error.backupPath}`);
  }
  lines.push("Hard cutover policy: regenerate PRD with /mario-devx:new and re-enter requirements.");
  return lines.join("\n");
};

const backupPrdContents = async (repoRoot: string, suffix: string, raw: string): Promise<string | null> => {
  const rand = Math.random().toString(16).slice(2, 8);
  const backupPath = `${prdJsonPath(repoRoot)}.${suffix}-${new Date().toISOString().replace(/[:.]/g, "")}-${rand}`;
  try {
    await ensureDir(path.dirname(prdJsonPath(repoRoot)));
    await writeText(backupPath, raw);
    return backupPath;
  } catch {
    return null;
  }
};

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
      styleReferenceMode: "mixed",
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
  const filePath = prdJsonPath(repoRoot);
  const raw = await readTextIfExists(prdJsonPath(repoRoot));
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    const backupPath = await backupPrdContents(repoRoot, "corrupt", raw);
    throw new PrdReadError({
      code: "PRD_CORRUPT_JSON",
      message: `PRD file is corrupt JSON: ${filePath}`,
      filePath,
      ...(backupPath ? { backupPath } : {}),
    });
  }

  if (!parsed || typeof parsed !== "object") {
    const backupPath = await backupPrdContents(repoRoot, "invalid-schema", raw);
    throw new PrdReadError({
      code: "PRD_INVALID_SCHEMA",
      message: `PRD file is not a valid object schema: ${filePath}`,
      filePath,
      ...(backupPath ? { backupPath } : {}),
    });
  }

  const v = (parsed as { version?: unknown }).version;
  if (v !== 4) {
    const backupPath = await backupPrdContents(repoRoot, "unsupported-version", raw);
    throw new PrdReadError({
      code: "PRD_UNSUPPORTED_VERSION",
      message: `PRD version is unsupported (expected v4, got ${String(v)}): ${filePath}`,
      filePath,
      ...(backupPath ? { backupPath } : {}),
      detectedVersion: v,
    });
  }

  const prd = parsed as PrdJson;
  if (!Array.isArray(prd.tasks)) {
    const backupPath = await backupPrdContents(repoRoot, "invalid-schema", raw);
    throw new PrdReadError({
      code: "PRD_INVALID_SCHEMA",
      message: `PRD tasks field is not an array: ${filePath}`,
      filePath,
      ...(backupPath ? { backupPath } : {}),
    });
  }

  return prd;
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
  await writeTextAtomic(prdJsonPath(repoRoot), `${JSON.stringify(next, null, 2)}\n`);
};
