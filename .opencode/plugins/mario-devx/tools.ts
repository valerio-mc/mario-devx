import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { readTextIfExists, writeText } from "./fs";
import { buildPrompt } from "./prompt";
import { ensureMario, bumpIteration, readWorkSessionState, readRunState, writeRunState } from "./state";

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
  compactIdea,
  deriveWizardStep,
  extractStyleReferencesFromText,
  hasMeaningfulList,
  hasNonEmpty,
  isPrdComplete,
  mergeStyleReferences,
  normalizeStyleReferences,
  normalizeTextArray,
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
import {
  LIMITS,
  LLM_TAGS,
  RUN_STATE,
  TASK_STATUS,
  TIMEOUTS,
  VERIFICATION,
  WIZARD_REQUIREMENTS,
} from "./config";

type ToolContext = {
  sessionID?: string;
  agent?: string;
};

type PluginContext = Parameters<Plugin>[0];

const nowIso = (): string => new Date().toISOString();

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

/**
 * Updates the heartbeat timestamp in the run lock file.
 * 
 * BACKPRESSURE: This is the core of the backpressure system. The lock file
 * acts as a heartbeat - if we can't update it (disk full, permissions, etc.),
 * execution stops immediately. This prevents:
 * - Runaway processes
 * - Multiple concurrent runs
 * - Silent failures
 * 
 * Called at checkpoints throughout task execution.
 * 
 * SAFETY: This function now checks that the lock file belongs to the current
 * process before updating, preventing race conditions where multiple processes
 * could overwrite each other's heartbeats.
 */
const heartbeatRunLock = async (repoRoot: string): Promise<boolean> => {
  const lockPath = runLockPath(repoRoot);
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number; heartbeatAt?: string };
    
    // Verify this lock belongs to the current process
    if (parsed.pid !== process.pid) {
      console.error(`[mario-devx] Heartbeat failed: lock belongs to pid ${parsed.pid}, current pid is ${process.pid}`);
      return false;
    }
    
    // Atomic write with current PID verification
    const next = { ...parsed, heartbeatAt: nowIso() };
    await writeFile(lockPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
    return true;
  } catch (err) {
    console.error("[mario-devx] Heartbeat update failed:", err instanceof Error ? err.message : String(err));
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
const repairPlanning = (existing: PrdJson) => ({
  decompositionStrategy: hasNonEmpty(existing.planning?.decompositionStrategy)
    ? existing.planning!.decompositionStrategy
    : "Split features into smallest independently verifiable tasks.",
  granularityRules: Array.isArray(existing.planning?.granularityRules)
    ? existing.planning!.granularityRules
    : ["Each task should fit in one focused iteration.", "Each task must include explicit acceptance criteria."],
  stopWhen: Array.isArray(existing.planning?.stopWhen)
    ? existing.planning!.stopWhen
    : ["All must-have features are mapped to tasks.", "All tasks have deterministic verification."],
});

const repairVerificationPolicy = (existing: PrdJson) => ({
  globalGates: Array.isArray(existing.verificationPolicy?.globalGates)
    ? existing.verificationPolicy!.globalGates
    : (Array.isArray(existing.qualityGates) ? existing.qualityGates : []),
  taskGates: (existing.verificationPolicy?.taskGates && typeof existing.verificationPolicy.taskGates === "object")
    ? existing.verificationPolicy!.taskGates
    : {},
  uiPolicy: existing.verificationPolicy?.uiPolicy === "required"
    ? "required"
    : existing.verificationPolicy?.uiPolicy === "off"
      ? "off"
      : "best_effort",
});

const repairUi = (existing: PrdJson) => ({
  designSystem: existing.ui?.designSystem ?? null,
  styleReferenceMode: existing.ui?.styleReferenceMode === "url"
    ? "url"
    : existing.ui?.styleReferenceMode === "screenshot"
      ? "screenshot"
      : "mixed",
  styleReferences: Array.isArray(existing.ui?.styleReferences) ? existing.ui!.styleReferences : [],
  visualDirection: typeof existing.ui?.visualDirection === "string" ? existing.ui!.visualDirection : "",
  uxRequirements: Array.isArray(existing.ui?.uxRequirements) ? existing.ui!.uxRequirements : [],
});

const repairDocs = (existing: PrdJson) => ({
  readmeRequired: typeof existing.docs?.readmeRequired === "boolean" ? existing.docs!.readmeRequired : true,
  readmeSections: Array.isArray(existing.docs?.readmeSections)
    ? existing.docs!.readmeSections
    : ["Overview", "Tech Stack", "Setup", "Environment Variables", "Scripts", "Usage"],
});

const repairProduct = (existing: PrdJson) => ({
  targetUsers: Array.isArray(existing.product?.targetUsers) ? existing.product!.targetUsers : [],
  userProblems: Array.isArray(existing.product?.userProblems) ? existing.product!.userProblems : [],
  mustHaveFeatures: Array.isArray(existing.product?.mustHaveFeatures) ? existing.product!.mustHaveFeatures : [],
  nonGoals: Array.isArray(existing.product?.nonGoals) ? existing.product!.nonGoals : [],
  successMetrics: Array.isArray(existing.product?.successMetrics) ? existing.product!.successMetrics : [],
  constraints: Array.isArray(existing.product?.constraints) ? existing.product!.constraints : [],
});

const repairTasks = (existing: PrdJson) => 
  Array.isArray(existing.tasks)
    ? existing.tasks.map((task) => ({
        ...task,
        notes: Array.isArray(task.notes)
          ? task.notes.map((note) => note.replaceAll("__tmp_next", "tmp-next").replaceAll("__tmp_vite", "tmp-vite"))
          : task.notes,
      }))
    : [];

const ensurePrd = async (repoRoot: string): Promise<PrdJson> => {
  const existing = await readPrdJsonIfExists(repoRoot);
  if (existing) {
    const createdAt = existing.meta?.createdAt?.trim() ? existing.meta.createdAt : nowIso();
    const repaired: PrdJson = {
      ...existing,
      meta: { ...existing.meta, createdAt },
      wizard: {
        ...existing.wizard,
        totalSteps: Math.max(existing.wizard?.totalSteps ?? 0, WIZARD_REQUIREMENTS.TOTAL_STEPS),
      },
      version: 4,
      uiVerificationRequired: typeof existing.uiVerificationRequired === "boolean" ? existing.uiVerificationRequired : null,
      planning: repairPlanning(existing),
      verificationPolicy: repairVerificationPolicy(existing),
      ui: repairUi(existing),
      docs: repairDocs(existing),
      backlog: {
        featureRequests: Array.isArray(existing.backlog?.featureRequests) ? existing.backlog.featureRequests : [],
      },
      tasks: repairTasks(existing),
      product: repairProduct(existing),
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

const seedTasksFromPrd = async (repoRoot: string, prd: PrdJson, pluginCtx: PluginContext): Promise<PrdJson> => {
  if (Array.isArray(prd.tasks) && prd.tasks.length > 0) {
    return prd;
  }
  /**
   * LLM-driven task generation from PRD
   * 
   * ARCHITECTURE: Instead of hardcoded task templates (always scaffold → quality → features),
   * we ask the LLM to analyze the PRD and generate an optimal task plan.
   * 
   * Benefits:
   * - Tasks tailored to specific project needs
   * - Intelligent dependency ordering
   * - Appropriate task granularity
   * - Considers platform, framework, and complexity
   */
  const ws = await ensureWorkSession(pluginCtx, repoRoot, { agent: undefined });
  const taskGenPrompt = [
    "You are mario-devx's task planner.",
    "Generate an optimal task breakdown from this PRD.",
    "",
    "PRD:",
    JSON.stringify(prd, null, 2),
    "",
    "Instructions:",
    "1. Analyze the PRD to understand project type, platform, and requirements",
    "2. Generate 5-15 implementation tasks",
    "3. Include foundation tasks (scaffold, quality setup) if needed",
    "4. Break must-have features into implementable tasks",
    "5. Set appropriate dependencies between tasks",
    "6. Tasks should be independently verifiable",
    "",
    "Task schema:",
    '{"id": "T-XXXX", "title": "string", "doneWhen": ["commands"], "labels": ["scaffold"|"quality"|"docs"|"feature"], "acceptance": ["criteria"], "dependsOn": ["T-XXXX"], "notes": ["strings"]}',
    "",
    "Return format:",
    "<TASK_JSON>",
    '{"tasks": [...]}',
    "</TASK_JSON>",
  ].join("\n");
  
  console.log("[mario-devx] Generating tasks from PRD via LLM...");
  const taskResponse = await pluginCtx.client.session.prompt({
    path: { id: ws.sessionId },
    body: { parts: [{ type: "text", text: taskGenPrompt }] },
  });
  
  const taskText = extractTextFromPromptResponse(taskResponse);
  const taskMatch = taskText.match(/<TASK_JSON>([\s\S]*?)<\/TASK_JSON>/i);
  
  let tasks: PrdTask[];
  if (taskMatch) {
    try {
      const parsed = JSON.parse(taskMatch[1].trim());
      tasks = parsed.tasks?.map((t: any, idx: number) => makeTask({
        id: t.id || normalizeTaskId(idx + 1),
        title: t.title,
        doneWhen: t.doneWhen || prd.qualityGates || [],
        labels: t.labels || ["feature"],
        acceptance: t.acceptance || [t.title],
        dependsOn: t.dependsOn,
        notes: t.notes,
      })) || [];
      console.log(`[mario-devx] LLM generated ${tasks.length} tasks`);
    } catch (err) {
      console.error("[mario-devx] Failed to parse LLM task generation, using fallback:", err);
      tasks = generateFallbackTasks(prd);
    }
  } else {
    console.error("[mario-devx] No <TASK_JSON> found in LLM response, using fallback");
    tasks = generateFallbackTasks(prd);
  }
  
  return {
    ...prd,
    tasks,
    verificationPolicy: {
      ...prd.verificationPolicy,
      globalGates: prd.qualityGates || [],
    },
  };
};

/**
 * Fallback task generation when LLM fails
 * Simple linear progression: scaffold → quality → features
 */
const generateFallbackTasks = (prd: PrdJson): PrdTask[] => {
  const tasks: PrdTask[] = [];
  let n = 1;
  const doneWhen = prd.qualityGates || [];
  
  // T-0001: Scaffold
  tasks.push(makeTask({
    id: normalizeTaskId(n++),
    title: `Scaffold project baseline: ${compactIdea(prd.idea || "project")}`,
    doneWhen: [],
    labels: ["scaffold", "foundation"],
    acceptance: ["Project skeleton exists"],
  }));
  
  // T-0002: Quality (if gates defined)
  if (doneWhen.length > 0) {
    tasks.push(makeTask({
      id: normalizeTaskId(n++),
      title: "Setup quality pipeline",
      doneWhen,
      dependsOn: ["T-0001"],
      labels: ["quality", "foundation"],
      acceptance: ["All quality gates pass"],
    }));
  }
  
  // Feature tasks
  for (const feature of prd.product.mustHaveFeatures || []) {
    tasks.push(makeTask({
      id: normalizeTaskId(n++),
      title: `Implement: ${feature}`,
      doneWhen,
      labels: ["feature"],
      acceptance: [feature],
    }));
  }
  
  return tasks;
};

const formatReasonCode = (code: string): string => `ReasonCode: ${code}`;

/**
 * Generates the PRD interview prompt for the LLM.
 * 
 * ARCHITECTURE: This is the core of the LLM-driven wizard. Instead of hardcoded
 * field tracking and question selection, we:
 * 1. Dump the entire PRD state to the LLM
 * 2. Ask the LLM to analyze what's missing
 * 3. Let the LLM decide what question to ask next
 * 4. Parse JSON response for structured updates
 * 
 * This eliminates the need for:
 * - firstMissingField() - 20 lines of conditionals
 * - fallbackQuestion() - 40 lines of switch/case
 * - deriveWizardStep() - complex step tracking
 * 
 * The LLM has full context and makes intelligent decisions about what to ask.
 */
const interviewPrompt = (prd: PrdJson, input: string): string => {
  return [
    "You are mario-devx's PRD interviewer.",
    "Conduct a deep PRD interview by analyzing the current state and asking ONE high-leverage question.",
    "You must return BOTH:",
    "1) a JSON envelope between <MARIO_JSON> tags",
    "2) the next question between <MARIO_QUESTION> tags",
    "",
    "Current PRD state:",
    JSON.stringify(prd, null, 2),
    "",
    "User answer:",
    input,
    "",
    "Required fields before done=true:",
    "- idea: one-line project description",
    "- platform: web|api|cli|library",
    "- frontend: true|false",
    "- uiVerificationRequired: true|false (only if frontend=true)",
    "- ui.designSystem: none|tailwind|shadcn|custom (only if frontend=true)",
    "- ui.visualDirection: string (only if frontend=true)",
    "- ui.uxRequirements: string[] (only if frontend=true)",
    "- docs.readmeRequired: true|false",
    "- docs.readmeSections: string[] (only if readmeRequired=true)",
    "- language: typescript|python|go|rust|other",
    "- framework: string",
    "- product.targetUsers: string[]",
    "- product.userProblems: string[]",
    "- product.mustHaveFeatures: string[] (at least 3)",
    "- product.nonGoals: string[]",
    "- product.successMetrics: string[]",
    "- product.constraints: string[]",
    "- qualityGates: string[] (at least 2 commands)",
    "",
    "Instructions:",
    "1. Analyze the Current PRD state above",
    "2. Identify which required fields are still missing or incomplete",
    "3. Ask ONE concise question to fill the most important missing field",
    "4. Extract any updates from the user's answer and include them in the updates object",
    "5. Set done=true only when ALL required fields are present and valid",
    "",
    "Rules for questions:",
    "- Ask direct natural-language questions (no A/B/C/D options)",
    "- Keep questions short (max 22 words) and concrete",
    "- For booleans, ask yes/no in plain language",
    "- Don't re-ask fields that are already complete",
    "- Ask about ONE field at a time",
    "",
    "Envelope schema:",
    '{"done": boolean, "updates": {...}, "next_question": string}',
    "",
    "Return format:",
    "<MARIO_JSON>",
    '{"done":false,"updates":{},"next_question":"Your question here"}',
    "</MARIO_JSON>",
    "<MARIO_QUESTION>",
    "Your question here",
    "</MARIO_QUESTION>",
  ].join("\n");
};

/**
 * Parses LLM interview response to extract structured JSON envelope.
 * 
 * Expected format:
 * <MARIO_JSON>
 * {"done": boolean, "updates": {...}, "next_question": string}
 * </MARIO_JSON>
 * <MARIO_QUESTION>
 * Your question here
 * </MARIO_QUESTION>
 * 
 * The envelope contains:
 * - done: Whether the PRD is complete
 * - updates: Field updates extracted from user's answer
 * - next_question: What to ask next (null if done)
 */
const parseInterviewResponse = (text: string): { envelope: InterviewEnvelope | null; question: string | null; error?: string } => {
  const jsonMatch = text.match(/<MARIO_JSON>([\s\S]*?)<\/MARIO_JSON>/i);
  const questionMatch = text.match(/<MARIO_QUESTION>([\s\S]*?)<\/MARIO_QUESTION>/i);
  
  if (!jsonMatch) {
    return { 
      envelope: null, 
      question: questionMatch?.[1]?.trim() ?? null,
      error: "No <MARIO_JSON> tags found in response" 
    };
  }
  
  try {
    const envelope = JSON.parse((jsonMatch[1] ?? "").trim()) as InterviewEnvelope;
    
    // Validate envelope structure
    if (typeof envelope.done !== "boolean") {
      return { 
        envelope: null, 
        question: questionMatch?.[1]?.trim() ?? null,
        error: "Invalid envelope: 'done' field must be boolean" 
      };
    }
    
    return { envelope, question: questionMatch?.[1]?.trim() ?? null };
  } catch (err) {
    return { 
      envelope: null, 
      question: questionMatch?.[1]?.trim() ?? null,
      error: `JSON parse error: ${err instanceof Error ? err.message : String(err)}` 
    };
  }
};

/**
 * Applies interview updates to the PRD with automatic normalization.
 * 
 * ARCHITECTURE: Instead of 40+ explicit IF statements checking each field,
 * we use a recursive merge function that:
 * 1. Automatically trims strings
 * 2. Normalizes arrays (deduplicates, filters empty)
 * 3. Deep merges objects
 * 4. Derives dependent fields (platform → frontend, etc.)
 * 
 * This eliminates the massive switch statement that previously handled
 * each field individually.
 */
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

/**
 * Parses verifier output from the LLM.
 * 
 * ARCHITECTURE: Previously used 100+ lines of regex/state machine to parse
 * text format like "Status: PASS\nEXIT_SIGNAL: true\nReason:\n- ...".
 * 
 * Now expects structured JSON:
 * <VERIFIER_JSON>
 * {"status": "PASS|FAIL", "reason": [...], "nextActions": [...]}
 * </VERIFIER_JSON>
 * 
 * This is more reliable and eliminates complex text parsing.
 */
const parseJudgeAttemptFromText = (text: string): PrdJudgeAttempt => {
  // Try JSON format first
  const jsonMatch = text.match(/<VERIFIER_JSON>([\s\S]*?)<\/VERIFIER_JSON>/i);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (parsed.status && (parsed.status === "PASS" || parsed.status === "FAIL")) {
        console.log(`[mario-devx] Verifier: ${parsed.status} - ${Array.isArray(parsed.reason) ? parsed.reason.length : 0} reasons`);
        return {
          status: parsed.status,
          exitSignal: parsed.status === "PASS",
          reason: Array.isArray(parsed.reason) ? parsed.reason : [String(parsed.reason || "No reason provided")],
          nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions : ["Fix issues and rerun /mario-devx:run 1."],
          rawText: text,
        };
      }
    } catch (err) {
      console.error("[mario-devx] Verifier JSON parse error:", err);
      // Fall through to text parsing
    }
  }
  
  // Fallback: simple text parsing for backwards compatibility
  const lines = text.split(/\r?\n/);
  let status: "PASS" | "FAIL" = "FAIL";
  let statusExplicit = false;
  const reason: string[] = [];
  const nextActions: string[] = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    const statusMatch = trimmed.match(/^Status:\s*(PASS|FAIL)/i);
    if (statusMatch) {
      status = statusMatch[1].toUpperCase() as "PASS" | "FAIL";
      statusExplicit = true;
      continue;
    }
    
    if (trimmed.match(/^(Reason|Reasons):/i)) continue;
    if (trimmed.match(/^(Next|Next actions|Next steps):/i)) continue;
    
    const content = trimmed.replace(/^[-\s]+/, "").trim();
    if (!content) continue;
    
    if (trimmed.startsWith("-") && nextActions.length === 0) {
      reason.push(content);
    } else if (trimmed.startsWith("-")) {
      nextActions.push(content);
    } else if (reason.length === 0) {
      reason.push(content);
    }
  }
  
  return {
    status,
    exitSignal: status === "PASS",
    reason: reason.length > 0 ? reason : [statusExplicit ? "Task completed" : "Could not parse verifier output"],
    nextActions: nextActions.length > 0 ? nextActions : ["Fix issues and rerun /mario-devx:run 1."],
    rawText: text,
  };
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

        const cachedQuestion = prd.wizard.answers?.[LAST_QUESTION_KEY];
        if (!hasAnswer && cachedQuestion) {
          return [
            "PRD interview",
            cachedQuestion,
            "Reply with your answer in natural language.",
          ].join("\n");
        }

        const ws = await ensureWorkSession(ctx, repoRoot, context.agent);
        const interviewInput = hasAnswer ? rawInput : "Start the interview and ask the first question.";
        const interviewResponse = await ctx.client.session.prompt({
          path: { id: ws.sessionId },
          body: {
            ...(context.agent ? { agent: context.agent } : {}),
            parts: [{ type: "text", text: interviewPrompt(prd, interviewInput) }],
          },
        });
        const text = extractTextFromPromptResponse(interviewResponse);
        const { envelope, question, error: parseError } = parseInterviewResponse(text);

        if (parseError) {
          console.error("[mario-devx] Interview parsing error:", parseError);
          return [
            "PRD interview",
            "I had trouble understanding that response. Could you please rephrase?",
            "Reply with your answer in natural language.",
          ].join("\n");
        }

        if (!envelope) {
          return [
            "PRD interview",
            question || "I didn't catch that. Could you try again?",
            "Reply with your answer in natural language.",
          ].join("\n");
        }

        if (envelope.updates) {
          prd = applyInterviewUpdates(prd, envelope.updates);
        }

        const done = isPrdComplete(prd);
        const finalQuestion = (question && question.trim()) || envelope?.next_question?.trim() || "What else should we capture?";

        prd = {
          ...prd,
          wizard: {
            ...prd.wizard,
            step: done ? WIZARD_REQUIREMENTS.TOTAL_STEPS : 0,
            totalSteps: WIZARD_REQUIREMENTS.TOTAL_STEPS,
            status: done ? "completed" : "in_progress",
            lastQuestionId: done ? "done" : "interview",
            answers: {
              ...prd.wizard.answers,
              ...(hasAnswer ? { [`turn-${Date.now()}`]: rawInput } : {}),
              [LAST_QUESTION_KEY]: finalQuestion,
            },
          },
        };

        if (done) {
          prd = await seedTasksFromPrd(repoRoot, prd, ctx);
          prd = {
            ...prd,
            wizard: {
              ...prd.wizard,
              status: "completed",
              step: WIZARD_REQUIREMENTS.TOTAL_STEPS,
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
        const step = done ? WIZARD_REQUIREMENTS.TOTAL_STEPS : prd.wizard.step;
        return [
          `PRD interview (${step}/${WIZARD_REQUIREMENTS.TOTAL_STEPS})`,
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
          && (Date.now() - Date.parse(previousRun.lastRunAt)) <= TIMEOUTS.RUN_DUPLICATE_WINDOW_MS
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
            console.log(`[mario-devx] Starting task ${task.id}: ${task.title}`);

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

                if (repairAttempts > 0 && (elapsedMs >= TIMEOUTS.MAX_TASK_REPAIR_MS || noProgressStreak >= LIMITS.MAX_NO_PROGRESS_STREAK)) {
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
          const judge = parseJudgeAttemptFromText(verifierText);
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

           const isPass = judge.status === "PASS" && judge.exitSignal;
           prd = setPrdTaskStatus(prd, task.id, isPass ? "completed" : "blocked");
           prd = setPrdTaskLastAttempt(prd, task.id, lastAttempt);
           await writePrdJson(repoRoot, prd);

           if (isPass) {
             completed += 1;
             console.log(`[mario-devx] Task ${task.id} completed (${completed}/${maxItems})`);
             await showToast(ctx, `Run: completed ${task.id} (${completed}/${maxItems})`, "success");
           } else {
             console.log(`[mario-devx] Task ${task.id} blocked: ${judge.reason?.[0] ?? "No reason provided"}`);
             await showToast(ctx, `Run stopped: verifier failed on ${task.id}`, "warning");
             break;
           }
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

        const ws = await ensureWorkSession(ctx, repoRoot, context.agent);
        const runState = await readRunState(repoRoot);
        
        /**
         * LLM-driven feature interview
         * 
         * ARCHITECTURE: Replaced the old 3-step state machine with a single
         * LLM prompt that:
         * 1. Analyzes the feature request
         * 2. Asks follow-up questions if vague
         * 3. Decomposes into atomic tasks when ready
         * 
         * Old approach: Hardcoded step 1 → step 2 → step 3 with validation
         * New approach: LLM decides what's needed and returns structured JSON
         * 
         * This eliminates 120+ lines of state machine code.
         */
        const featurePrompt = [
          "You are mario-devx's feature interviewer.",
          "Help the user break down a feature request into implementable tasks.",
          "",
          "Current feature request:",
          feature,
          "",
          "Quality gates for this project:",
          JSON.stringify(prd.qualityGates ?? []),
          "",
          "Instructions:",
          "- Ask follow-up questions if the feature is vague or needs clarification",
          "- Once you have enough detail, return a JSON envelope with the breakdown",
          "- Decompose the feature into 2-5 atomic implementation tasks",
          "- Each task should be independently verifiable",
          "",
          "Return format:",
          "<FEATURE_JSON>",
          '{"ready": boolean, "tasks": string[], "acceptanceCriteria": string[], "constraints": string[], "uxNotes": string, "next_question": string | null}',
          "</FEATURE_JSON>",
          "",
          "If ready=false, ask a follow-up question in next_question.",
          "If ready=true, provide the breakdown and set next_question=null.",
        ].join("\n");
        
        const featureResponse = await ctx.client.session.prompt({
          path: { id: ws.sessionId },
          body: {
            ...(context.agent ? { agent: context.agent } : {}),
            parts: [{ type: "text", text: featurePrompt }],
          },
        });
        
        const responseText = extractTextFromPromptResponse(featureResponse);
        const jsonMatch = responseText.match(/<FEATURE_JSON>([\s\S]*?)<\/FEATURE_JSON>/i);
        
        if (!jsonMatch) {
          console.error("[mario-devx] Feature interview: No <FEATURE_JSON> tags found in LLM response");
          console.error("[mario-devx] Raw response:", responseText.substring(0, 500));
          return "Error: Could not parse feature breakdown. The LLM response was malformed. Please try again with more detail.";
        }
        
        let envelope: {
          ready: boolean;
          tasks?: string[];
          acceptanceCriteria?: string[];
          constraints?: string[];
          uxNotes?: string;
          next_question?: string | null;
        };
        
        try {
          envelope = JSON.parse(jsonMatch[1].trim());
        } catch (err) {
          console.error("[mario-devx] Feature interview: JSON parse error:", err);
          console.error("[mario-devx] Raw JSON:", jsonMatch[1].trim().substring(0, 500));
          return `Error: Invalid JSON in feature response: ${err instanceof Error ? err.message : String(err)}. Please try again.`;
        }
        
        // If not ready, ask follow-up question
        if (!envelope.ready || envelope.next_question) {
          return [
            "Feature interview",
            envelope.next_question || "Please provide more detail about this feature.",
            "Reply with your answer in natural language.",
          ].join("\n");
        }
        
        // Create tasks from LLM breakdown
        const backlogId = nextBacklogId(prd);
        const gates = prd.verificationPolicy?.globalGates?.length
          ? prd.verificationPolicy.globalGates
          : prd.qualityGates;
        const startN = nextTaskOrdinal(prd.tasks ?? []);
        let n = startN;
        
        const taskAtoms = envelope.tasks?.length ? envelope.tasks : [feature];
        const newTasks = taskAtoms.map((item) => makeTask({
          id: normalizeTaskId(n++),
          title: `Implement: ${item}`,
          doneWhen: gates,
          labels: ["feature", "backlog"],
          acceptance: envelope.acceptanceCriteria?.length ? envelope.acceptanceCriteria : [item],
          ...(envelope.uxNotes ? { notes: [envelope.uxNotes] } : {}),
        }));
        
        const request = [
          feature,
          envelope.acceptanceCriteria?.length ? `\nAcceptance:\n${envelope.acceptanceCriteria.map((a) => `- ${a}`).join("\n")}` : "",
          envelope.constraints?.length ? `\nConstraints:\n${envelope.constraints.map((c) => `- ${c}`).join("\n")}` : "",
          envelope.uxNotes ? `\nUX notes:\n${envelope.uxNotes}` : "",
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
                title: compactIdea(feature),
                request: request || feature,
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
      description: "Rebuild open-task plan from backlog using LLM",
      args: {},
      async execute(_args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }
        await ensureMario(repoRoot, false);
        let prd = await ensurePrd(repoRoot);
        const replanCandidates = prd.backlog.featureRequests.filter((f) => f.status === "open" || f.status === "planned");
        
        if (replanCandidates.length === 0) {
          return "No backlog items to replan.";
        }

        /**
         * LLM-driven replan decomposition
         * 
         * ARCHITECTURE: Instead of simple comma-splitting of backlog items,
         * we ask the LLM to intelligently analyze each feature request and
         * suggest a proper task breakdown considering:
         * - Current project context
         * - Existing tasks
         * - Dependencies
         * - Implementation complexity
         */
        const ws = await ensureWorkSession(ctx, repoRoot, context.agent);
        const gates = prd.verificationPolicy?.globalGates?.length
          ? prd.verificationPolicy.globalGates
          : prd.qualityGates;
        
        console.log(`[mario-devx] Replanning ${replanCandidates.length} backlog items via LLM...`);
        
        const replanPrompt = [
          "You are mario-devx's replanning assistant.",
          "Analyze these backlog items and suggest task breakdowns.",
          "",
          "Current PRD:",
          JSON.stringify({
            idea: prd.idea,
            platform: prd.platform,
            framework: prd.framework,
            qualityGates: prd.qualityGates,
          }, null, 2),
          "",
          "Backlog items to replan:",
          replanCandidates.map((f, i) => `${i + 1}. ${f.title}\n${f.request}`).join("\n\n"),
          "",
          "Existing tasks:",
          (prd.tasks || []).filter(t => t.status !== "cancelled").map(t => `- ${t.id}: ${t.title}`).join("\n"),
          "",
          "Instructions:",
          "1. Analyze each backlog item for complexity",
          "2. Break down into 1-5 implementation tasks per item",
          "3. Consider existing tasks to avoid duplication",
          "4. Set appropriate dependencies",
          "5. Suggest doneWhen commands for each task",
          "",
          "Return format:",
          "<REPLAN_JSON>",
          JSON.stringify({
            breakdowns: [
              {
                backlogId: "F-0001",
                tasks: [
                  {
                    title: "Implement feature X part 1",
                    labels: ["feature", "backlog"],
                    doneWhen: ["npm test"],
                    dependsOn: [],
                    acceptance: ["Feature X part 1 works"]
                  }
                ]
              }
            ]
          }, null, 2),
          "</REPLAN_JSON>",
        ].join("\n");
        
        const replanResponse = await ctx.client.session.prompt({
          path: { id: ws.sessionId },
          body: {
            ...(context.agent ? { agent: context.agent } : {}),
            parts: [{ type: "text", text: replanPrompt }],
          },
        });
        
        const replanText = extractTextFromPromptResponse(replanResponse);
        const replanMatch = replanText.match(/<REPLAN_JSON>([\s\S]*?)<\/REPLAN_JSON>/i);
        
        let n = nextTaskOrdinal(prd.tasks ?? []);
        const generated: PrdTask[] = [];
        let updatedBacklog = [...prd.backlog.featureRequests];
        
        if (replanMatch) {
          try {
            const parsed = JSON.parse(replanMatch[1].trim());
            
            for (const breakdown of parsed.breakdowns || []) {
              const backlogItem = replanCandidates.find(f => f.id === breakdown.backlogId);
              if (!backlogItem) continue;
              
              const tasks = (breakdown.tasks || []).map((t: any) => makeTask({
                id: normalizeTaskId(n++),
                title: t.title,
                doneWhen: t.doneWhen || gates,
                labels: t.labels || ["feature", "backlog"],
                acceptance: t.acceptance || [t.title],
                dependsOn: t.dependsOn,
              }));
              
              generated.push(...tasks);
              
              // Update backlog item
              updatedBacklog = updatedBacklog.map(f => 
                f.id === breakdown.backlogId
                  ? { ...f, status: "planned" as const, taskIds: tasks.map(t => t.id) }
                  : f
              );
            }
            
            console.log(`[mario-devx] LLM generated ${generated.length} tasks from ${parsed.breakdowns?.length || 0} backlog items`);
          } catch (err) {
            console.error("[mario-devx] Failed to parse LLM replan response:", err);
            // Fall through to fallback
          }
        }
        
        // Fallback: simple decomposition if LLM fails
        if (generated.length === 0) {
          console.log("[mario-devx] Using fallback replan decomposition");
          for (const f of replanCandidates) {
            if (f.status === "implemented") continue;
            if (f.status === "planned" && Array.isArray(f.taskIds) && f.taskIds.length > 0) continue;
            
            const atoms = decomposeFeatureRequestToTasks(f.request);
            const tasks = atoms.map((atom) => makeTask({
              id: normalizeTaskId(n++),
              title: `Implement: ${atom}`,
              doneWhen: gates,
              labels: ["feature", "backlog"],
              acceptance: [atom],
            }));
            generated.push(...tasks);
            
            updatedBacklog = updatedBacklog.map(bf => 
              bf.id === f.id
                ? { ...bf, status: "planned" as const, taskIds: tasks.map(t => t.id) }
                : bf
            );
          }
        }
        
        prd = {
          ...prd,
          tasks: [
            ...(prd.tasks ?? []),
            ...generated,
          ],
          backlog: { ...prd.backlog, featureRequests: updatedBacklog },
        };
        await writePrdJson(repoRoot, prd);
        
        return [
          `Replan complete.`,
          `Backlog items replanned: ${replanCandidates.length}`,
          `New tasks: ${generated.length}`,
          `Next: /mario-devx:run 1`,
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
