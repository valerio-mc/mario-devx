import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { readTextIfExists, writeText } from "./fs";
import { buildPrompt } from "./prompt";
import { ensureMario, bumpIteration, readWorkSessionState, readRunState, writeRunState } from "./state";
import { FeatureAddInterviewState } from "./types";
import { getRepoRoot } from "./paths";
import {
  ensureT0002QualityBootstrap,
  extractScriptFromCommand,
  hasNodeModules,
  missingPackageScriptForCommand,
  resolveNodeWorkspaceRoot,
  runGateCommands,
} from "./gates";
import {
  ensureAgentBrowserPrereqs,
  hasAgentBrowserCli,
  hasAgentBrowserSkill,
  hasAgentsKey,
  isLikelyWebApp,
  parseAgentsEnv,
  runUiVerification,
  upsertAgentsKey,
} from "./ui-verify";
import {
  LAST_QUESTION_KEY,
  MIN_FEATURES,
  MIN_QUALITY_GATES,
  WIZARD_TOTAL_STEPS,
  compactIdea,
  deriveWizardStep,
  escapeDoubleQuoted,
  extractStyleReferencesFromText,
  fallbackQuestion,
  firstMissingField,
  hasMeaningfulList,
  hasNonEmpty,
  isLikelyBooleanReply,
  isPrdComplete,
  looksLikeUiChoiceArtifact,
  looksTooBroadQuestion,
  mergeStyleReferences,
  normalizeStyleReferences,
  normalizeTextArray,
  sameQuestion,
  stripTrailingSentencePunctuation,
} from "./interview";
import {
  decomposeFeatureRequestToTasks,
  firstScaffoldHintFromNotes,
  getNextPrdTask,
  isScaffoldMissingGateCommand,
  makeTask,
  nextBacklogId,
  nextTaskOrdinal,
  normalizeMustHaveFeatureAtoms,
  normalizeTaskId,
  readmeSectionGate,
  scaffoldPlanFromPrd,
  setPrdTaskLastAttempt,
  setPrdTaskStatus,
} from "./planner";
import {
  ensureWorkSession,
  ensureNotInWorkSession,
  extractTextFromPromptResponse,
  resetWorkSession,
  setWorkSessionTitle,
  updateRunState,
  waitForSessionIdle,
} from "./runner";
import { runDoctor } from "./doctor";
import {
  defaultPrdJson,
  readPrdJsonIfExists,
  writePrdJson,
  type PrdGatesAttempt,
  type PrdJudgeAttempt,
  type PrdJson,
  type PrdTask,
  type PrdTaskAttempt,
  type PrdTaskStatus,
  type PrdUiAttempt,
} from "./prd";

type ToolContext = {
  sessionID?: string;
  agent?: string;
};

type PluginContext = Parameters<Plugin>[0];

const nowIso = (): string => new Date().toISOString();
const MAX_TASK_REPAIR_MS = 25 * 60 * 1000;
const MAX_NO_PROGRESS_STREAK = 3;
const RUN_DUPLICATE_WINDOW_MS = 8000;

const runLockPath = (repoRoot: string): string => path.join(repoRoot, ".mario", "state", "run.lock");

const pidLooksAlive = (pid: unknown): boolean | null => {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ESRCH") {
      return false;
    }
    return null;
  }
};

const acquireRunLock = async (
  repoRoot: string,
  controlSessionId: string | undefined,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const lockPath = runLockPath(repoRoot);
  await mkdir(path.dirname(lockPath), { recursive: true });

  const staleAfterMs = 12 * 60 * 60 * 1000;
  try {
    const s = await stat(lockPath);
    if (Date.now() - s.mtimeMs > staleAfterMs) {
      await unlink(lockPath);
    } else {
      const existing = await readFile(lockPath, "utf8");
      try {
        const parsed = JSON.parse(existing) as { pid?: unknown };
        const alive = pidLooksAlive(parsed.pid);
        if (alive === false) {
          await unlink(lockPath);
        } else {
          return {
            ok: false,
            message: `Another mario-devx run appears to be in progress (lock: ${lockPath}).\n${existing.trim()}`,
          };
        }
      } catch {
        // Corrupt lock file; treat as stale.
        try {
          await unlink(lockPath);
        } catch {
          return {
            ok: false,
            message: `Another mario-devx run appears to be in progress (lock: ${lockPath}).\n${existing.trim()}`,
          };
        }
      }
    }
  } catch {
    // No lock.
  }

  const payload = {
    at: nowIso(),
    pid: process.pid,
    controlSessionId: controlSessionId ?? null,
  };
  try {
    await writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch {
    const existing = await readFile(lockPath, "utf8").catch(() => "");
    return {
      ok: false,
      message: `Another mario-devx run appears to be in progress (lock: ${lockPath}).\n${existing.trim()}`,
    };
  }
  return { ok: true };
};

const heartbeatRunLock = async (repoRoot: string): Promise<boolean> => {
  const lockPath = runLockPath(repoRoot);
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next = { ...parsed, heartbeatAt: nowIso() };
    await writeFile(lockPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
    return true;
  } catch {
    // Best-effort only.
    return false;
  }
};

const releaseRunLock = async (repoRoot: string): Promise<void> => {
  const lockPath = runLockPath(repoRoot);
  try {
    await unlink(lockPath);
  } catch {
    // Best-effort only.
  }
};

const ensurePrd = async (repoRoot: string): Promise<PrdJson> => {
  const existing = await readPrdJsonIfExists(repoRoot);
  if (existing) {
    const createdAt = existing.meta?.createdAt?.trim() ? existing.meta.createdAt : nowIso();
    const repaired: PrdJson = {
      ...existing,
      meta: { ...existing.meta, createdAt },
      wizard: {
        ...existing.wizard,
        totalSteps: Math.max(existing.wizard?.totalSteps ?? 0, 17),
      },
      version: 4,
      uiVerificationRequired: typeof existing.uiVerificationRequired === "boolean" ? existing.uiVerificationRequired : null,
      planning: {
        decompositionStrategy: hasNonEmpty(existing.planning?.decompositionStrategy)
          ? existing.planning.decompositionStrategy
          : "Split features into smallest independently verifiable tasks.",
        granularityRules: Array.isArray(existing.planning?.granularityRules)
          ? existing.planning.granularityRules
          : ["Each task should fit in one focused iteration.", "Each task must include explicit acceptance criteria."],
        stopWhen: Array.isArray(existing.planning?.stopWhen)
          ? existing.planning.stopWhen
          : ["All must-have features are mapped to tasks.", "All tasks have deterministic verification."],
      },
      verificationPolicy: {
        globalGates: Array.isArray(existing.verificationPolicy?.globalGates)
          ? existing.verificationPolicy.globalGates
          : (Array.isArray(existing.qualityGates) ? existing.qualityGates : []),
        taskGates: (existing.verificationPolicy?.taskGates && typeof existing.verificationPolicy.taskGates === "object")
          ? existing.verificationPolicy.taskGates
          : {},
        uiPolicy: existing.verificationPolicy?.uiPolicy === "required"
          ? "required"
          : existing.verificationPolicy?.uiPolicy === "off"
            ? "off"
            : "best_effort",
      },
      ui: {
        designSystem: existing.ui?.designSystem ?? null,
        styleReferenceMode: existing.ui?.styleReferenceMode === "url"
          ? "url"
          : existing.ui?.styleReferenceMode === "screenshot"
            ? "screenshot"
            : "mixed",
        styleReferences: Array.isArray(existing.ui?.styleReferences) ? existing.ui.styleReferences : [],
        visualDirection: typeof existing.ui?.visualDirection === "string" ? existing.ui.visualDirection : "",
        uxRequirements: Array.isArray(existing.ui?.uxRequirements) ? existing.ui.uxRequirements : [],
      },
      docs: {
        readmeRequired: typeof existing.docs?.readmeRequired === "boolean" ? existing.docs.readmeRequired : true,
        readmeSections: Array.isArray(existing.docs?.readmeSections)
          ? existing.docs.readmeSections
          : ["Overview", "Tech Stack", "Setup", "Environment Variables", "Scripts", "Usage"],
      },
      backlog: {
        featureRequests: Array.isArray(existing.backlog?.featureRequests) ? existing.backlog.featureRequests : [],
      },
      tasks: Array.isArray(existing.tasks)
        ? existing.tasks.map((task) => ({
            ...task,
            notes: Array.isArray(task.notes)
              ? task.notes.map((note) => note.replaceAll("__tmp_next", "tmp-next").replaceAll("__tmp_vite", "tmp-vite"))
              : task.notes,
          }))
        : [],
      product: {
        targetUsers: Array.isArray(existing.product?.targetUsers) ? existing.product.targetUsers : [],
        userProblems: Array.isArray(existing.product?.userProblems) ? existing.product.userProblems : [],
        mustHaveFeatures: Array.isArray(existing.product?.mustHaveFeatures) ? existing.product.mustHaveFeatures : [],
        nonGoals: Array.isArray(existing.product?.nonGoals) ? existing.product.nonGoals : [],
        successMetrics: Array.isArray(existing.product?.successMetrics) ? existing.product.successMetrics : [],
        constraints: Array.isArray(existing.product?.constraints) ? existing.product.constraints : [],
      },
    };
    if (JSON.stringify(repaired) !== JSON.stringify(existing)) {
      await writePrdJson(repoRoot, repaired);
      return repaired;
    }
    return existing;
  }
  const created = defaultPrdJson();
  await writePrdJson(repoRoot, created);
  return created;
};

type InterviewUpdates = {
  idea?: string;
  platform?: "web" | "api" | "cli" | "library";
  frontend?: boolean;
  uiVerificationRequired?: boolean;
  uiDesignSystem?: "none" | "tailwind" | "shadcn" | "custom";
  uiStyleReferenceMode?: "url" | "screenshot" | "mixed";
  uiStyleReferences?: string[];
  uiVisualDirection?: string;
  uiUxRequirements?: string[];
  docsReadmeRequired?: boolean;
  docsReadmeSections?: string[];
  language?: "typescript" | "python" | "go" | "rust" | "other";
  framework?: string | null;
  targetUsers?: string[];
  userProblems?: string[];
  qualityGates?: string[];
  mustHaveFeatures?: string[];
  nonGoals?: string[];
  successMetrics?: string[];
  constraints?: string[];
};

type InterviewEnvelope = {
  done: boolean;
  updates?: InterviewUpdates;
  next_question?: string;
};

const seedTasksFromPrd = async (repoRoot: string, prd: PrdJson): Promise<PrdJson> => {
  if (Array.isArray(prd.tasks) && prd.tasks.length > 0) {
    return prd;
  }
  const bootstrapPlan = await scaffoldPlanFromPrd(repoRoot, prd);
  const doneWhen = prd.qualityGates ?? [];

  const toAtomicFeatureTasks = (feature: string): string[] => {
    const compact = feature.replace(/\s+/g, " ").trim();
    if (!compact) return [];
    return [compact];
  };

  const tasks: PrdTask[] = [];
  let n = 1;
  const scaffoldId = normalizeTaskId(n++);
  tasks.push(
    makeTask({
      id: scaffoldId,
      title: prd.idea.trim() ? `Scaffold project baseline: ${compactIdea(prd.idea)}` : "Scaffold project baseline",
      doneWhen: bootstrapPlan.doneWhen,
      notes: bootstrapPlan.notes,
      labels: ["scaffold", "foundation"],
      acceptance: ["Project skeleton exists and can be iterated on safely."],
    }),
  );
  if (doneWhen.length > 0) {
    const qualitySetupId = normalizeTaskId(n++);
    tasks.push(
      makeTask({
        id: qualitySetupId,
        title: "Setup quality pipeline so configured gates are runnable",
        doneWhen,
        dependsOn: [scaffoldId],
        labels: ["quality", "foundation"],
        acceptance: ["All declared quality gates execute successfully in this repository."],
        notes: [
          "Implement project-specific verification setup so declared quality gates run successfully.",
        ],
      }),
    );
  }
  if (prd.docs.readmeRequired) {
    const sectionChecks = (prd.docs.readmeSections ?? [])
      .map((section) => section.trim())
      .filter(Boolean)
      .map((section) => readmeSectionGate(section, escapeDoubleQuoted));
    tasks.push(
      makeTask({
        id: normalizeTaskId(n++),
        title: "Initialize and maintain human-readable README.md",
        doneWhen: ["test -f README.md", ...sectionChecks],
        dependsOn: [scaffoldId],
        labels: ["docs"],
        acceptance: [
          `README.md includes: ${(prd.docs.readmeSections ?? []).join(", ")}`,
        ],
      }),
    );
  }
  for (const feature of normalizeMustHaveFeatureAtoms(prd.product.mustHaveFeatures)) {
    const atoms = toAtomicFeatureTasks(feature);
    for (const atom of atoms) {
    tasks.push(
      makeTask({
        id: normalizeTaskId(n++),
          title: `Implement: ${atom}`,
        doneWhen,
          labels: ["feature"],
          acceptance: [atom],
      }),
    );
    }
  }
  return {
    ...prd,
    tasks,
    verificationPolicy: {
      ...prd.verificationPolicy,
      globalGates: doneWhen,
    },
  };
};

const formatReasonCode = (code: string): string => `ReasonCode: ${code}`;

const interviewPrompt = (prd: PrdJson, input: string): string => {
  const missingField = firstMissingField(prd);
  const readiness = {
    idea: hasNonEmpty(prd.idea),
    platform: prd.platform !== null,
    frontend: typeof prd.frontend === "boolean",
    uiVerificationRequired: prd.frontend === false || typeof prd.uiVerificationRequired === "boolean",
    uiDesignSystem: prd.frontend === false || prd.ui.designSystem !== null,
    uiVisualDirection: prd.frontend === false || hasNonEmpty(prd.ui.visualDirection),
    uiUxRequirements: prd.frontend === false || hasMeaningfulList(prd.ui.uxRequirements),
    docsReadmeRequired: typeof prd.docs.readmeRequired === "boolean",
    docsReadmeSections: prd.docs.readmeRequired === false || hasMeaningfulList(prd.docs.readmeSections),
    language: prd.language !== null,
    framework: hasNonEmpty(prd.framework),
    targetUsers: hasMeaningfulList(prd.product.targetUsers),
    userProblems: hasMeaningfulList(prd.product.userProblems),
    mustHaveFeatures: hasMeaningfulList(prd.product.mustHaveFeatures, MIN_FEATURES),
    nonGoals: hasMeaningfulList(prd.product.nonGoals),
    successMetrics: hasMeaningfulList(prd.product.successMetrics),
    constraints: hasMeaningfulList(prd.product.constraints),
    qualityGates: hasMeaningfulList(prd.qualityGates, MIN_QUALITY_GATES),
  };
  const current = {
    idea: prd.idea,
    platform: prd.platform,
    frontend: prd.frontend,
    uiVerificationRequired: prd.uiVerificationRequired,
    uiDesignSystem: prd.ui.designSystem,
    uiStyleReferenceMode: prd.ui.styleReferenceMode,
    uiStyleReferences: prd.ui.styleReferences,
    uiVisualDirection: prd.ui.visualDirection,
    uiUxRequirements: prd.ui.uxRequirements,
    docsReadmeRequired: prd.docs.readmeRequired,
    docsReadmeSections: prd.docs.readmeSections,
    planning: prd.planning,
    language: prd.language,
    framework: prd.framework,
    targetUsers: prd.product.targetUsers,
    userProblems: prd.product.userProblems,
    qualityGates: prd.qualityGates,
    mustHaveFeatures: prd.product.mustHaveFeatures,
    nonGoals: prd.product.nonGoals,
    successMetrics: prd.product.successMetrics,
    constraints: prd.product.constraints,
    step: prd.wizard.step,
  };
  return [
    "You are mario-devx's PRD interviewer.",
    "Conduct a deep PRD interview. Ask ONE concise but high-leverage follow-up question per turn.",
    "The question should force specificity, remove ambiguity, and improve implementation readiness.",
    "You must return BOTH:",
    "1) a JSON envelope between <MARIO_JSON> tags",
    "2) the next question between <MARIO_QUESTION> tags",
    "",
    "Required fields before done=true:",
    "- idea",
    "- platform (web|api|cli|library)",
    "- frontend (true/false)",
    "- uiVerificationRequired (true/false when frontend=true)",
    "- uiDesignSystem (none|tailwind|shadcn|custom when frontend=true)",
    "- uiStyleReferenceMode (url|screenshot|mixed when frontend=true)",
    "- uiStyleReferences (optional URLs and/or screenshot paths when frontend=true)",
    "- uiVisualDirection (non-empty string when frontend=true)",
    "- uiUxRequirements (non-empty string[] when frontend=true)",
    "- docsReadmeRequired (true/false)",
    "- docsReadmeSections (non-empty string[] when docsReadmeRequired=true)",
    "- language (typescript|python|go|rust|other)",
    "- framework (string)",
    "- targetUsers (non-empty string[])",
    "- userProblems (non-empty string[])",
    `- mustHaveFeatures (at least ${MIN_FEATURES} atomic action statements)`,
    "- nonGoals (non-empty string[])",
    "- successMetrics (non-empty string[])",
    "- constraints (non-empty string[])",
    `- qualityGates (at least ${MIN_QUALITY_GATES} runnable commands including both test and static checks)`,
    "",
    "Envelope schema:",
    '{"done": boolean, "updates": {idea?, platform?, frontend?, uiVerificationRequired?, uiDesignSystem?, uiStyleReferenceMode?, uiStyleReferences?, uiVisualDirection?, uiUxRequirements?, docsReadmeRequired?, docsReadmeSections?, language?, framework?, targetUsers?, userProblems?, mustHaveFeatures?, nonGoals?, successMetrics?, constraints?, qualityGates?}, "next_question": string}',
    "",
    "Rules:",
    "- updates MUST include only fields changed by this answer.",
    "- Ask probing follow-ups until requirements are testable and implementation-ready.",
    "- Ask direct natural-language questions; do NOT use A/B/C/D multiple-choice formatting.",
    "- Ask about ONE missing field only; do not combine multiple fields in one question.",
    "- Keep question short (max 22 words), concrete, and answerable in one message.",
    "- For boolean fields, ask yes/no in plain language (never ask for true/false literals).",
    "- Do not re-ask fields that are already satisfied in the readiness checklist.",
    "- Plan implementation order as: scaffold baseline, quality-pipeline setup, README baseline, then feature tasks.",
    "- qualityGates must be explicit runnable commands (eg: npm run lint).",
    "- Do not accept vague features (like 'good UX'); ask for concrete behavior.",
    "- Decompose must-have features into atomic, independently testable behaviors; task count is unbounded if needed.",
    "- For frontend projects, capture UI direction deeply (design system, visual direction, UX requirements, optional reference URLs).",
    "- style references can include both web URLs and screenshot file paths.",
    "- Do not mark done=true unless ALL required fields pass the criteria above.",
    "- if unsure, ask a question and keep done=false.",
    "- no markdown except the two required tags.",
    "",
    "Readiness checklist:",
    JSON.stringify(readiness, null, 2),
    "",
    "Current target field (ask only this):",
    missingField,
    "",
    "Current PRD state:",
    JSON.stringify(current, null, 2),
    "",
    "User answer:",
    input,
    "",
    "Return format exactly:",
    "<MARIO_JSON>",
    '{"done":false,"updates":{},"next_question":"..."}',
    "</MARIO_JSON>",
    "<MARIO_QUESTION>",
    "...",
    "</MARIO_QUESTION>",
  ].join("\n");
};

const parseInterviewResponse = (text: string): { envelope: InterviewEnvelope | null; question: string | null } => {
  const jsonMatch = text.match(/<MARIO_JSON>([\s\S]*?)<\/MARIO_JSON>/i);
  const questionMatch = text.match(/<MARIO_QUESTION>([\s\S]*?)<\/MARIO_QUESTION>/i);
  if (!jsonMatch) {
    return { envelope: null, question: questionMatch?.[1]?.trim() ?? null };
  }
  try {
    const envelope = JSON.parse((jsonMatch[1] ?? "").trim()) as InterviewEnvelope;
    return { envelope, question: questionMatch?.[1]?.trim() ?? null };
  } catch {
    return { envelope: null, question: questionMatch?.[1]?.trim() ?? null };
  }
};

const applyInterviewUpdates = (prd: PrdJson, updates: InterviewUpdates | undefined): PrdJson => {
  if (!updates) return prd;
  
  // Deep merge with automatic normalization
  const merge = (target: any, source: any): any => {
    if (source === undefined || source === null) return target;
    if (typeof source === "string") return source.trim();
    if (Array.isArray(source)) return normalizeTextArray(source);
    if (typeof source === "object") {
      const result = { ...target };
      for (const key of Object.keys(source)) {
        result[key] = merge(result[key], source[key]);
      }
      return result;
    }
    return source;
  };
  
  let next = merge(prd, updates) as PrdJson;
  
  // Derive dependent fields
  if (next.platform && next.platform !== "web") {
    next.frontend = false;
    next.uiVerificationRequired = false;
  }
  if (typeof next.uiVerificationRequired === "boolean") {
    next.verificationPolicy = {
      ...next.verificationPolicy,
      uiPolicy: next.uiVerificationRequired ? "required" : "best_effort",
      globalGates: next.qualityGates,
    };
  }
  if (next.frontend === false) {
    next.uiVerificationRequired = false;
    next.ui = {
      ...next.ui,
      designSystem: "none",
      visualDirection: next.ui.visualDirection || "non-UI project",
      uxRequirements: next.ui.uxRequirements?.length > 0 ? next.ui.uxRequirements : ["No browser UI required."],
    };
  }
  if (next.docs.readmeRequired === false) {
    next.docs = { ...next.docs, readmeSections: [] };
  }
  if (typeof next.framework === "string" && next.framework.trim().length === 0) {
    next.framework = null;
  }
  
  return next;
};

const parseJudgeAttemptFromText = (text: string): PrdJudgeAttempt => {
  const lines = text.split(/\r?\n/);

  let status: "PASS" | "FAIL" = "FAIL";
  let statusSeen: "PASS" | "FAIL" | null = null;
  let statusExplicit = false;
  let statusConflict = false;
  let exitSignal = false;
  let exitExplicit = false;
  let section: "none" | "reason" | "next" = "none";
  const reason: string[] = [];
  const nextActions: string[] = [];
  const unmatched: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const sm = line.match(/^Status:\s*(PASS|FAIL)\s*$/i);
    if (sm) {
      const next = (sm[1] ?? "FAIL").toUpperCase() as "PASS" | "FAIL";
      if (statusSeen && statusSeen !== next) {
        statusConflict = true;
      }
      statusSeen = statusSeen ?? next;
      statusExplicit = true;
      status = next;
      continue;
    }
    const em = line.match(/^EXIT_SIGNAL:\s*(true|false)\s*$/i);
    if (em) {
      exitSignal = (em[1] ?? "false").toLowerCase() === "true";
      exitExplicit = true;
      continue;
    }
    if (/^(Reason|Reasons):\s*$/i.test(line)) {
      section = "reason";
      continue;
    }
    if (/^(Next actions|Next steps):\s*$/i.test(line)) {
      section = "next";
      continue;
    }

    const isBullet = line.startsWith("-");
    const content = isBullet ? line.replace(/^[-\s]+/, "").trim() : line;
    if (!content) {
      continue;
    }

    if (section === "reason") {
      if (isBullet || reason.length === 0) {
        reason.push(content);
      } else {
        reason[reason.length - 1] = `${reason[reason.length - 1]} ${content}`;
      }
      continue;
    }
    if (section === "next") {
      if (isBullet || nextActions.length === 0) {
        nextActions.push(content);
      } else {
        nextActions[nextActions.length - 1] = `${nextActions[nextActions.length - 1]} ${content}`;
      }
      continue;
    }

    // Preserve unmatched non-empty lines as fallback context.
    unmatched.push(content);
  }

  if (statusConflict) {
    return {
      status: "FAIL",
      exitSignal: false,
      reason: ["Verifier output invalid: conflicting Status lines found."],
      nextActions: ["Fix the verifier output to include exactly one Status line, then rerun /mario-devx:run 1."],
      rawText: text,
    };
  }

  const normalizedReason = reason.length > 0 ? reason : unmatched.length > 0 ? unmatched : ["Verifier did not provide a parsable Reason list."];
  const normalizedNext = nextActions.length > 0 ? nextActions : ["Fix issues and rerun /mario-devx:run 1."];

  if (!statusExplicit || !exitExplicit) {
    return {
      status: "FAIL",
      exitSignal: false,
      reason: [
        `Verifier output invalid: missing required header(s):${statusExplicit ? "" : " Status:"}${exitExplicit ? "" : " EXIT_SIGNAL:"}`.trim(),
      ],
      nextActions: [
        "Re-run verifier and return exact format: Status, EXIT_SIGNAL, Reason bullets, Next actions bullets.",
      ],
      rawText: text,
    };
  }

  if (status === "PASS" && exitSignal !== true) {
    return {
      status: "FAIL",
      exitSignal: false,
      reason: ["Verifier output invalid: Status: PASS requires EXIT_SIGNAL: true."],
      nextActions: ["Fix the verifier output format (PASS must set EXIT_SIGNAL: true), then rerun /mario-devx:run 1."],
      rawText: text,
    };
  }

  return {
    status,
    exitSignal: status === "PASS" ? true : false,
    reason: normalizedReason,
    nextActions: normalizedNext,
    rawText: text,
  };
};

const judgeNeedsStrictRetry = (judge: PrdJudgeAttempt): boolean => {
  return (
    judge.status === "FAIL"
    && Array.isArray(judge.reason)
    && judge.reason.some((line) => line.toLowerCase().includes("verifier output invalid"))
  );
};

const showToast = async (
  ctx: PluginContext,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
): Promise<void> => {
  if (!ctx.client?.tui?.showToast) {
    return;
  }
  await ctx.client.tui.showToast({
    body: {
      message,
      variant,
    },
  });
};

const notifyControlSession = async (
  ctx: PluginContext,
  controlSessionId: string | undefined,
  message: string,
): Promise<void> => {
  if (!controlSessionId) {
    return;
  }
  try {
    await ctx.client.session.prompt({
      path: { id: controlSessionId },
      body: {
        noReply: true,
        parts: [{ type: "text", text: message }],
      },
    });
  } catch {
    // Best-effort only.
  }
};

export const createTools = (ctx: PluginContext) => {
  const repoRoot = getRepoRoot(ctx);

  return {
    mario_devx_new: tool({
      description: "Interactive PRD interview (writes .mario/prd.json)",
      args: {
        idea: tool.schema.string().optional().describe("Initial idea"),
      },
      async execute(args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }

        await ensureMario(repoRoot, false);
        let prd = await ensurePrd(repoRoot);
        const rawInput = (args.idea ?? "").trim();

        if (prd.wizard.status === "completed") {
          return [
            "PRD wizard: completed.",
            `Edit: ${path.join(repoRoot, ".mario", "prd.json")}`,
            "Next: /mario-devx:run 1",
          ].join("\n");
        }

        if (rawInput && prd.wizard.step === 0 && !hasNonEmpty(prd.idea)) {
          prd = {
            ...prd,
            idea: rawInput,
          };
        }

        const hasAnswer = rawInput.length > 0;
        if (hasAnswer) {
          const extractedStyleRefs = extractStyleReferencesFromText(rawInput);
          if (extractedStyleRefs.length > 0) {
            prd = {
              ...prd,
              ui: {
                ...prd.ui,
                styleReferences: mergeStyleReferences(prd.ui.styleReferences, extractedStyleRefs),
              },
            };
          }
        }

        const persistInterviewProgress = async (nextPrd: PrdJson): Promise<string> => {
          const step = deriveWizardStep(nextPrd);
          const done = isPrdComplete(nextPrd);
          const nextQuestion = fallbackQuestion(nextPrd);
          let updated = {
            ...nextPrd,
            wizard: {
              ...nextPrd.wizard,
              step,
              totalSteps: WIZARD_TOTAL_STEPS,
              status: done ? "completed" : "in_progress",
              lastQuestionId: firstMissingField(nextPrd),
              answers: {
                ...nextPrd.wizard.answers,
                ...(hasAnswer ? { [`turn-${Date.now()}`]: rawInput } : {}),
                [LAST_QUESTION_KEY]: nextQuestion,
              },
            },
          };

          if (done) {
            updated = await seedTasksFromPrd(repoRoot, updated);
            updated = {
              ...updated,
              wizard: {
                ...updated.wizard,
                status: "completed",
                step: WIZARD_TOTAL_STEPS,
                lastQuestionId: "done",
              },
            };
            await writePrdJson(repoRoot, updated);
            return [
              "PRD wizard: completed.",
              `PRD: ${path.join(repoRoot, ".mario", "prd.json")}`,
              `Tasks: ${updated.tasks.length}`,
              "Next: /mario-devx:run 1",
            ].join("\n");
          }

          await writePrdJson(repoRoot, updated);
          return [
            `PRD interview (${step}/${WIZARD_TOTAL_STEPS})`,
            nextQuestion,
            "Reply with your answer in natural language.",
          ].join("\n");
        };

        const cachedQuestion = prd.wizard.answers?.[LAST_QUESTION_KEY];
        if (!hasAnswer && cachedQuestion) {
          return [
            `PRD interview (${deriveWizardStep(prd)}/${WIZARD_TOTAL_STEPS})`,
            cachedQuestion,
            "Reply with your answer in natural language.",
          ].join("\n");
        }

        if (hasAnswer && looksLikeUiChoiceArtifact(rawInput)) {
          const questionText = cachedQuestion || fallbackQuestion(prd);
          return [
            `PRD interview (${deriveWizardStep(prd)}/${WIZARD_TOTAL_STEPS})`,
            questionText,
            "Please answer directly in your own words (the last input looked like a menu/option label).",
          ].join("\n");
        }

        const ws = await ensureWorkSession(ctx, repoRoot, context.agent);
        const interviewInput = hasAnswer ? rawInput : "Start the interview and ask the first unanswered question.";
        const interviewResponse = await ctx.client.session.prompt({
          path: { id: ws.sessionId },
          body: {
            ...(context.agent ? { agent: context.agent } : {}),
            parts: [{ type: "text", text: interviewPrompt(prd, interviewInput) }],
          },
        });
        const text = extractTextFromPromptResponse(interviewResponse);
        const { envelope, question } = parseInterviewResponse(text);

        if (envelope?.updates) {
          prd = applyInterviewUpdates(prd, envelope.updates);
        }

        const step = deriveWizardStep(prd);
        const done = isPrdComplete(prd);
        const modelQuestion = (question && question.trim()) || envelope?.next_question?.trim() || "";
        const nextQuestion = looksTooBroadQuestion(modelQuestion) ? fallbackQuestion(prd) : (modelQuestion || fallbackQuestion(prd));
        const repeatedBooleanQuestion = hasAnswer
          && isLikelyBooleanReply(rawInput)
          && sameQuestion(cachedQuestion, nextQuestion)
          && typeof prd.uiVerificationRequired === "boolean";
        const finalQuestion = repeatedBooleanQuestion ? fallbackQuestion(prd) : nextQuestion;

        prd = {
          ...prd,
          wizard: {
            ...prd.wizard,
            step,
            totalSteps: WIZARD_TOTAL_STEPS,
            status: done ? "completed" : "in_progress",
            lastQuestionId: firstMissingField(prd),
            answers: {
              ...prd.wizard.answers,
              ...(hasAnswer ? { [`turn-${Date.now()}`]: rawInput } : {}),
              [LAST_QUESTION_KEY]: finalQuestion,
            },
          },
        };

        if (done) {
          prd = await seedTasksFromPrd(repoRoot, prd);
          prd = {
            ...prd,
            wizard: {
              ...prd.wizard,
              status: "completed",
              step: WIZARD_TOTAL_STEPS,
              lastQuestionId: "done",
            },
          };
          await writePrdJson(repoRoot, prd);
          return [
            "PRD wizard: completed.",
            `PRD: ${path.join(repoRoot, ".mario", "prd.json")}`,
            `Tasks: ${prd.tasks.length}`,
            "Next: /mario-devx:run 1",
          ].join("\n");
        }

        await writePrdJson(repoRoot, prd);
        return [
          `PRD interview (${step}/${WIZARD_TOTAL_STEPS})`,
          finalQuestion,
          "Reply with your answer in natural language.",
        ].join("\n");
      },
    }),

    mario_devx_run: tool({
      description: "Run next tasks (build + verify, stops on failure)",
      args: {
        max_items: tool.schema.string().optional().describe("Maximum number of tasks to attempt (default: 1)"),
      },
      async execute(args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }

        await ensureMario(repoRoot, false);

        const previousRun = await readRunState(repoRoot);
        if (
          ((context.sessionID && previousRun.lastRunControlSessionId === context.sessionID)
            || (!context.sessionID && !!previousRun.lastRunControlSessionId))
          && previousRun.lastRunAt
          && previousRun.lastRunResult
          && Number.isFinite(Date.parse(previousRun.lastRunAt))
          && (Date.now() - Date.parse(previousRun.lastRunAt)) <= RUN_DUPLICATE_WINDOW_MS
        ) {
          return previousRun.lastRunResult;
        }

        const lock = await acquireRunLock(repoRoot, context.sessionID);
        if (!lock.ok) {
          return lock.message;
        }

        try {
          if (!(await heartbeatRunLock(repoRoot))) {
            await writeRunState(repoRoot, {
              iteration: (await readRunState(repoRoot)).iteration,
              status: "BLOCKED",
              phase: "run",
              ...(context.sessionID ? { controlSessionId: context.sessionID } : {}),
              updatedAt: nowIso(),
            });
            return `Failed to update run.lock heartbeat during run preflight (${runLockPath(repoRoot)}). Check disk space/permissions, then rerun /mario-devx:run 1.`;
          }
          const currentRun = await readRunState(repoRoot);
          if (currentRun.status === "DOING") {
            return `A mario-devx run is already in progress (${currentRun.phase}). Wait for it to finish, then rerun /mario-devx:status.`;
          }

          let prd = await ensurePrd(repoRoot);
          const workspaceRoot = await resolveNodeWorkspaceRoot(repoRoot);
          const workspaceAbs = workspaceRoot === "." ? repoRoot : path.join(repoRoot, workspaceRoot);
          if (prd.wizard.status !== "completed") {
            return "PRD wizard is not complete. Run /mario-devx:new to finish it.";
          }
          if (!Array.isArray(prd.tasks) || prd.tasks.length === 0) {
            return "No tasks found in .mario/prd.json. Run /mario-devx:new to seed tasks.";
          }
          if (!Array.isArray(prd.qualityGates) || prd.qualityGates.length === 0) {
            return "No quality gates configured in .mario/prd.json (qualityGates is empty). Add at least one command, then rerun /mario-devx:run 1.";
          }

        const inProgress = (prd.tasks ?? []).filter((t) => t.status === "in_progress");
        if (inProgress.length > 1) {
          const focus = inProgress[0];
          const ids = new Set(inProgress.map((t) => t.id));
          const state = await bumpIteration(repoRoot);
          const attemptAt = nowIso();
          const gates: PrdGatesAttempt = { ok: false, commands: [] };
          const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
          const judge: PrdJudgeAttempt = {
            status: "FAIL",
            exitSignal: false,
            reason: [
              `Invalid task state: multiple tasks are in_progress (${inProgress.map((t) => t.id).join(", ")}).`,
            ],
            nextActions: [
              "Edit .mario/prd.json so at most one task is in_progress (set the others to open/blocked/cancelled).",
              "Then rerun /mario-devx:run 1.",
            ],
          };
          const lastAttempt: PrdTaskAttempt = {
            at: attemptAt,
            iteration: state.iteration,
            gates,
            ui,
            judge,
          };
          // Normalize: block ALL in_progress tasks; attach a single lastAttempt to the focus task.
          prd = {
            ...prd,
            tasks: (prd.tasks ?? []).map((t) => (ids.has(t.id) ? { ...t, status: "blocked" as const } : t)),
          };
          for (const t of inProgress) {
            prd = setPrdTaskLastAttempt(prd, t.id, lastAttempt);
          }
          await writePrdJson(repoRoot, prd);
          await writeRunState(repoRoot, {
            iteration: state.iteration,
            status: "BLOCKED",
            phase: "run",
            ...(focus?.id ? { currentPI: focus.id } : {}),
            ...(context.sessionID ? { controlSessionId: context.sessionID } : {}),
            updatedAt: nowIso(),
          });
          return judge.reason.concat(["", "See tasks[].lastAttempt.judge.nextActions in .mario/prd.json."]).join("\n");
        }

          if (prd.frontend === true) {
            const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
            const raw = (await readTextIfExists(agentsPath)) ?? "";
            const parsed = parseAgentsEnv(raw);
            const env = parsed.env;
            const uiRequired = prd.uiVerificationRequired === true;
            if (parsed.warnings.length > 0) {
              await showToast(ctx, `Run warning: AGENTS.md parse warnings (${parsed.warnings.length})`, "warning");
            }
            if (env.UI_VERIFY !== "1") {
              let next = raw;
              next = upsertAgentsKey(next, "UI_VERIFY", "1");
              next = upsertAgentsKey(next, "UI_VERIFY_REQUIRED", uiRequired ? "1" : "0");
              const defaultUiCmd = workspaceRoot === "app" ? "npm --prefix app run dev" : "npm run dev";
              if (!hasAgentsKey(next, "UI_VERIFY_CMD") || !env.UI_VERIFY_CMD || (workspaceRoot === "app" && env.UI_VERIFY_CMD === "npm run dev")) {
                next = upsertAgentsKey(next, "UI_VERIFY_CMD", defaultUiCmd);
              }
              if (!env.UI_VERIFY_URL) next = upsertAgentsKey(next, "UI_VERIFY_URL", "http://localhost:3000");
              if (!env.AGENT_BROWSER_REPO) next = upsertAgentsKey(next, "AGENT_BROWSER_REPO", "https://github.com/vercel-labs/agent-browser");
              await writeText(agentsPath, next);
            } else if ((env.UI_VERIFY_REQUIRED === "1") !== uiRequired) {
              let next = upsertAgentsKey(raw, "UI_VERIFY_REQUIRED", uiRequired ? "1" : "0");
              if ((workspaceRoot === "app" && env.UI_VERIFY_CMD === "npm run dev") || !hasAgentsKey(raw, "UI_VERIFY_CMD")) {
                next = upsertAgentsKey(next, "UI_VERIFY_CMD", workspaceRoot === "app" ? "npm --prefix app run dev" : "npm run dev");
              }
              await writeText(agentsPath, next);
            }
          }

        const rawMax = (args.max_items ?? "").trim();
        const parsed = rawMax.length === 0 ? 1 : Number.parseInt(rawMax, 10);
        const maxItems = Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 1;

        const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
        const agentsRaw = await readTextIfExists(agentsPath);
        const agentsParsed = agentsRaw ? parseAgentsEnv(agentsRaw) : { env: {}, warnings: [] };
        const agentsEnv = agentsParsed.env;
        if (agentsParsed.warnings.length > 0) {
          await showToast(ctx, `Run warning: AGENTS.md parse warnings (${agentsParsed.warnings.length})`, "warning");
        }
        const uiVerifyEnabled = agentsEnv.UI_VERIFY === "1";
        const uiVerifyCmd = agentsEnv.UI_VERIFY_CMD || (workspaceRoot === "app" ? "npm --prefix app run dev" : "npm run dev");
        const uiVerifyUrl = agentsEnv.UI_VERIFY_URL || "http://localhost:3000";
        const uiVerifyRequired = agentsEnv.UI_VERIFY_REQUIRED === "1";
        const agentBrowserRepo = agentsEnv.AGENT_BROWSER_REPO || "https://github.com/vercel-labs/agent-browser";

        const isWebApp = await isLikelyWebApp(repoRoot);
        let cliOk = await hasAgentBrowserCli(ctx);
        let skillOk = await hasAgentBrowserSkill(repoRoot);
        let autoInstallAttempted: string[] = [];
        if (uiVerifyEnabled && isWebApp && (!cliOk || !skillOk)) {
          const ensured = await ensureAgentBrowserPrereqs(ctx, repoRoot);
          cliOk = ensured.cliOk;
          skillOk = ensured.skillOk;
          autoInstallAttempted = ensured.attempted;
        }
        const shouldRunUiVerify = uiVerifyEnabled && isWebApp && cliOk && skillOk;

          let attempted = 0;
          let completed = 0;

          while (attempted < maxItems) {
            const task = getNextPrdTask(prd);
            if (!task) {
              break;
            }

            const prerequisiteTask = (prd.tasks ?? []).find((t) => {
              if (t.id === task.id) return false;
              if (t.status === "completed" || t.status === "cancelled") return false;
              const labels = t.labels ?? [];
              return labels.includes("scaffold") || labels.includes("quality") || labels.includes("docs") || labels.includes("foundation");
            });
            if ((task.labels ?? []).includes("feature") && prerequisiteTask) {
              const state = await bumpIteration(repoRoot);
              const attemptAt = nowIso();
              const gates: PrdGatesAttempt = { ok: false, commands: [] };
              const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
              const judge: PrdJudgeAttempt = {
                status: "FAIL",
                exitSignal: false,
                reason: [
                  formatReasonCode("PREREQ_TASK_PENDING"),
                  `Cannot execute feature task ${task.id} before prerequisite task ${prerequisiteTask.id} (${prerequisiteTask.title}) is completed.`,
                ],
                nextActions: [
                  `Complete ${prerequisiteTask.id} first, then rerun /mario-devx:run 1.`,
                ],
              };
              const lastAttempt: PrdTaskAttempt = {
                at: attemptAt,
                iteration: state.iteration,
                gates,
                ui,
                judge,
              };
              prd = setPrdTaskStatus(prd, task.id, "blocked");
              prd = setPrdTaskLastAttempt(prd, task.id, lastAttempt);
              await writePrdJson(repoRoot, prd);
              await updateRunState(repoRoot, {
                status: "BLOCKED",
                phase: "run",
                currentPI: task.id,
              });
              await showToast(ctx, `Run blocked: ${task.id} requires ${prerequisiteTask.id}`, "warning");
              break;
            }

            const taskPolicyGates = prd.verificationPolicy?.taskGates?.[task.id] ?? [];
            const effectiveDoneWhen = task.doneWhen.length > 0
              ? task.doneWhen
              : taskPolicyGates.length > 0
                ? taskPolicyGates
                : (prd.verificationPolicy?.globalGates?.length
                  ? prd.verificationPolicy.globalGates
                  : (prd.qualityGates ?? []));
            const gateCommands = effectiveDoneWhen.map((command, idx) => ({
              name: `gate-${idx + 1}`,
              command,
            }));
            attempted += 1;

            prd = setPrdTaskStatus(prd, task.id, "in_progress");
            await writePrdJson(repoRoot, prd);

          const state = await bumpIteration(repoRoot);
          const attemptAt = nowIso();

          const iterationPlan = [
            `# Iteration Task (${task.id})`,
            "",
            `Title: ${task.title}`,
            "",
            `Status: ${task.status}`,
            task.scope.length > 0 ? `Scope: ${task.scope.join(", ")}` : "",
            effectiveDoneWhen.length > 0 ? `Done when:\n${effectiveDoneWhen.map((d) => `- ${d}`).join("\n")}` : "Done when: (none)",
            task.notes && task.notes.length > 0 ? `Notes:\n${task.notes.map((n) => `- ${n}`).join("\n")}` : "",
            prd.frontend
              ? [
                  "UI context:",
                  `- Design system: ${prd.ui.designSystem ?? "unspecified"}`,
                  `- Visual direction: ${prd.ui.visualDirection || "unspecified"}`,
                  `- UX requirements: ${(prd.ui.uxRequirements ?? []).join("; ") || "unspecified"}`,
                  `- Style references: ${(prd.ui.styleReferences ?? []).join(", ") || "none"}`,
                ].join("\n")
              : "",
            prd.docs.readmeRequired
              ? `README policy: required sections -> ${(prd.docs.readmeSections ?? []).join(", ")}`
              : "README policy: optional",
          ]
            .filter((x) => x)
            .join("\n");
          const buildModePrompt = await buildPrompt(repoRoot, "build", iterationPlan);

          await showToast(ctx, `Run: started ${task.id} (${attempted}/${maxItems})`, "info");

           const blockForHeartbeatFailure = async (phase: string): Promise<void> => {
              const gates: PrdGatesAttempt = { ok: false, commands: [] };
              const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
              const judge: PrdJudgeAttempt = {
                status: "FAIL",
                exitSignal: false,
                reason: [`Failed to update run.lock heartbeat during ${phase} (${runLockPath(repoRoot)}).`],
                nextActions: ["Check disk space/permissions for .mario/state/run.lock, then rerun /mario-devx:run 1."],
              };
             const lastAttempt: PrdTaskAttempt = {
               at: attemptAt,
               iteration: state.iteration,
               gates,
               ui,
               judge,
             };
             prd = setPrdTaskStatus(prd, task.id, "blocked");
             prd = setPrdTaskLastAttempt(prd, task.id, lastAttempt);
             await writePrdJson(repoRoot, prd);
             await updateRunState(repoRoot, {
               status: "BLOCKED",
               phase: "run",
               currentPI: task.id,
             });
           };

            if (!(await heartbeatRunLock(repoRoot))) {
              await blockForHeartbeatFailure("pre-work-session-reset");
              await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
              break;
            }
            const ws = await resetWorkSession(ctx, repoRoot, context.agent);
            await setWorkSessionTitle(ctx, ws.sessionId, `mario-devx (work) - ${task.id}`);
            await updateRunState(repoRoot, {
              status: "DOING",
              phase: "run",
              currentPI: task.id,
              controlSessionId: context.sessionID,
              workSessionId: ws.sessionId,
              baselineMessageId: ws.baselineMessageId,
              startedAt: nowIso(),
            });


            try {
              if (!(await heartbeatRunLock(repoRoot))) {
                await blockForHeartbeatFailure("before-build-prompt");
                await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
                break;
              }
              await ctx.client.session.promptAsync({
                path: { id: ws.sessionId },
                body: {
                  ...(context.agent ? { agent: context.agent } : {}),
                  parts: [{ type: "text", text: buildModePrompt }],
                },
              });

              if (!(await heartbeatRunLock(repoRoot))) {
                await blockForHeartbeatFailure("after-build-prompt");
                await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
                break;
              }

              const idle = await waitForSessionIdle(ctx, ws.sessionId, 20 * 60 * 1000);
              if (!idle) {
                const gates: PrdGatesAttempt = { ok: false, commands: [] };
                const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
                const judge: PrdJudgeAttempt = {
                  status: "FAIL",
                  exitSignal: false,
                  reason: ["Build timed out waiting for the work session to go idle."],
                  nextActions: ["Rerun /mario-devx:status; if it remains stuck, inspect the work session via /sessions."],
                };
                const lastAttempt: PrdTaskAttempt = {
                  at: attemptAt,
                  iteration: state.iteration,
                  gates,
                  ui,
                  judge,
                };
                prd = setPrdTaskStatus(prd, task.id, "blocked");
                prd = setPrdTaskLastAttempt(prd, task.id, lastAttempt);
                await writePrdJson(repoRoot, prd);
                await updateRunState(repoRoot, {
                  status: "BLOCKED",
                  phase: "run",
                  currentPI: task.id,
                });
                await showToast(ctx, `Run stopped: build timed out on ${task.id}`, "warning");
                break;
              }

              if (!(await heartbeatRunLock(repoRoot))) {
                await blockForHeartbeatFailure("after-build-idle");
                await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
                break;
              }

              const taskRepairStartedAt = Date.now();
              let repairAttempts = 0;
              let noProgressStreak = 0;
              let lastGateFailureSig: string | null = null;
              let deterministicScaffoldTried = false;
              const usesNodePackageScripts = gateCommands.some((g) => {
                const c = g.command.trim();
                return /^npm\s+run\s+/i.test(c) || /^pnpm\s+/i.test(c) || /^yarn\s+/i.test(c) || /^bun\s+run\s+/i.test(c);
              });
              if (task.id === "T-0002" && usesNodePackageScripts) {
                const bootstrap = await ensureT0002QualityBootstrap(repoRoot, workspaceRoot, gateCommands);
                if (bootstrap.changed) {
                  await showToast(ctx, `Run: bootstrapped missing quality scripts for ${task.id}`, "info");
                }
                if (ctx.$ && (!(await hasNodeModules(repoRoot, workspaceRoot)) || bootstrap.changed)) {
                  await showToast(ctx, `Run: installing dependencies in ${workspaceRoot === "." ? "repo root" : workspaceRoot}`, "info");
                  const installCmd = workspaceRoot === "." ? "npm install" : `npm --prefix ${workspaceRoot} install`;
                  await ctx.$`sh -c ${installCmd}`.nothrow();
                }
              }

              let gateResult = await runGateCommands(gateCommands, ctx.$, workspaceAbs);

              const failSigFromGate = (): string => {
                const failed = gateResult.failed;
                return failed ? `${failed.command}:${failed.exitCode}` : "unknown";
              };

              while (!gateResult.ok) {
                const currentSig = failSigFromGate();
                const elapsedMs = Date.now() - taskRepairStartedAt;
                if (lastGateFailureSig === currentSig) {
                  noProgressStreak += 1;
                } else {
                  noProgressStreak = 0;
                }
                lastGateFailureSig = currentSig;

                if (repairAttempts > 0 && (elapsedMs >= MAX_TASK_REPAIR_MS || noProgressStreak >= MAX_NO_PROGRESS_STREAK)) {
                  break;
                }

                const failedGate = gateResult.failed
                  ? `${gateResult.failed.command} (exit ${gateResult.failed.exitCode})`
                  : "(unknown command)";
                const scaffoldHint = firstScaffoldHintFromNotes(task.notes);
                const missingScript = gateResult.failed
                  ? await missingPackageScriptForCommand(repoRoot, workspaceRoot, gateResult.failed.command)
                  : null;

                if (!deterministicScaffoldTried
                  && gateResult.failed?.command
                  && isScaffoldMissingGateCommand(gateResult.failed.command)
                  && scaffoldHint
                  && ctx.$) {
                  deterministicScaffoldTried = true;
                  await showToast(ctx, `Run: trying default scaffold for ${task.id}`, "info");
                  await setWorkSessionTitle(ctx, ws.sessionId, `mario-devx (work) - scaffold ${task.id}`);
                  const scaffoldRun = await ctx.$`sh -c ${scaffoldHint}`.nothrow();
                  repairAttempts += 1;
                  if (!(await heartbeatRunLock(repoRoot))) {
                    await blockForHeartbeatFailure("during-deterministic-scaffold");
                    await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
                    break;
                  }
                  if (scaffoldRun.exitCode !== 0) {
                    await showToast(ctx, `Run: default scaffold failed on ${task.id}, falling back to agent repair`, "warning");
                  }
                  gateResult = await runGateCommands(gateCommands, ctx.$, workspaceAbs);
                  if (gateResult.ok) {
                    break;
                  }
                }

                const repairPrompt = [
                  `Task ${task.id} failed deterministic gate: ${failedGate}.`,
                  gateResult.failed?.command && isScaffoldMissingGateCommand(gateResult.failed.command)
                    ? "If project scaffold is missing, scaffold the app first before feature edits."
                    : "",
                  missingScript
                    ? `Detected missing npm script '${missingScript}'. Add it to package.json and required config/files so it passes.`
                    : "",
                  scaffoldHint ? `Optional scaffold default: ${scaffoldHint}` : "",
                  "Fix the repository so all deterministic gates pass.",
                  "Do not ask questions. Apply edits and stop when done.",
                ].join("\n");

                await setWorkSessionTitle(ctx, ws.sessionId, `mario-devx (work) - repair ${task.id}`);
                await ctx.client.session.promptAsync({
                  path: { id: ws.sessionId },
                  body: {
                    ...(context.agent ? { agent: context.agent } : {}),
                    parts: [{ type: "text", text: repairPrompt }],
                  },
                });

                if (!(await heartbeatRunLock(repoRoot))) {
                  await blockForHeartbeatFailure("during-auto-repair");
                  await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
                  break;
                }

                const repairIdle = await waitForSessionIdle(ctx, ws.sessionId, 15 * 60 * 1000);
                if (!repairIdle) {
                  break;
                }

                repairAttempts += 1;
                gateResult = await runGateCommands(gateCommands, ctx.$, workspaceAbs);
              }

              const uiResult = gateResult.ok && shouldRunUiVerify
                ? await runUiVerification({
                    ctx,
                    devCmd: uiVerifyCmd,
                    url: uiVerifyUrl,
                  })
                : null;

              if (!(await heartbeatRunLock(repoRoot))) {
                await blockForHeartbeatFailure("after-gates-ui");
                await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
                break;
              }

          const gates: PrdGatesAttempt = {
            ok: gateResult.ok,
            commands: gateResult.results.map((r) => ({
              command: r.command,
              ok: r.ok,
              exitCode: r.exitCode,
              durationMs: r.durationMs,
            })),
          };
          const ui: PrdUiAttempt = uiResult
            ? { ran: true, ok: uiResult.ok, ...(uiResult.note ? { note: uiResult.note } : {}) }
            : {
                ran: false,
                ok: null,
                note: !gateResult.ok
                  ? "UI verification not run because deterministic gates failed."
                  : uiVerifyEnabled && isWebApp && (!cliOk || !skillOk)
                    ? "UI verification skipped (prerequisites missing)."
                    : uiVerifyEnabled && isWebApp
                      ? "UI verification not run."
                      : "UI verification not configured.",
              };

          const failEarly = async (reasonLines: string[], nextActions?: string[]): Promise<void> => {
            const judge: PrdJudgeAttempt = {
              status: "FAIL",
              exitSignal: false,
              reason: reasonLines,
              nextActions: nextActions && nextActions.length > 0 ? nextActions : ["Fix the failing checks, then rerun /mario-devx:run 1."],
            };
            const lastAttempt: PrdTaskAttempt = {
              at: attemptAt,
              iteration: state.iteration,
              gates,
              ui,
              judge,
            };
            prd = setPrdTaskStatus(prd, task.id, "blocked");
            prd = setPrdTaskLastAttempt(prd, task.id, lastAttempt);
            await writePrdJson(repoRoot, prd);
            await updateRunState(repoRoot, {
              status: "BLOCKED",
              phase: "run",
              currentPI: task.id,
            });
          };

          if (!gateResult.ok) {
            const failed = gateResult.failed
              ? `${gateResult.failed.command} (exit ${gateResult.failed.exitCode})`
              : "(unknown command)";
            const scaffoldHint = firstScaffoldHintFromNotes(task.notes);
            const missingScript = gateResult.failed
              ? await missingPackageScriptForCommand(repoRoot, workspaceRoot, gateResult.failed.command)
              : null;
            const elapsedMs = Date.now() - taskRepairStartedAt;
            const reasonCodes: string[] = [];
            if (missingScript) {
              reasonCodes.push(formatReasonCode(`MISSING_SCRIPT_${missingScript.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`));
            }
            if (task.id === "T-0002" && gateResult.failed?.command) {
              reasonCodes.push(formatReasonCode("QUALITY_BOOTSTRAP_INCOMPLETE"));
            }
            if (gateResult.failed?.exitCode === 127) {
              reasonCodes.push(formatReasonCode("COMMAND_NOT_FOUND"));
            }
            const nextActions = [
              ...(missingScript
                ? [
                    `Add script '${missingScript}' in ${workspaceRoot === "." ? "package.json" : `${workspaceRoot}/package.json`} (and setup files it depends on).`,
                  ]
                : []),
              ...(scaffoldHint
                ? [
                    "Scaffold artifacts are missing; choose any valid scaffold approach for this stack.",
                    `Optional default command: ${scaffoldHint}`,
                  ]
                : []),
            ];
            if (nextActions.length === 0) {
              nextActions.push(`Fix deterministic gate '${failed}'.`);
              nextActions.push("If this is initial setup, scaffold the project baseline first (root or app/).");
            }
            nextActions.push("Then rerun /mario-devx:run 1.");
            await failEarly([
              ...reasonCodes,
              `Deterministic gate failed: ${failed}.`,
              `Auto-repair stopped after ${Math.round(elapsedMs / 1000)}s across ${repairAttempts} attempt(s) (no-progress or time budget reached).`,
            ], nextActions);
            await showToast(ctx, `Run stopped: gates failed on ${task.id}`, "warning");
            break;
          }

          if (uiVerifyEnabled && isWebApp && uiVerifyRequired && (!cliOk || !skillOk)) {
            await failEarly(
              [
              "UI verification is required but agent-browser prerequisites are missing.",
              ...(autoInstallAttempted.length > 0 ? [`Auto-install attempted: ${autoInstallAttempted.join("; ")}`] : []),
              `Repo: ${agentBrowserRepo}`,
              "Install: npx skills add vercel-labs/agent-browser",
              "Install: npm install -g agent-browser && agent-browser install",
              ],
              [
                "Install prerequisites, then rerun /mario-devx:run 1.",
                "Or set UI_VERIFY_REQUIRED=0 in .mario/AGENTS.md to make UI verification best-effort.",
              ],
            );
            await showToast(ctx, `Run stopped: UI prerequisites missing on ${task.id}`, "warning");
            break;
          }

          if (uiVerifyEnabled && isWebApp && uiVerifyRequired && uiResult && !uiResult.ok) {
            await failEarly([
              "UI verification failed.",
            ]);
            await showToast(ctx, `Run stopped: UI verification failed on ${task.id}`, "warning");
            break;
          }

          await showToast(
            ctx,
            `Gates: PASS${uiResult ? `; UI: ${uiResult.ok ? "PASS" : "FAIL"}` : ""}. Running verifier...`,
            "info",
          );

          const verifierPrompt = await buildPrompt(
            repoRoot,
            "verify",
            [
              `Task: ${task.id} - ${task.title}`,
              effectiveDoneWhen.length > 0
                ? `Done when:\n${effectiveDoneWhen.map((d) => `- ${d}`).join("\n")}`
                : "Done when: (none)",
              "",
              "Deterministic gates:",
              ...gateResult.results.map((r) => `- ${r.command}: ${r.ok ? "PASS" : `FAIL (exit ${r.exitCode})`}`),
              uiResult ? `UI verification: ${uiResult.ok ? "PASS" : "FAIL"}` : "UI verification: (not run)",
              uiResult?.note ? `UI note: ${uiResult.note}` : "",
            ]
              .filter((x) => x)
              .join("\n"),
          );

              await setWorkSessionTitle(ctx, ws.sessionId, `mario-devx (work) - judge ${task.id}`);
              const verifierResponse = await ctx.client.session.prompt({
                path: { id: ws.sessionId },
                body: {
                  ...(context.agent ? { agent: context.agent } : {}),
                  parts: [{ type: "text", text: verifierPrompt }],
                },
              });
              if (!(await heartbeatRunLock(repoRoot))) {
                await blockForHeartbeatFailure("after-judge");
                await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
                break;
              }
          const verifierText = extractTextFromPromptResponse(verifierResponse);
          let judge = parseJudgeAttemptFromText(verifierText);
          if (judgeNeedsStrictRetry(judge)) {
            const strictRetryPrompt = [
              "Re-evaluate and return ONLY the required verifier format.",
              "Required exact headers:",
              "Status: PASS|FAIL",
              "EXIT_SIGNAL: true|false",
              "Reason:",
              "- <bullets>",
              "Next actions:",
              "- <bullets>",
              "",
              "Do not include prose before headers.",
              "Previous invalid output:",
              verifierText,
            ].join("\n");
            const strictResp = await ctx.client.session.prompt({
              path: { id: ws.sessionId },
              body: {
                ...(context.agent ? { agent: context.agent } : {}),
                parts: [{ type: "text", text: strictRetryPrompt }],
              },
            });
            if (!(await heartbeatRunLock(repoRoot))) {
              await blockForHeartbeatFailure("after-judge-retry");
              await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
              break;
            }
            const strictText = extractTextFromPromptResponse(strictResp);
            judge = parseJudgeAttemptFromText(strictText);
          }
          const lastAttempt: PrdTaskAttempt = {
            at: attemptAt,
            iteration: state.iteration,
            gates,
            ui,
            judge,
          };
           await updateRunState(repoRoot, {
             status: judge.status === "PASS" ? "DOING" : "BLOCKED",
             phase: "run",
             currentPI: task.id,
             controlSessionId: context.sessionID,
           });

          prd = setPrdTaskStatus(prd, task.id, judge.status === "PASS" ? "completed" : "blocked");
          prd = setPrdTaskLastAttempt(prd, task.id, lastAttempt);
          await writePrdJson(repoRoot, prd);

          if (judge.status !== "PASS" || !judge.exitSignal) {
            await showToast(ctx, `Run stopped: verifier failed on ${task.id}`, "warning");
            break;
          }

              completed += 1;
              await showToast(ctx, `Run: completed ${task.id} (${completed}/${maxItems})`, "success");
            } finally {
              if ((await readRunState(repoRoot)).status === "DOING") {
                await updateRunState(repoRoot, { status: "BLOCKED", phase: "run" });
              }
            }
          }

          // Mark the run done once the loop ends.
          await updateRunState(repoRoot, {
            status: completed === attempted ? "DONE" : "BLOCKED",
            phase: "run",
            ...(context.sessionID ? { controlSessionId: context.sessionID } : {}),
            updatedAt: nowIso(),
          });

          const latestTask = (prd.tasks ?? [])
            .filter((t) => t.lastAttempt)
            .sort((a, b) => (b.lastAttempt?.iteration ?? 0) - (a.lastAttempt?.iteration ?? 0))[0] ?? null;
          const latestAttempt = latestTask?.lastAttempt;
          const passedGates = latestAttempt?.gates.commands.filter((c) => c.ok).length ?? 0;
          const totalGates = latestAttempt?.gates.commands.length ?? 0;
          const uiSummary = latestAttempt?.ui
            ? (latestAttempt.ui.ran ? `UI verify: ${latestAttempt.ui.ok ? "PASS" : "FAIL"}${uiVerifyRequired ? " (required)" : " (optional)"}` : "UI verify: not run")
            : "UI verify: not available";
          const judgeTopReason = latestAttempt?.judge.reason?.[0] ?? "No judge reason recorded.";

          const note =
            completed === attempted && attempted === maxItems
              ? "Reached max_items limit."
              : completed === attempted
                ? "No more open/in_progress tasks found."
                : "Stopped early due to failure. See task.lastAttempt.judge in .mario/prd.json.";

          const result = [
            `Run finished. Attempted: ${attempted}. Completed: ${completed}. ${note}`,
            latestTask ? `Task: ${latestTask.id} (${latestTask.status}) - ${latestTask.title}` : "Task: n/a",
            `Gates: ${passedGates}/${totalGates} PASS`,
            uiSummary,
            latestAttempt ? `Judge: ${latestAttempt.judge.status} (exit=${latestAttempt.judge.exitSignal})` : "Judge: n/a",
            `Reason: ${judgeTopReason}`,
          ].join("\n");

          await updateRunState(repoRoot, {
            ...(context.sessionID ? { lastRunControlSessionId: context.sessionID } : {}),
            lastRunAt: nowIso(),
            lastRunResult: result,
          });

          return result;
        } finally {
          await releaseRunLock(repoRoot);
        }
      },
    }),

    mario_devx_add: tool({
      description: "Add a feature request and decompose into tasks",
      args: {
        feature: tool.schema.string().describe("Feature request to add"),
      },
      async execute(args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }
        await ensureMario(repoRoot, false);
        let prd = await ensurePrd(repoRoot);
        const feature = (args.feature ?? "").trim();
        if (!feature) {
          return "Feature request is empty. Provide a short description.";
        }

        const runState = await readRunState(repoRoot);
        const activeInterview = runState.featureAddInterview?.active ? runState.featureAddInterview : null;
        if (activeInterview) {
          if (activeInterview.step === 1) {
            const acceptance = feature.split(/\n+/).map((line) => line.trim()).filter(Boolean);
            if (acceptance.length < 2) {
              const q = `For '${activeInterview.originalRequest}', list 2-5 concrete behaviors (one per line).`;
              const next: FeatureAddInterviewState = {
                ...activeInterview,
                lastQuestion: q,
              };
              await writeRunState(repoRoot, { ...runState, featureAddInterview: next, updatedAt: nowIso() });
              return [
                "Feature interview (1/3)",
                q,
                "Reply with your answer in natural language.",
              ].join("\n");
            }
            const q = "Any constraints or explicit non-goals for this feature? (Reply 'none' if nothing.)";
            const next: FeatureAddInterviewState = {
              ...activeInterview,
              acceptance,
              step: 2,
              lastQuestion: q,
            };
            await writeRunState(repoRoot, { ...runState, featureAddInterview: next, updatedAt: nowIso() });
            return [
              "Feature interview (2/3)",
              q,
              "Reply with your answer in natural language.",
            ].join("\n");
          }

          if (activeInterview.step === 2) {
            const s = feature.trim();
            const constraints = /^none$/i.test(s)
              ? []
              : s.split(/\n+/).map((line) => line.trim()).filter(Boolean);
            const q = "Any UX notes or edge cases? (Where it appears, interactions, confirmations, empty states. Reply 'none' if nothing.)";
            const next: FeatureAddInterviewState = {
              ...activeInterview,
              constraints,
              step: 3,
              lastQuestion: q,
            };
            await writeRunState(repoRoot, { ...runState, featureAddInterview: next, updatedAt: nowIso() });
            return [
              "Feature interview (3/3)",
              q,
              "Reply with your answer in natural language.",
            ].join("\n");
          }

          if (activeInterview.step === 3) {
            const uxNotes = /^none$/i.test(feature.trim()) ? "" : feature.trim();
            const constraints = activeInterview.constraints ?? [];
            const backlogId = nextBacklogId(prd);
            const gates = prd.verificationPolicy?.globalGates?.length
              ? prd.verificationPolicy.globalGates
              : prd.qualityGates;
            const startN = nextTaskOrdinal(prd.tasks ?? []);
            let n = startN;

            const acceptance = (activeInterview.acceptance ?? []).map(stripTrailingSentencePunctuation).filter(Boolean);
            const taskAtoms = acceptance.length > 0 ? acceptance : decomposeFeatureRequestToTasks(activeInterview.originalRequest);
            const newTasks = taskAtoms.map((item) => makeTask({
              id: normalizeTaskId(n++),
              title: `Implement: ${item}`,
              doneWhen: gates,
              labels: ["feature", "backlog"],
              acceptance: [item],
              ...(uxNotes ? { notes: [uxNotes] } : {}),
            }));

            const request = [
              activeInterview.originalRequest,
              acceptance.length > 0 ? `\nAcceptance:\n${acceptance.map((a) => `- ${a}`).join("\n")}` : "",
              constraints.length > 0 ? `\nConstraints / non-goals:\n${constraints.map((c) => `- ${c}`).join("\n")}` : "",
              uxNotes ? `\nUX notes:\n${uxNotes}` : "",
            ]
              .join("\n")
              .trim();

            prd = {
              ...prd,
              tasks: [...(prd.tasks ?? []), ...newTasks],
              backlog: {
                ...prd.backlog,
                featureRequests: [
                  ...prd.backlog.featureRequests,
                  {
                    id: backlogId,
                    title: compactIdea(activeInterview.originalRequest),
                    request,
                    createdAt: nowIso(),
                    status: "planned",
                    taskIds: newTasks.map((t) => t.id),
                  },
                ],
              },
            };
            await writePrdJson(repoRoot, prd);
            await writeRunState(repoRoot, { ...runState, featureAddInterview: undefined, updatedAt: nowIso() });

            return [
              `Feature added: ${backlogId}`,
              `New tasks: ${newTasks.length}`,
              `Task IDs: ${newTasks.map((t) => t.id).join(", ")}`,
              `Next: /mario-devx:run 1`,
            ].join("\n");
          }
        }

        const backlogId = nextBacklogId(prd);
        const taskAtoms = decomposeFeatureRequestToTasks(feature);
        const gates = prd.verificationPolicy?.globalGates?.length
          ? prd.verificationPolicy.globalGates
          : prd.qualityGates;
        const startN = nextTaskOrdinal(prd.tasks ?? []);
        let n = startN;
        const newTasks = taskAtoms.map((item) => makeTask({
          id: normalizeTaskId(n++),
          title: `Implement: ${item}`,
          doneWhen: gates,
          labels: ["feature", "backlog"],
          acceptance: [item],
        }));
        prd = {
          ...prd,
          tasks: [...(prd.tasks ?? []), ...newTasks],
          backlog: {
            ...prd.backlog,
            featureRequests: [
              ...prd.backlog.featureRequests,
              {
                id: backlogId,
                title: compactIdea(feature),
                request: feature,
                createdAt: nowIso(),
                status: "planned",
                taskIds: newTasks.map((t) => t.id),
              },
            ],
          },
        };
        await writePrdJson(repoRoot, prd);
        return [
          `Feature added: ${backlogId}`,
          `New tasks: ${newTasks.length}`,
          `Task IDs: ${newTasks.map((t) => t.id).join(", ")}`,
          `Next: /mario-devx:run 1`,
        ].join("\n");
      },
    }),

    mario_devx_replan: tool({
      description: "Rebuild open-task plan from backlog",
      args: {},
      async execute(_args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }
        await ensureMario(repoRoot, false);
        let prd = await ensurePrd(repoRoot);
        const replanCandidates = prd.backlog.featureRequests.filter((f) => f.status === "open" || f.status === "planned");
        const gates = prd.verificationPolicy?.globalGates?.length
          ? prd.verificationPolicy.globalGates
          : prd.qualityGates;
        let n = nextTaskOrdinal(prd.tasks ?? []);
        const generated: PrdTask[] = [];

        const normalizedMustHave = normalizeMustHaveFeatureAtoms(prd.product.mustHaveFeatures);
        const existingFeatureTitles = new Set(
          (prd.tasks ?? [])
            .filter((t) => (t.labels ?? []).includes("feature") && t.status !== "cancelled")
            .map((t) => t.title.replace(/^Implement:\s*/i, "").trim()),
        );
        const regeneratedFromMustHave = normalizedMustHave
          .filter((atom) => !existingFeatureTitles.has(atom))
          .map((atom) => makeTask({
            id: normalizeTaskId(n++),
            title: `Implement: ${atom}`,
            doneWhen: gates,
            labels: ["feature", "replan"],
            acceptance: [atom],
          }));
        generated.push(...regeneratedFromMustHave);

        const updatedBacklog = prd.backlog.featureRequests.map((f) => {
          if (f.status === "implemented") return f;
          if (f.status === "planned" && Array.isArray(f.taskIds) && f.taskIds.length > 0) return f;
          const atoms = decomposeFeatureRequestToTasks(f.request);
          const tasks = atoms.map((atom) => makeTask({
            id: normalizeTaskId(n++),
            title: `Implement: ${atom}`,
            doneWhen: gates,
            labels: ["feature", "backlog"],
            acceptance: [atom],
          }));
          generated.push(...tasks);
          return {
            ...f,
            status: "planned" as const,
            taskIds: tasks.map((t) => t.id),
          };
        });
        prd = {
          ...prd,
          tasks: [
            ...(prd.tasks ?? []).map((t) => (malformedFeatureTaskIds.has(t.id) ? { ...t, status: "cancelled" as const } : t)),
            ...generated,
          ],
          backlog: { ...prd.backlog, featureRequests: updatedBacklog },
        };
        await writePrdJson(repoRoot, prd);
        if (replanCandidates.length === 0 && malformedFeatureTaskIds.size === 0 && generated.length === 0) {
          return "No backlog items to replan.";
        }
        return [
          `Replan complete.`,
          `Backlog items considered: ${replanCandidates.length}`,
          `Malformed feature tasks cancelled: ${malformedFeatureTaskIds.size}`,
          `New tasks: ${generated.length}`,
        ].join("\n");
      },
    }),

    mario_devx_status: tool({
      description: "Show mario-devx status",
      args: {},
      async execute(_args, context: ToolContext) {
        await ensureMario(repoRoot, false);
        const ws = await ensureWorkSession(ctx, repoRoot, context.agent);
        const run = await readRunState(repoRoot);
        const prd = await ensurePrd(repoRoot);
        const nextTask = getNextPrdTask(prd);
        const currentTask = run.currentPI ? (prd.tasks ?? []).find((t) => t.id === run.currentPI) : null;
        const focusTask = currentTask ?? nextTask;

        const next =
          run.status === "DOING"
            ? "A run is in progress. Wait for it to finish, then rerun /mario-devx:status."
            : run.status === "BLOCKED"
              ? focusTask?.lastAttempt?.judge
                ? "Fix the listed next actions, then run /mario-devx:run 1."
                : "A task is blocked but has no lastAttempt. Rerun /mario-devx:run 1 to regenerate evidence."
              : prd.wizard.status !== "completed"
                ? "Run /mario-devx:new to finish the PRD wizard."
                : nextTask
                  ? `Run /mario-devx:run 1 to execute ${nextTask.id}.`
                  : "No remaining open tasks.";

        await notifyControlSession(
          ctx,
          context.sessionID,
          `mario-devx status: work session ${ws.sessionId}.`,
        );

        return [
          `Iteration: ${run.iteration}`,
          `Work session: ${ws.sessionId}`,
          `Run state: ${run.status} (${run.phase})${run.currentPI ? ` ${run.currentPI}` : ""}`,
          `PRD wizard: ${prd.wizard.status}${prd.wizard.status !== "completed" ? ` (${prd.wizard.step}/${prd.wizard.totalSteps})` : ""}`,
          `Backlog open: ${prd.backlog.featureRequests.filter((f) => f.status === "open").length}`,
          focusTask
            ? `Focus task: ${focusTask.id} (${focusTask.status}) - ${focusTask.title}`
            : "Focus task: (none)",
          focusTask?.lastAttempt?.judge
            ? `Last verdict: ${focusTask.lastAttempt.judge.status} (exit=${focusTask.lastAttempt.judge.exitSignal})`
            : "Last verdict: (none)",
          "",
          `Next: ${next}`,
        ].join("\n");
      },
    }),

    mario_devx_doctor: tool({
      description: "Check mario-devx health",
      args: {},
      async execute() {
        await ensureMario(repoRoot, false);
        return runDoctor(ctx, repoRoot);
      },
    }),

  };
};
