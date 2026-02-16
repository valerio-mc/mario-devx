import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import path from "path";
import { readTextIfExists, writeText } from "./fs";
import { buildPrompt } from "./prompt";
import { ensureMario, bumpIteration, readRunState, writeRunState } from "./state";

import { getRepoRoot } from "./paths";
import {
  ensureT0002QualityBootstrap,
  type GateRunItem,
  hasNodeModules,
  missingPackageScriptForCommand,
  resolveNodeWorkspaceRoot,
  runGateCommands,
} from "./gates";
import {
  hasAgentsKey,
  parseAgentsEnv,
  runUiVerification,
  upsertAgentsKey,
} from "./ui-verify";
import {
  LAST_QUESTION_KEY,
  compactIdea,
  extractStyleReferencesFromText,
  hasNonEmpty,
  isPrdComplete,
  mergeStyleReferences,
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
  normalizeTaskId,
  setPrdTaskLastAttempt,
  setPrdTaskStatus,
} from "./planner";
import {
  ensureWorkSession,
  ensureNotInWorkSession,
  extractTextFromPromptResponse,
  resolvePromptText,
  resetWorkSession,
  setWorkSessionTitle,
  updateRunState,
  waitForSessionIdleStable,
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
  TIMEOUTS,
  WIZARD_REQUIREMENTS,
} from "./config";
import { logError, logInfo, logWarning } from "./errors";
import { createRunId, logEvent, logTaskComplete, logTaskBlocked, logPrdComplete, logReplanComplete, redactForLog } from "./logging";
import { acquireRunLock, heartbeatRunLock, releaseRunLock, runLockPath } from "./run-lock";
import { buildRunSummary } from "./run-report";
import { resolveUiRunSetup } from "./run-ui";
import { RUN_PHASE, type RunExecutionContext, type RunLogMeta, type RunPhaseName } from "./run-types";
import { discoverAgentBrowserCapabilities } from "./agent-browser-capabilities";
import { runShellCommand } from "./shell";

type ToolContext = {
  sessionID?: string;
  agent?: string;
};

type PluginContext = Parameters<Plugin>[0];

const nowIso = (): string => new Date().toISOString();

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

type InterviewTurn = {
  done: boolean;
  question: string | null;
  error?: string;
};

type CompileInterviewEnvelope = {
  updates?: InterviewUpdates;
  next_question?: string;
};

const INTERVIEW_QUESTION_PREFIX = "q-";
const INTERVIEW_ANSWER_PREFIX = "a-";

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
  const ws = await ensureWorkSession(pluginCtx, repoRoot, undefined);
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
  
  logInfo("task-generation", "Generating tasks from PRD via LLM...");
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
      logInfo("task-generation", `LLM generated ${tasks.length} tasks`);
    } catch (err) {
      logError("task-generation", `Failed to parse LLM task generation, using fallback: ${err instanceof Error ? err.message : String(err)}`);
      tasks = generateFallbackTasks(prd);
    }
  } else {
    logError("task-generation", "No <TASK_JSON> found in LLM response, using fallback");
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

const interviewTranscript = (prd: PrdJson): string[] => {
  const entries = Object.entries(prd.wizard.answers ?? {})
    .filter(([key]) => key !== LAST_QUESTION_KEY)
    .sort(([a], [b]) => a.localeCompare(b));

  return entries
    .map(([key, value]) => {
      const text = String(value ?? "").trim();
      if (!text) return null;
      if (key.startsWith(INTERVIEW_QUESTION_PREFIX)) return `Q: ${text}`;
      if (key.startsWith(INTERVIEW_ANSWER_PREFIX) || key.startsWith("turn-")) return `A: ${text}`;
      return `${key}: ${text}`;
    })
    .filter((line): line is string => !!line);
};

const interviewPrompt = (prd: PrdJson, input: string): string => {
  const transcript = interviewTranscript(prd);
  return [
    "You are mario-devx's PRD interviewer.",
    "Ask ONE focused question at a time. Do NOT output JSON.",
    "",
    "Current PRD state:",
    JSON.stringify(prd, null, 2),
    "",
    "Interview transcript so far:",
    transcript.length > 0 ? transcript.join("\n") : "(empty)",
    "",
    "Latest user input:",
    input,
    "",
    "Required fields before completion:",
    "- idea",
    "- platform",
    "- frontend",
    "- uiVerificationRequired if frontend=true",
    "- ui.designSystem/ui.visualDirection/ui.uxRequirements if frontend=true",
    "- docs.readmeRequired/docs.readmeSections",
    "- language/framework",
    "- targetUsers/userProblems",
    "- mustHaveFeatures (>=3)",
    "- nonGoals/successMetrics/constraints",
    "- qualityGates (>=2 commands)",
    "",
    "Output rules (strict):",
    "- Return EXACTLY one line.",
    "- If more information is needed, return ONLY a question ending with '?'.",
    "- If all required fields are complete, return ONLY: DONE",
    "- No explanations, no markdown, no prefixes.",
  ].join("\n");
};

const parseInterviewTurn = (text: string): InterviewTurn => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { done: false, question: null, error: "Empty interviewer response" };
  }

  if (lines.some((line) => /^DONE$/i.test(line))) {
    return { done: true, question: null };
  }

  const normalized = lines
    .map((line) => line.replace(/^question\s*:\s*/i, "").trim())
    .filter((line) => !/^thinking[:\s]/i.test(line));

  const questionLine = [...normalized].reverse().find((line) => line.endsWith("?"))
    ?? [...normalized].reverse().find((line) => line.length > 0)
    ?? null;

  if (!questionLine) {
    return { done: false, question: null, error: "No question found in interviewer response" };
  }

  return { done: false, question: questionLine.endsWith("?") ? questionLine : `${questionLine}?` };
};

const interviewTurnRepairPrompt = (invalidResponse: string): string => {
  return [
    "Your previous response violated the required output format.",
    "Re-output in exactly one line.",
    "Allowed outputs:",
    "- A single question ending with '?'",
    "- DONE (if interview is complete)",
    "Do not include any other text.",
    "Previous invalid response:",
    invalidResponse,
  ].join("\n");
};

const repeatedQuestionRepairPrompt = (previousQuestion: string, latestAnswer: string): string => {
  return [
    "You repeated the same interview question.",
    "Ask a DIFFERENT next question based on the latest answer.",
    "Return exactly one line ending with '?', or DONE.",
    "Previous question:",
    previousQuestion,
    "Latest user answer:",
    latestAnswer,
  ].join("\n");
};

const normalizeQuestionKey = (input: string): string => {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
};

const extractJsonObject = (text: string): string | null => {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
};

const compileInterviewPrompt = (prd: PrdJson): string => {
  const transcript = interviewTranscript(prd);
  return [
    "You are mario-devx's PRD compiler.",
    "Convert the interview transcript into PRD updates.",
    "",
    "Current PRD state:",
    JSON.stringify(prd, null, 2),
    "",
    "Interview transcript:",
    transcript.length > 0 ? transcript.join("\n") : "(empty)",
    "",
    "Return ONLY one JSON object with this shape:",
    '{"updates": { ... }, "next_question": "string"}',
    "Rules:",
    "- updates contains extracted/normalized field values",
    "- next_question is required if required fields remain missing",
    "- no markdown, no prose, JSON only",
  ].join("\n");
};

const parseCompileInterviewResponse = (text: string): { envelope: CompileInterviewEnvelope | null; error?: string } => {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return { envelope: null, error: "No JSON object found in compile response" };
  }
  try {
    const parsed = JSON.parse(jsonText) as CompileInterviewEnvelope;
    if (!parsed || typeof parsed !== "object") {
      return { envelope: null, error: "Compile response is not an object" };
    }
    return { envelope: parsed };
  } catch (err) {
    return { envelope: null, error: `Compile JSON parse error: ${err instanceof Error ? err.message : String(err)}` };
  }
};

const compileRepairPrompt = (invalidResponse: string): string => {
  return [
    "Your previous compile response was invalid.",
    "Return ONLY valid JSON with shape:",
    '{"updates": { ... }, "next_question": "string"}',
    "No markdown and no extra text.",
    "Previous invalid response:",
    invalidResponse,
  ].join("\n");
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
        logInfo("verifier", `${parsed.status} - ${Array.isArray(parsed.reason) ? parsed.reason.length : 0} reasons`);
        return {
          status: parsed.status,
          exitSignal: parsed.status === "PASS",
          reason: Array.isArray(parsed.reason) ? parsed.reason : [String(parsed.reason || "No reason provided")],
          nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions : ["Fix issues and rerun /mario-devx:run 1."],
          rawText: text,
        };
      }
    } catch (err) {
      logError("verifier", `JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
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

const logRunEvent = async (
  ctx: PluginContext,
  repoRoot: string,
  level: "info" | "warn" | "error",
  event: string,
  message: string,
  extra?: Record<string, unknown>,
  runCtx?: RunLogMeta,
): Promise<void> => {
  await logEvent(ctx, repoRoot, {
    level,
    event,
    message,
    ...(runCtx?.runId ? { runId: runCtx.runId } : {}),
    ...(runCtx?.taskId ? { taskId: runCtx.taskId } : {}),
    ...(typeof runCtx?.iteration === "number" ? { iteration: runCtx.iteration } : {}),
    ...(runCtx?.reasonCode ? { reasonCode: runCtx.reasonCode } : {}),
    extra,
  });
};

const logToolEvent = async (
  ctx: PluginContext,
  repoRoot: string,
  level: "info" | "warn" | "error",
  event: string,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> => {
  await logEvent(ctx, repoRoot, {
    level,
    event,
    message,
    extra,
  });
};

const runShellWithFailureLog = async (
  ctx: PluginContext,
  repoRoot: string,
  command: string,
  logMeta: {
    event: string;
    message: string;
    reasonCode?: string;
    runId?: string;
    taskId?: string;
    extra?: Record<string, unknown>;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> => {
  if (!ctx.$) {
    const stderr = "No shell available for command execution.";
    await logRunEvent(
      ctx,
      repoRoot,
      "error",
      logMeta.event,
      logMeta.message,
      {
        command,
        exitCode: 127,
        durationMs: 0,
        stdout: "",
        stderr,
        ...(logMeta.extra ?? {}),
      },
      {
        ...(logMeta.runId ? { runId: logMeta.runId } : {}),
        ...(logMeta.taskId ? { taskId: logMeta.taskId } : {}),
        ...(logMeta.reasonCode ? { reasonCode: logMeta.reasonCode } : {}),
      },
    );
    return { exitCode: 127, stdout: "", stderr, durationMs: 0 };
  }
  const commandResult = await runShellCommand(ctx.$, command);
  const { exitCode, stdout, stderr, durationMs } = commandResult;
  if (exitCode !== 0) {
    await logRunEvent(
      ctx,
      repoRoot,
      "error",
      logMeta.event,
      logMeta.message,
      {
        command,
        exitCode,
        durationMs,
        stdout,
        stderr,
        ...(logMeta.extra ?? {}),
      },
      {
        ...(logMeta.runId ? { runId: logMeta.runId } : {}),
        ...(logMeta.taskId ? { taskId: logMeta.taskId } : {}),
        ...(logMeta.reasonCode ? { reasonCode: logMeta.reasonCode } : {}),
      },
    );
  }
  return { exitCode, stdout, stderr, durationMs };
};

const persistBlockedTaskAttempt = async (opts: {
  ctx: PluginContext;
  repoRoot: string;
  prd: PrdJson;
  task: PrdTask;
  attemptAt: string;
  iteration: number;
  gates: PrdGatesAttempt;
  ui: PrdUiAttempt;
  judge: PrdJudgeAttempt;
  runId: string;
}): Promise<PrdJson> => {
  const { ctx, repoRoot, prd, task, attemptAt, iteration, gates, ui, judge, runId } = opts;
  const lastAttempt: PrdTaskAttempt = {
    at: attemptAt,
    iteration,
    gates,
    ui,
    judge,
  };
  let nextPrd = setPrdTaskStatus(prd, task.id, "blocked");
  nextPrd = setPrdTaskLastAttempt(nextPrd, task.id, lastAttempt);
  await writePrdJson(repoRoot, nextPrd);
  await updateRunState(repoRoot, {
    status: "BLOCKED",
    phase: "run",
    currentPI: task.id,
  });
  await logRunEvent(ctx, repoRoot, "error", "run.blocked.fail-early", `Run blocked on ${task.id}`, {
    taskId: task.id,
    reason: judge.reason?.[0] ?? "Unknown failure",
  }, { runId, taskId: task.id, reasonCode: "TASK_FAIL_EARLY" });
  return nextPrd;
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
          await logToolEvent(ctx, repoRoot, "warn", "new.blocked.work-session", "PRD interview blocked in work session");
          return notInWork.message;
        }

        await ensureMario(repoRoot, false);
        let prd = await ensurePrd(repoRoot);
        const rawInput = (args.idea ?? "").trim();
        await logToolEvent(ctx, repoRoot, "info", "new.start", "PRD interview step started", {
          wizardStatus: prd.wizard.status,
          hasInput: rawInput.length > 0,
          inputLength: rawInput.length,
        });

        if (prd.wizard.status === "completed") {
          await logToolEvent(ctx, repoRoot, "info", "new.noop.completed", "PRD already completed");
          return [
            "PRD wizard: completed.",
            `Edit: ${path.join(repoRoot, ".mario", "prd.json")}`,
            "Next: /mario-devx:run 1",
          ].join("\n");
        }

        const isBootstrapIdea = rawInput.length > 0 && prd.wizard.step === 0 && !hasNonEmpty(prd.idea);
        if (isBootstrapIdea) {
          prd = {
            ...prd,
            idea: rawInput,
          };
        }

        const hasAnswer = rawInput.length > 0 && !isBootstrapIdea;
        if (rawInput.length > 0) {
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

        if (hasAnswer) {
          prd = {
            ...prd,
            wizard: {
              ...prd.wizard,
              answers: {
                ...prd.wizard.answers,
                [`${INTERVIEW_ANSWER_PREFIX}${Date.now()}`]: rawInput,
              },
            },
          };
        }

        const cachedQuestion = prd.wizard.answers?.[LAST_QUESTION_KEY];
        if (!hasAnswer && cachedQuestion) {
          await logToolEvent(ctx, repoRoot, "info", "new.question.cached", "Returning cached interview question");
          return [
            "PRD interview",
            cachedQuestion,
            "Reply with your answer in natural language.",
          ].join("\n");
        }

        const ws = await ensureWorkSession(ctx, repoRoot, undefined);
        const interviewInput = hasAnswer
          ? rawInput
          : (isBootstrapIdea ? `Project idea provided: ${prd.idea}` : "Start the interview and ask the first question.");
        const interviewResponse = await ctx.client.session.prompt({
          path: { id: ws.sessionId },
          body: {
            parts: [{ type: "text", text: interviewPrompt(prd, interviewInput) }],
          },
        });
        const text = await resolvePromptText(ctx, ws.sessionId, interviewResponse, TIMEOUTS.SESSION_IDLE_TIMEOUT_MS);
        let parsedInterview = parseInterviewTurn(text);

        if (parsedInterview.error) {
          logError("interview", `Parsing error: ${parsedInterview.error}`);
          await logToolEvent(ctx, repoRoot, "error", "new.interview.parse-error", "Failed to parse interview turn", {
            error: parsedInterview.error,
          });

          const repairResponse = await ctx.client.session.prompt({
            path: { id: ws.sessionId },
            body: {
              parts: [{ type: "text", text: interviewTurnRepairPrompt(text) }],
            },
          });
          const repairedText = await resolvePromptText(ctx, ws.sessionId, repairResponse, TIMEOUTS.SESSION_IDLE_TIMEOUT_MS);
          const repairedInterview = parseInterviewTurn(repairedText);

          if (!repairedInterview.error) {
            logInfo("interview", "Recovered from malformed interview response after one retry");
            await logToolEvent(ctx, repoRoot, "info", "new.interview.recovered", "Recovered malformed interview response");
            parsedInterview = repairedInterview;
          } else {
            logError("interview", `Retry parsing error: ${repairedInterview.error}`);
            await logToolEvent(ctx, repoRoot, "error", "new.interview.parse-error-retry", "Interview parse retry failed", {
              error: repairedInterview.error,
            });
            const fallbackQuestion = repairedInterview.question || parsedInterview.question || "In one sentence, what are we building?";
            return [
              "PRD interview",
              fallbackQuestion,
              "Reply with your answer in natural language.",
            ].join("\n");
          }
        }

        let done = parsedInterview.done;
        let finalQuestion = parsedInterview.question || "What else should we capture?";

        if (parsedInterview.done) {
          const compileResponse = await ctx.client.session.prompt({
            path: { id: ws.sessionId },
            body: {
              parts: [{ type: "text", text: compileInterviewPrompt(prd) }],
            },
          });
          const compileText = await resolvePromptText(ctx, ws.sessionId, compileResponse, TIMEOUTS.SESSION_IDLE_TIMEOUT_MS);
          let compiled = parseCompileInterviewResponse(compileText);
          if (compiled.error) {
            logError("interview", `Compile parse error: ${compiled.error}`);
            await logToolEvent(ctx, repoRoot, "error", "new.compile.parse-error", "Failed to parse compiled interview envelope", {
              error: compiled.error,
            });
            const repairResponse = await ctx.client.session.prompt({
              path: { id: ws.sessionId },
              body: {
                parts: [{ type: "text", text: compileRepairPrompt(compileText) }],
              },
            });
            const repairedText = await resolvePromptText(ctx, ws.sessionId, repairResponse, TIMEOUTS.SESSION_IDLE_TIMEOUT_MS);
            compiled = parseCompileInterviewResponse(repairedText);
            if (compiled.error) {
              logError("interview", `Compile retry parse error: ${compiled.error}`);
              await logToolEvent(ctx, repoRoot, "error", "new.compile.parse-error-retry", "Compile parse retry failed", {
                error: compiled.error,
              });
            }
          }

          if (compiled.envelope?.updates) {
            prd = applyInterviewUpdates(prd, compiled.envelope.updates);
          }
          done = isPrdComplete(prd);
          finalQuestion = (compiled.envelope?.next_question || "What should we clarify next to finish the PRD?").trim();
        }

        if (!done) {
          if (
            hasAnswer
            && typeof cachedQuestion === "string"
            && normalizeQuestionKey(finalQuestion) === normalizeQuestionKey(cachedQuestion)
          ) {
            const repeatRepairResponse = await ctx.client.session.prompt({
              path: { id: ws.sessionId },
              body: {
                parts: [{ type: "text", text: repeatedQuestionRepairPrompt(cachedQuestion, rawInput) }],
              },
            });
            const repeatRepairText = await resolvePromptText(ctx, ws.sessionId, repeatRepairResponse, TIMEOUTS.SESSION_IDLE_TIMEOUT_MS);
            const repeatRepairTurn = parseInterviewTurn(repeatRepairText);
            if (!repeatRepairTurn.error && repeatRepairTurn.question) {
              finalQuestion = repeatRepairTurn.question;
            } else {
              logWarning("interview", "Could not generate non-repeated follow-up question; keeping interviewer output");
            }
          }

          prd = {
            ...prd,
            wizard: {
              ...prd.wizard,
              step: 0,
              totalSteps: WIZARD_REQUIREMENTS.TOTAL_STEPS,
              status: "in_progress",
              lastQuestionId: "interview",
              answers: {
                ...prd.wizard.answers,
                [`${INTERVIEW_QUESTION_PREFIX}${Date.now()}`]: finalQuestion,
                [LAST_QUESTION_KEY]: finalQuestion,
              },
            },
          };
          await writePrdJson(repoRoot, prd);
          await logToolEvent(ctx, repoRoot, "info", "new.question", "PRD follow-up question generated", {
            question: finalQuestion,
          });
          return [
            `PRD interview (0/${WIZARD_REQUIREMENTS.TOTAL_STEPS})`,
            finalQuestion,
            "Reply with your answer in natural language.",
          ].join("\n");
        }

        prd = {
          ...prd,
          wizard: {
            ...prd.wizard,
            step: WIZARD_REQUIREMENTS.TOTAL_STEPS,
            totalSteps: WIZARD_REQUIREMENTS.TOTAL_STEPS,
            status: "completed",
            lastQuestionId: "done",
            answers: {
              ...prd.wizard.answers,
              [LAST_QUESTION_KEY]: "done",
            },
          },
        };

        prd = await seedTasksFromPrd(repoRoot, prd, ctx);
        await writePrdJson(repoRoot, prd);
        await logPrdComplete(ctx, repoRoot, prd.tasks.length);
        await logToolEvent(ctx, repoRoot, "info", "new.complete", "PRD interview completed and tasks seeded", {
          tasks: prd.tasks.length,
        });
        return [
          "PRD wizard: completed.",
          `PRD: ${path.join(repoRoot, ".mario", "prd.json")}`,
          `Tasks: ${prd.tasks.length}`,
          "Next: /mario-devx:run 1",
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
        const runId = createRunId();
        await logRunEvent(ctx, repoRoot, "info", "run.preflight.start", "Run preflight started", {
          controlSessionId: context.sessionID ?? null,
        }, { runId });

        const previousRun = await readRunState(repoRoot);
        if (
          ((context.sessionID && previousRun.lastRunControlSessionId === context.sessionID)
            || (!context.sessionID && !!previousRun.lastRunControlSessionId))
          && previousRun.lastRunAt
          && previousRun.lastRunResult
          && Number.isFinite(Date.parse(previousRun.lastRunAt))
          && (Date.now() - Date.parse(previousRun.lastRunAt)) <= TIMEOUTS.RUN_DUPLICATE_WINDOW_MS
        ) {
          await logRunEvent(ctx, repoRoot, "info", "run.duplicate-window", "Returning cached run result in duplicate window", {
            cachedAt: previousRun.lastRunAt,
            duplicateWindowMs: TIMEOUTS.RUN_DUPLICATE_WINDOW_MS,
          }, { runId, reasonCode: "DUPLICATE_WINDOW" });
          return previousRun.lastRunResult;
        }

        const lock = await acquireRunLock(repoRoot, context.sessionID, async (event) => {
          if (event.type === "stale-pid-removed") {
            await logRunEvent(ctx, repoRoot, "warn", "run.lock.stale-pid", "Removed stale run lock owned by dead process", {
              lockPath: event.lockPath,
              stalePid: event.stalePid,
            }, { runId, reasonCode: "STALE_LOCK_REMOVED" });
          }
        });
        if (!lock.ok) {
          await logRunEvent(ctx, repoRoot, "warn", "run.lock.acquire-failed", "Run lock acquire failed", {
            lockMessage: lock.message,
          }, { runId, reasonCode: "RUN_LOCK_HELD" });
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
            await logRunEvent(ctx, repoRoot, "error", "run.blocked.heartbeat", "Run blocked: preflight heartbeat failed", {
              phase: "preflight",
              lockPath: runLockPath(repoRoot),
            }, { runId, reasonCode: "HEARTBEAT_FAILED" });
            return `Failed to update run.lock heartbeat during run preflight (${runLockPath(repoRoot)}). Check disk space/permissions, then rerun /mario-devx:run 1.`;
          }
          const currentRun = await readRunState(repoRoot);
          if (currentRun.status === "DOING") {
            const recoveredState = {
              ...currentRun,
              status: "BLOCKED" as const,
              updatedAt: nowIso(),
            };
            await writeRunState(repoRoot, recoveredState);
            await logRunEvent(ctx, repoRoot, "warn", "run.state.stale-doing-recovered", "Recovered stale in-progress run state", {
              previousPhase: currentRun.phase,
              previousCurrentPI: currentRun.currentPI ?? null,
              previousStartedAt: currentRun.startedAt ?? null,
              previousControlSessionId: currentRun.controlSessionId ?? null,
            }, { runId, reasonCode: "STALE_DOING_RECOVERED" });
            await showToast(ctx, "Run: recovered stale in-progress state from interrupted session", "warning");
          }

          let prd = await ensurePrd(repoRoot);
          const workspaceRoot = await resolveNodeWorkspaceRoot(repoRoot);
          const workspaceAbs = workspaceRoot === "." ? repoRoot : path.join(repoRoot, workspaceRoot);
          if (prd.wizard.status !== "completed") {
            await logRunEvent(ctx, repoRoot, "warn", "run.blocked.prd-incomplete", "Run blocked because PRD wizard is incomplete", {
              wizardStatus: prd.wizard.status,
              wizardStep: prd.wizard.step,
              wizardTotalSteps: prd.wizard.totalSteps,
            }, { runId, reasonCode: "PRD_INCOMPLETE" });
            return "PRD wizard is not complete. Run /mario-devx:new to finish it.";
          }
          if (!Array.isArray(prd.tasks) || prd.tasks.length === 0) {
            await logRunEvent(ctx, repoRoot, "warn", "run.blocked.no-tasks", "Run blocked because no tasks were found", {
              tasksCount: Array.isArray(prd.tasks) ? prd.tasks.length : 0,
            }, { runId, reasonCode: "NO_TASKS" });
            return "No tasks found in .mario/prd.json. Run /mario-devx:new to seed tasks.";
          }
          if (!Array.isArray(prd.qualityGates) || prd.qualityGates.length === 0) {
            await logRunEvent(ctx, repoRoot, "warn", "run.blocked.no-quality-gates", "Run blocked because quality gates are empty", {
              qualityGatesCount: Array.isArray(prd.qualityGates) ? prd.qualityGates.length : 0,
            }, { runId, reasonCode: "NO_QUALITY_GATES" });
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
          await logRunEvent(ctx, repoRoot, "error", "run.blocked.invalid-task-state", "Run blocked: invalid in_progress task state", {
            inProgressTaskIds: inProgress.map((t) => t.id),
          }, { runId, reasonCode: "INVALID_TASK_STATE" });
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

        const uiSetup = await resolveUiRunSetup({
          ctx,
          repoRoot,
          workspaceRoot,
          onWarnings: async (count) => {
            await showToast(ctx, `Run warning: AGENTS.md parse warnings (${count})`, "warning");
          },
          onPrereqLog: async (entry) => {
            if (entry.event === "ui.prereq.browser-install.start") {
              await showToast(ctx, "Run: installing browser runtime for UI verification (may take a few minutes)", "info");
            }
            await logRunEvent(
              ctx,
              repoRoot,
              entry.level,
              entry.event,
              entry.message,
              entry.extra,
              { runId, ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) },
            );
          },
        });
        const {
          uiVerifyEnabled,
          uiVerifyCmd,
          uiVerifyUrl,
          uiVerifyRequired,
          agentBrowserRepo,
          isWebApp,
          cliOk,
          skillOk,
          browserOk,
          autoInstallAttempted,
          shouldRunUiVerify,
        } = uiSetup;
        const agentBrowserCaps = (uiVerifyEnabled && isWebApp)
          ? await discoverAgentBrowserCapabilities(ctx)
          : {
              available: false,
              version: null,
              commands: [] as string[],
              openUsage: null,
              notes: [] as string[],
            };
        if (uiVerifyEnabled && isWebApp) {
          await logRunEvent(ctx, repoRoot, "info", "run.ui.capabilities", "Discovered agent-browser capabilities", {
            available: agentBrowserCaps.available,
            version: agentBrowserCaps.version,
            openUsage: agentBrowserCaps.openUsage,
            commands: agentBrowserCaps.commands,
            notes: agentBrowserCaps.notes,
          }, { runId });
        }

          let attempted = 0;
          let completed = 0;
          const runNotes: string[] = [];
          const runCtx: RunExecutionContext = {
            runId,
            repoRoot,
            workspaceRoot,
            workspaceAbs,
            ...(context.sessionID ? { controlSessionId: context.sessionID } : {}),
          };
          const logGateRunResults = async (
            phase: RunPhaseName,
            taskId: string,
            gateResults: GateRunItem[],
          ): Promise<void> => {
            for (const gate of gateResults) {
              await logRunEvent(
                ctx,
                repoRoot,
                gate.ok ? "info" : "warn",
                gate.ok ? "run.gate.pass" : "run.gate.fail",
                `${phase} gate ${gate.ok ? "PASS" : "FAIL"}: ${gate.command}`,
                {
                  phase,
                  taskId,
                  command: gate.command,
                  exitCode: gate.exitCode,
                  durationMs: gate.durationMs,
                  ...(gate.ok ? {} : {
                    stdout: gate.stdout ?? "",
                    stderr: gate.stderr ?? "",
                  }),
                },
                { runId, taskId },
              );
            }
          };
          await logRunEvent(ctx, repoRoot, "info", "run.started", "Run started", {
            maxItems,
            uiVerifyEnabled,
            uiVerifyRequired,
            shouldRunUiVerify,
            uiVerifyWaitMs: TIMEOUTS.UI_VERIFY_WAIT_MS,
            agentBrowserVersion: agentBrowserCaps.version,
            agentBrowserOpenUsage: agentBrowserCaps.openUsage,
            agentBrowserCommands: agentBrowserCaps.commands,
            agentBrowserNotes: agentBrowserCaps.notes,
          }, { runId });

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
              prd = await persistBlockedTaskAttempt({
                ctx,
                repoRoot,
                prd,
                task,
                attemptAt,
                iteration: state.iteration,
                gates,
                ui,
                judge,
                runId,
              });
              await logRunEvent(ctx, repoRoot, "warn", "run.blocked.prerequisite", `Run blocked: prerequisite task pending for ${task.id}`, {
                taskId: task.id,
                prerequisiteTaskId: prerequisiteTask.id,
              }, { runId, taskId: task.id, reasonCode: "PREREQ_PENDING" });
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
            logInfo("task", `Starting ${task.id}: ${task.title}`);

            const reconcileGateResult = await runGateCommands(gateCommands, ctx.$, runCtx.workspaceAbs);
            await logGateRunResults(RUN_PHASE.RECONCILE, task.id, reconcileGateResult.results);
            if (reconcileGateResult.ok) {
              const uiResult = shouldRunUiVerify
                ? await runUiVerification({
                    ctx,
                    devCmd: uiVerifyCmd,
                    url: uiVerifyUrl,
                    waitMs: TIMEOUTS.UI_VERIFY_WAIT_MS,
                    log: async (entry) => {
                      await logRunEvent(
                        ctx,
                        repoRoot,
                        entry.level,
                        entry.event,
                        entry.message,
                        entry.extra,
                        { runId, taskId: task.id, ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) },
                      );
                    },
                  })
                : null;

              const gates: PrdGatesAttempt = {
                ok: true,
                commands: reconcileGateResult.results.map((r) => ({
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
                    note: uiVerifyEnabled && isWebApp
                      ? "UI verification not run."
                      : "UI verification not configured.",
                  };

              const state = await bumpIteration(repoRoot);
              const attemptAt = nowIso();

              if (uiVerifyEnabled && isWebApp && uiVerifyRequired && (!cliOk || !skillOk || !browserOk)) {
                const judge: PrdJudgeAttempt = {
                  status: "FAIL",
                  exitSignal: false,
                  reason: [
                    "UI verification is required but agent-browser prerequisites are missing.",
                    ...(autoInstallAttempted.length > 0 ? [`Auto-install attempted: ${autoInstallAttempted.join("; ")}`] : []),
                  ],
                  nextActions: [
                    "Install prerequisites, then rerun /mario-devx:run 1.",
                    "Or set UI_VERIFY_REQUIRED=0 in .mario/AGENTS.md to make UI verification best-effort.",
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
                await logRunEvent(ctx, repoRoot, "error", "run.blocked.ui-prereq", `Run blocked: UI prerequisites missing for ${task.id}`, {
                  taskId: task.id,
                  uiVerifyRequired,
                  cliOk,
                  skillOk,
                  browserOk,
                  autoInstallAttempted,
                }, { runId, taskId: task.id, reasonCode: "UI_PREREQ_MISSING" });
                await showToast(ctx, `Run stopped: UI prerequisites missing on ${task.id}`, "warning");
                break;
              }

              if (uiVerifyEnabled && isWebApp && uiVerifyRequired && uiResult && !uiResult.ok) {
                const judge: PrdJudgeAttempt = {
                  status: "FAIL",
                  exitSignal: false,
                  reason: ["UI verification failed during reconcile."],
                  nextActions: ["Fix UI verification failures, then rerun /mario-devx:run 1."],
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
                await logRunEvent(ctx, repoRoot, "error", "run.blocked.ui-reconcile", `Run blocked: UI verification failed during reconcile for ${task.id}`, {
                  taskId: task.id,
                  uiNote: uiResult?.note ?? null,
                }, { runId, taskId: task.id, reasonCode: "UI_VERIFY_FAILED" });
                await showToast(ctx, `Run stopped: UI verification failed on ${task.id}`, "warning");
                break;
              }

              const wsForVerifier = await ensureWorkSession(ctx, repoRoot, context.agent);
              await setWorkSessionTitle(ctx, wsForVerifier.sessionId, `mario-devx (work) - reconcile judge ${task.id}`);
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
                  ...reconcileGateResult.results.map((r) => `- ${r.command}: ${r.ok ? "PASS" : `FAIL (exit ${r.exitCode})`}`),
                  uiResult ? `UI verification: ${uiResult.ok ? "PASS" : "FAIL"}` : "UI verification: (not run)",
                  uiResult?.note ? `UI note: ${uiResult.note}` : "",
                  "",
                  "UI product context:",
                  `- Visual direction: ${prd.ui.visualDirection || "unspecified"}`,
                  `- UX requirements: ${(prd.ui.uxRequirements ?? []).join("; ") || "unspecified"}`,
                  `- Style references: ${(prd.ui.styleReferences ?? []).join(", ") || "none"}`,
                  "",
                  "agent-browser capabilities:",
                  `- Available: ${agentBrowserCaps.available ? "yes" : "no"}`,
                  `- Version: ${agentBrowserCaps.version ?? "unknown"}`,
                  `- Open usage: ${agentBrowserCaps.openUsage ?? "unknown"}`,
                  `- Commands: ${agentBrowserCaps.commands.join(", ") || "none"}`,
                  ...(agentBrowserCaps.notes.length > 0 ? [`- Notes: ${agentBrowserCaps.notes.join("; ")}`] : []),
                  "",
                  "Autonomous UI check policy:",
                  `- UI URL: ${uiVerifyUrl}`,
                  "- You may run agent-browser commands autonomously to gather missing evidence.",
                  "- Maximum 8 browser commands for this verification pass.",
                  "- Prefer snapshot/console/errors evidence before issuing FAIL.",
                ]
                  .filter((x) => x)
                  .join("\n"),
              );

              const verifierResponse = await ctx.client.session.prompt({
                path: { id: wsForVerifier.sessionId },
                body: {
                  ...(context.agent ? { agent: context.agent } : {}),
                  parts: [{ type: "text", text: verifierPrompt }],
                },
              });
              const verifierText = await resolvePromptText(ctx, wsForVerifier.sessionId, verifierResponse, TIMEOUTS.SESSION_IDLE_TIMEOUT_MS);
              const judge = parseJudgeAttemptFromText(verifierText);
              const lastAttempt: PrdTaskAttempt = {
                at: attemptAt,
                iteration: state.iteration,
                gates,
                ui,
                judge,
              };
              const isPass = judge.status === "PASS" && judge.exitSignal;

              prd = setPrdTaskStatus(prd, task.id, isPass ? "completed" : "blocked");
              prd = setPrdTaskLastAttempt(prd, task.id, lastAttempt);
              await writePrdJson(repoRoot, prd);
              await updateRunState(repoRoot, {
                status: isPass ? "DOING" : "BLOCKED",
                phase: "run",
                currentPI: task.id,
                controlSessionId: context.sessionID,
              });

              if (isPass) {
                completed += 1;
                runNotes.push(`Reconciled ${task.id}: deterministic gates already passing; verifier PASS.`);
                await logRunEvent(ctx, repoRoot, "info", "run.reconcile.pass", `Run reconciled ${task.id}`, {
                  taskId: task.id,
                }, { runId, taskId: task.id });
                await showToast(ctx, `Run: reconciled ${task.id} (already passing)`, "success");
                continue;
              }

              logWarning("task", `${task.id} blocked during reconcile: ${judge.reason?.[0] ?? "No reason provided"}`);
              await logRunEvent(ctx, repoRoot, "warn", "run.blocked.verifier-reconcile", `Run blocked: verifier failed during reconcile for ${task.id}`, {
                taskId: task.id,
                reason: judge.reason?.[0] ?? "No reason provided",
              }, { runId, taskId: task.id, reasonCode: "VERIFIER_FAILED" });
              await showToast(ctx, `Run stopped: verifier failed on ${task.id}`, "warning");
              break;
            }

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
              await logRunEvent(ctx, repoRoot, "error", "run.blocked.heartbeat", `Run blocked: lock heartbeat failed during ${phase}`, {
                taskId: task.id,
                phase,
                lockPath: runLockPath(repoRoot),
              }, { runId, taskId: task.id, reasonCode: "HEARTBEAT_FAILED" });
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

              const idle = await waitForSessionIdleStable(ctx, ws.sessionId, 20 * 60 * 1000);
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
                await logRunEvent(ctx, repoRoot, "error", "run.blocked.build-timeout", `Run blocked: build timed out for ${task.id}`, {
                  taskId: task.id,
                }, { runId, taskId: task.id, reasonCode: "BUILD_TIMEOUT" });
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
                  await runShellWithFailureLog(ctx, repoRoot, installCmd, {
                    event: "run.bootstrap.install.failed",
                    message: `Dependency install failed while bootstrapping ${task.id}`,
                    reasonCode: "BOOTSTRAP_INSTALL_FAILED",
                    runId,
                    taskId: task.id,
                    extra: { workspaceRoot },
                  });
                }
              }

              let gateResult = await runGateCommands(gateCommands, ctx.$, runCtx.workspaceAbs);
              await logGateRunResults(RUN_PHASE.REPAIR, task.id, gateResult.results);

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
                  const scaffoldRun = await runShellWithFailureLog(ctx, repoRoot, scaffoldHint, {
                    event: "run.scaffold.default.failed",
                    message: `Default scaffold command failed for ${task.id}`,
                    reasonCode: "SCAFFOLD_COMMAND_FAILED",
                    runId,
                    taskId: task.id,
                  });
                  repairAttempts += 1;
                  if (!(await heartbeatRunLock(repoRoot))) {
                    await blockForHeartbeatFailure("during-deterministic-scaffold");
                    await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
                    break;
                  }
                  if (scaffoldRun.exitCode !== 0) {
                    await showToast(ctx, `Run: default scaffold failed on ${task.id}, falling back to agent repair`, "warning");
                  }
                  gateResult = await runGateCommands(gateCommands, ctx.$, runCtx.workspaceAbs);
                  await logGateRunResults(RUN_PHASE.REPAIR, task.id, gateResult.results);
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

                const repairIdle = await waitForSessionIdleStable(ctx, ws.sessionId, TIMEOUTS.REPAIR_IDLE_TIMEOUT_MS);
                if (!repairIdle) {
                  break;
                }

                repairAttempts += 1;
                gateResult = await runGateCommands(gateCommands, ctx.$, runCtx.workspaceAbs);
                await logGateRunResults(RUN_PHASE.REPAIR, task.id, gateResult.results);
              }

              if (!gateResult.ok) {
                const settleIdle = await waitForSessionIdleStable(ctx, ws.sessionId, TIMEOUTS.GATE_SETTLE_IDLE_MS, 2);
                if (settleIdle) {
                  const reconciledGateResult = await runGateCommands(gateCommands, ctx.$, runCtx.workspaceAbs);
                  await logGateRunResults(RUN_PHASE.RECONCILE, task.id, reconciledGateResult.results);
                  if (reconciledGateResult.ok) {
                    gateResult = reconciledGateResult;
                  }
                }
              }

              const uiResult = gateResult.ok && shouldRunUiVerify
                ? await runUiVerification({
                    ctx,
                    devCmd: uiVerifyCmd,
                    url: uiVerifyUrl,
                    waitMs: TIMEOUTS.UI_VERIFY_WAIT_MS,
                    log: async (entry) => {
                      await logRunEvent(
                        ctx,
                        repoRoot,
                        entry.level,
                        entry.event,
                        entry.message,
                        entry.extra,
                        { runId, taskId: task.id, ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) },
                      );
                    },
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
                  : uiVerifyEnabled && isWebApp && (!cliOk || !skillOk || !browserOk)
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
            prd = await persistBlockedTaskAttempt({
              ctx,
              repoRoot,
              prd,
              task,
              attemptAt,
              iteration: state.iteration,
              gates,
              ui,
              judge,
              runId,
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

          if (uiVerifyEnabled && isWebApp && uiVerifyRequired && (!cliOk || !skillOk || !browserOk)) {
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
              "",
              "UI product context:",
              `- Visual direction: ${prd.ui.visualDirection || "unspecified"}`,
              `- UX requirements: ${(prd.ui.uxRequirements ?? []).join("; ") || "unspecified"}`,
              `- Style references: ${(prd.ui.styleReferences ?? []).join(", ") || "none"}`,
              "",
              "agent-browser capabilities:",
              `- Available: ${agentBrowserCaps.available ? "yes" : "no"}`,
              `- Version: ${agentBrowserCaps.version ?? "unknown"}`,
              `- Open usage: ${agentBrowserCaps.openUsage ?? "unknown"}`,
              `- Commands: ${agentBrowserCaps.commands.join(", ") || "none"}`,
              ...(agentBrowserCaps.notes.length > 0 ? [`- Notes: ${agentBrowserCaps.notes.join("; ")}`] : []),
              "",
              "Autonomous UI check policy:",
              `- UI URL: ${uiVerifyUrl}`,
              "- You may run agent-browser commands autonomously to gather missing evidence.",
              "- Maximum 8 browser commands for this verification pass.",
              "- Prefer snapshot/console/errors evidence before issuing FAIL.",
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
          const verifierText = await resolvePromptText(
            ctx,
            ws.sessionId,
            verifierResponse,
            TIMEOUTS.SESSION_IDLE_TIMEOUT_MS,
          );
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
             logInfo("task", `${task.id} completed (${completed}/${maxItems})`);
             await logTaskComplete(ctx, repoRoot, task.id, completed, maxItems);
             await showToast(ctx, `Run: completed ${task.id} (${completed}/${maxItems})`, "success");
           } else {
             logWarning("task", `${task.id} blocked: ${judge.reason?.[0] ?? "No reason provided"}`);
             await logTaskBlocked(ctx, repoRoot, task.id, judge.reason?.[0] ?? "No reason provided");
             await showToast(ctx, `Run stopped: verifier failed on ${task.id}`, "warning");
             break;
           }
            } finally {
              const runStateNow = await readRunState(repoRoot);
              const taskStatusNow = (prd.tasks ?? []).find((t) => t.id === task.id)?.status;
              if (runStateNow.status === "DOING" && taskStatusNow !== "completed") {
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

          const {
            result,
            latestTask,
            judgeTopReason,
          } = buildRunSummary({
            attempted,
            completed,
            maxItems,
            tasks: prd.tasks ?? [],
            runNotes,
            uiVerifyRequired,
          });

          await updateRunState(repoRoot, {
            ...(context.sessionID ? { lastRunControlSessionId: context.sessionID } : {}),
            lastRunAt: nowIso(),
            lastRunResult: result,
          });
          await logRunEvent(ctx, repoRoot, completed === attempted ? "info" : "warn", "run.finished", "Run finished", {
            attempted,
            completed,
            status: completed === attempted ? "DONE" : "BLOCKED",
            latestTaskId: latestTask?.id ?? null,
            reason: judgeTopReason,
          }, { runId, ...(latestTask?.id ? { taskId: latestTask.id } : {}) });

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
          await logToolEvent(ctx, repoRoot, "warn", "add.blocked.work-session", "Feature add blocked in work session");
          return notInWork.message;
        }
        await ensureMario(repoRoot, false);
        let prd = await ensurePrd(repoRoot);
        const feature = (args.feature ?? "").trim();
        await logToolEvent(ctx, repoRoot, "info", "add.start", "Feature decomposition started", {
          featureLength: feature.length,
          runIteration: (await readRunState(repoRoot)).iteration,
        });
        if (!feature) {
          await logToolEvent(ctx, repoRoot, "warn", "add.invalid.empty", "Feature add called with empty input");
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
          logError("feature-interview", "No <FEATURE_JSON> tags found in LLM response");
          logError("feature-interview", `Raw response: ${responseText.substring(0, 500)}`);
          await logToolEvent(ctx, repoRoot, "error", "add.parse.missing-tags", "Feature interview response missing <FEATURE_JSON>", {
            rawResponse: redactForLog(responseText),
          });
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
          logError("feature-interview", `JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
          logError("feature-interview", `Raw JSON: ${jsonMatch[1].trim().substring(0, 500)}`);
          await logToolEvent(ctx, repoRoot, "error", "add.parse.invalid-json", "Feature interview JSON parse failed", {
            error: err instanceof Error ? err.message : String(err),
            rawJson: redactForLog(jsonMatch[1].trim()),
          });
          return `Error: Invalid JSON in feature response: ${err instanceof Error ? err.message : String(err)}. Please try again.`;
        }
        
        // If not ready, ask follow-up question
        if (!envelope.ready || envelope.next_question) {
          await logToolEvent(ctx, repoRoot, "info", "add.followup", "Feature interview requested follow-up", {
            nextQuestion: envelope.next_question || "Please provide more detail about this feature.",
          });
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
        await logToolEvent(ctx, repoRoot, "info", "add.complete", "Feature decomposed into tasks", {
          backlogId,
          newTasks: newTasks.length,
          taskIds: newTasks.map((t) => t.id),
          runIteration: runState.iteration,
        });
        
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
          await logToolEvent(ctx, repoRoot, "warn", "replan.blocked.work-session", "Replan blocked in work session");
          return notInWork.message;
        }
        await ensureMario(repoRoot, false);
        let prd = await ensurePrd(repoRoot);
        const replanCandidates = prd.backlog.featureRequests.filter((f) => f.status === "open" || f.status === "planned");
        await logToolEvent(ctx, repoRoot, "info", "replan.start", "Replan started", {
          candidates: replanCandidates.length,
        });
        
        if (replanCandidates.length === 0) {
          await logToolEvent(ctx, repoRoot, "info", "replan.noop", "No backlog items to replan");
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
        
        logInfo("replan", `Replanning ${replanCandidates.length} backlog items via LLM...`);
        
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
            
            logInfo("replan", `LLM generated ${generated.length} tasks from ${parsed.breakdowns?.length || 0} backlog items`);
          } catch (err) {
            logError("replan", `Failed to parse LLM replan response: ${err instanceof Error ? err.message : String(err)}`);
            await logToolEvent(ctx, repoRoot, "error", "replan.parse.invalid-json", "Failed to parse REPLAN_JSON", {
              error: err instanceof Error ? err.message : String(err),
              rawResponse: redactForLog(replanText),
            });
            // Fall through to fallback
          }
        }
        
        // Fallback: simple decomposition if LLM fails
        if (generated.length === 0) {
          logInfo("replan", "Using fallback decomposition");
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
        await logReplanComplete(ctx, repoRoot, replanCandidates.length, generated.length);
        await logToolEvent(ctx, repoRoot, "info", "replan.complete", "Replan completed", {
          backlogItems: replanCandidates.length,
          generatedTasks: generated.length,
        });
        
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
        await logToolEvent(ctx, repoRoot, "info", "status.start", "Status requested");
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
        await logToolEvent(ctx, repoRoot, "info", "status.complete", "Status computed", {
          runStatus: run.status,
          currentPI: run.currentPI ?? null,
          focusTaskId: focusTask?.id ?? null,
        });

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
        await logToolEvent(ctx, repoRoot, "info", "doctor.start", "Doctor check started");
        const result = await runDoctor(ctx, repoRoot);
        await logToolEvent(ctx, repoRoot, "info", "doctor.complete", "Doctor check completed", {
          resultPreview: redactForLog(result),
        });
        return result;
      },
    }),

  };
};
