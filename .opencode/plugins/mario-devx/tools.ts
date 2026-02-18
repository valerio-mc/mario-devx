import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import path from "path";
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
  LAST_QUESTION_KEY,
  compactIdea,
  extractStyleReferencesFromText,
  hasNonEmpty,
  isPrdComplete,
  mergeStyleReferences,
  normalizeTextArray,
} from "./interview";
import {
  firstScaffoldHintFromNotes,
  getNextPrdTask,
  getTaskDependencyBlockers,
  isScaffoldMissingGateCommand,
  makeTask,
  nextTaskOrdinal,
  normalizeTaskId,
  setPrdTaskLastAttempt,
  setPrdTaskStatus,
  validateTaskGraph,
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
  waitForSessionIdleStableDetailed,
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
import { ensureVerifierSession, resetVerifierSessionToBaseline, runVerifierTurn } from "./verifier-session";
import { buildVerifierContextText, buildVerifierTransportFailureJudge, enforceJudgeOutputQuality } from "./run-verifier";
import { RUN_EVENT, RUN_REASON } from "./run-contracts";
import { captureWorkspaceSnapshot, checkAcceptanceArtifacts, logGateRunResults as logGateRunResultsPhase, resolveEffectiveDoneWhen, runUiVerifyForTask as runUiVerifyForTaskPhase, summarizeWorkspaceDelta, toGateCommands, toGatesAttempt, toUiAttempt } from "./run-phase-helpers";
import { parseMaxItems, syncFrontendAgentsConfig, validateRunPrerequisites } from "./run-preflight";
import { buildGateRepairPrompt, buildIterationTaskPlan, buildSemanticRepairPrompt } from "./run-prompts";
import { createStatusTool } from "./tool-status";
import { createDoctorTool } from "./tool-doctor";
import { createBacklogTools } from "./tool-backlog";
import { createNewTool } from "./tool-new";

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

type QualityGatePreset = {
  label: string;
  commands: string[];
};

type QualityGateSelectionState = {
  question: string;
  options: QualityGatePreset[];
};

const INTERVIEW_QUESTION_PREFIX = "q-";
const INTERVIEW_ANSWER_PREFIX = "a-";
const STYLE_REFS_ACK_KEY = "__style_refs_ack";
const QUALITY_GATES_STATE_KEY = "__quality_gates_selection";
const STYLE_REFS_REQUIRED_QUESTION = "Share at least one style reference URL/image path, or reply 'none' to proceed without references.";

const parseQualityGateSelectionState = (raw: string | undefined): QualityGateSelectionState | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as QualityGateSelectionState;
    if (!parsed || typeof parsed.question !== "string" || !Array.isArray(parsed.options) || parsed.options.length === 0) {
      return null;
    }
    const options = parsed.options
      .map((opt) => ({
        label: String(opt.label ?? "").trim(),
        commands: normalizeTextArray(Array.isArray(opt.commands) ? opt.commands : []).slice(0, 6),
      }))
      .filter((opt) => opt.label.length > 0 && opt.commands.length > 0);
    if (options.length === 0) return null;
    return {
      question: parsed.question.trim() || "Which quality gate preset should we use?",
      options: options.slice(0, 3),
    };
  } catch {
    return null;
  }
};

const writeQualityGateSelectionState = (prd: PrdJson, state: QualityGateSelectionState | null): PrdJson => {
  const answers = { ...(prd.wizard.answers ?? {}) };
  if (!state) {
    delete answers[QUALITY_GATES_STATE_KEY];
  } else {
    answers[QUALITY_GATES_STATE_KEY] = JSON.stringify(state);
  }
  return {
    ...prd,
    wizard: {
      ...prd.wizard,
      answers,
    },
  };
};

const isNoneLikeAnswer = (input: string): boolean => {
  const s = input.trim().toLowerCase();
  return s === "none" || s === "no" || s === "n/a" || s === "na";
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

const isSystemReasonCode = (line: string): boolean => {
  const m = line.match(/^ReasonCode:\s*([A-Z0-9_]+)/i);
  if (!m) return false;
  const code = (m[1] ?? "").toUpperCase();
  return code.startsWith("VERIFIER_TRANSPORT")
    || code.startsWith("RUN_")
    || code.startsWith("HEARTBEAT_")
    || code.startsWith("COMMAND_NOT_FOUND")
    || code.startsWith("MISSING_SCRIPT_");
};

const isPassEvidenceLine = (line: string): boolean => {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return false;
  if (/^ui verification:\s*pass\b/i.test(trimmed)) return true;
  return /^[\w./:\-\s]+:\s*PASS\b/i.test(trimmed);
};

const isMetaCarryForwardLine = (line: string): boolean => {
  const text = String(line ?? "").trim();
  if (!text) return true;
  if (/^ReasonCode:\s*[A-Z0-9_]+/i.test(text)) return true;
  if (/^rubric:/i.test(text)) return true;
  if (isPassEvidenceLine(text)) return true;
  if (/Task evidence indicates/i.test(text)) return true;
  if (/\.mario\/prd\.json/i.test(text) && /status|lastAttempt|ReasonCode|blocked/i.test(text)) return true;
  return false;
};

const firstActionableJudgeReason = (judge: PrdJudgeAttempt | undefined): string | null => {
  if (!judge) return null;
  const reasons = (judge.reason ?? []).map((x) => String(x).trim()).filter(Boolean);
  if (reasons.length === 0) return null;
  const actionable = reasons.find((line) => {
    if (/^ReasonCode:\s*[A-Z0-9_]+/i.test(line)) return false;
    return !isPassEvidenceLine(line);
  });
  return actionable ?? reasons[0] ?? null;
};

const collectCarryForwardIssues = (task: PrdTask): string[] => {
  const attempt = task.lastAttempt;
  if (!attempt || task.status !== "blocked") return [];
  const reasons = (attempt.judge.reason ?? [])
    .map((r) => String(r).trim())
    .filter(Boolean)
    .filter((r) => !isMetaCarryForwardLine(r))
    .filter((r) => !isSystemReasonCode(r));
  const actions = (attempt.judge.nextActions ?? [])
    .map((a) => String(a).trim())
    .filter(Boolean)
    .filter((a) => !isMetaCarryForwardLine(a))
    .filter((a) => !/retry \/mario-devx:run 1/i.test(a));
  const uiNotes = attempt.ui?.note ? [String(attempt.ui.note).trim()] : [];
  return Array.from(new Set([...reasons, ...actions, ...uiNotes])).slice(0, 10);
};

const applyRepeatedFailureBackpressure = (
  previous: PrdTaskAttempt | undefined,
  judge: PrdJudgeAttempt,
): PrdJudgeAttempt => {
  if (!previous || judge.status !== "FAIL") return judge;
  const prev = (previous.judge.reason ?? []).map(normalizeIssueLine).filter(Boolean);
  const curr = (judge.reason ?? []).map(normalizeIssueLine).filter(Boolean);
  if (prev.length === 0 || curr.length === 0) return judge;
  const overlap = curr.filter((c) => prev.includes(c));
  if (overlap.length === 0) return judge;
  const reason = [
    formatReasonCode(RUN_REASON.REPEATED_UI_FINDINGS),
    ...judge.reason,
  ];
  const nextActions = Array.from(new Set([
    ...(judge.nextActions ?? []),
    "Previous UI findings are repeating; address these findings explicitly before new changes.",
  ]));
  return { ...judge, reason, nextActions };
};

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
    "- ui.styleReferences prompt acknowledged if frontend=true",
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

const formatQualityGateSelectionQuestion = (state: QualityGateSelectionState): string => {
  const optionLines = state.options.map((opt) => `- ${opt.label}`).join("\n");
  return [
    state.question.trim() || "Which quality gate preset should we use?",
    "OPTIONS:",
    optionLines,
  ].join("\n");
};

const qualityGatePresetPrompt = (prd: PrdJson): string => {
  return [
    "You are mario-devx's quality gate assistant.",
    "Generate exactly 3 candidate deterministic quality-gate presets for this project.",
    "Prefer commands that are realistic for the provided language/framework and likely to pass once implementation is complete.",
    "Each preset should include 2-4 commands.",
    "Return ONLY JSON with this shape:",
    '{"question":"...","options":[{"label":"...","commands":["..."]},{"label":"...","commands":["..."]},{"label":"...","commands":["..."]}]}',
    "No markdown. No prose.",
    "PRD context:",
    JSON.stringify({
      idea: prd.idea,
      platform: prd.platform,
      frontend: prd.frontend,
      language: prd.language,
      framework: prd.framework,
      qualityGates: prd.qualityGates,
    }, null, 2),
  ].join("\n");
};

const qualityGatePresetRepairPrompt = (invalidResponse: string): string => {
  return [
    "Your previous quality-gate preset response was invalid.",
    "Return ONLY valid JSON with this exact shape:",
    '{"question":"...","options":[{"label":"...","commands":["..."]},{"label":"...","commands":["..."]},{"label":"...","commands":["..."]}]}',
    "Rules:",
    "- exactly 3 options",
    "- each option must have 2-4 deterministic commands",
    "- no markdown, no prose",
    "Previous invalid response:",
    invalidResponse,
  ].join("\n");
};

const parseQualityGatePresetResponse = (text: string): QualityGateSelectionState | null => {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as { question?: unknown; options?: Array<{ label?: unknown; commands?: unknown }> };
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "Which quality gate preset should we use?";
    const options = Array.isArray(parsed.options)
      ? parsed.options
          .map((opt) => ({
            label: String(opt.label ?? "").trim(),
            commands: normalizeTextArray(Array.isArray(opt.commands) ? (opt.commands as string[]) : []).slice(0, 6),
          }))
          .filter((opt) => opt.label.length > 0 && opt.commands.length >= 2)
      : [];
    if (options.length === 0) return null;
    return {
      question,
      options: options.slice(0, 3),
    };
  } catch {
    return null;
  }
};

const resolveQualityGatePresetChoice = (answer: string, state: QualityGateSelectionState): QualityGatePreset | null => {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return null;
  const numeric = normalized.match(/^([1-3])\b/);
  if (numeric) {
    const idx = Number.parseInt(numeric[1] ?? "0", 10) - 1;
    return state.options[idx] ?? null;
  }
  const direct = state.options.find((opt) => opt.label.toLowerCase() === normalized);
  if (direct) return direct;
  const contains = state.options.find((opt) => normalized.includes(opt.label.toLowerCase()) || opt.label.toLowerCase().includes(normalized));
  return contains ?? null;
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
  let section: "reason" | "next" = "reason";
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    const statusMatch = trimmed.match(/^Status:\s*(PASS|FAIL)/i);
    if (statusMatch) {
      status = statusMatch[1].toUpperCase() as "PASS" | "FAIL";
      statusExplicit = true;
      continue;
    }
    
    if (trimmed.match(/^(Reason|Reasons):/i)) {
      section = "reason";
      continue;
    }
    if (trimmed.match(/^(Next|Next actions|Next steps):/i)) {
      section = "next";
      continue;
    }
    
    const content = trimmed.replace(/^[-\s]+/, "").trim();
    if (!content) continue;
    
    if (trimmed.startsWith("-") && section === "reason") {
      reason.push(content);
    } else if (trimmed.startsWith("-") && section === "next") {
      nextActions.push(content);
    } else if (section === "next") {
      nextActions.push(content);
    } else {
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

const isLikelyJsonEofError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unexpected eof|unexpected end of json input|json parse error|empty verifier response text/i.test(message);
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const buildCapabilitySummary = (caps: {
  available: boolean;
  version: string | null;
  openUsage: string | null;
  commands: string[];
  notes: string[];
}): string => {
  return [
    `available: ${caps.available ? "yes" : "no"}`,
    `version: ${caps.version ?? "unknown"}`,
    `open usage: ${caps.openUsage ?? "unknown"}`,
    `commands: ${caps.commands.join(", ") || "none"}`,
    ...(caps.notes.length > 0 ? [`notes: ${caps.notes.join("; ")}`] : []),
  ].join("\n");
};

const promptAndResolveWithRetry = async (opts: {
  ctx: PluginContext;
  repoRoot: string;
  promptText: string;
  runId: string;
  taskId: string;
  agent?: string;
  timeoutMs: number;
  capabilitySummary: string;
}): Promise<string> => {
  const { ctx, repoRoot, promptText, runId, taskId, agent, timeoutMs, capabilitySummary } = opts;
  const maxAttempts = 3;
  let lastError: unknown = null;
  const verifierSession = await ensureVerifierSession({
    ctx,
    repoRoot,
    capabilitySummary,
    ...(agent ? { agent } : {}),
  });
  await logRunEvent(ctx, repoRoot, "info", "verifier.session.ensure.ok", "Verifier session ensured", {
    verifierSessionId: verifierSession.sessionId,
    baselineFingerprint: verifierSession.baselineFingerprint,
  }, { runId, taskId });
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await logRunEvent(ctx, repoRoot, "info", "verifier.session.reset.start", "Resetting verifier session to baseline", {
        verifierSessionId: verifierSession.sessionId,
        attempt,
      }, { runId, taskId });
      await resetVerifierSessionToBaseline(ctx, repoRoot, verifierSession);
      await logRunEvent(ctx, repoRoot, "info", "verifier.session.reset.ok", "Verifier session reset complete", {
        verifierSessionId: verifierSession.sessionId,
        attempt,
      }, { runId, taskId });
      await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.VERIFY_PROMPT_SENT, "Verifier prompt sent", {
        attempt,
        maxAttempts,
        verifierSessionId: verifierSession.sessionId,
      }, { runId, taskId });
      const verifierText = await runVerifierTurn({
        ctx,
        sessionId: verifierSession.sessionId,
        promptText,
        timeoutMs,
        ...(agent ? { agent } : {}),
      });
      if (!verifierText.trim()) {
        throw new Error("Empty verifier response text");
      }
      await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.VERIFY_RESPONSE_RECEIVED, "Verifier response received", {
        attempt,
        hasText: true,
      }, { runId, taskId });
      return verifierText;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      await logRunEvent(ctx, repoRoot, "error", "verifier.session.reset.fail", "Verifier session turn failed", {
        attempt,
        error: message,
      }, { runId, taskId, reasonCode: RUN_REASON.VERIFIER_TRANSPORT_ERROR });
      await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.VERIFY_TRANSPORT_ERROR, "Verifier transport/parse error", {
        attempt,
        maxAttempts,
        error: message,
        stack: error instanceof Error ? error.stack ?? "" : "",
      }, { runId, taskId, reasonCode: RUN_REASON.VERIFIER_TRANSPORT_ERROR });
      if (!isLikelyJsonEofError(error) || attempt === maxAttempts) {
        break;
      }
      await sleep(500 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Verifier prompt failed"));
};

const resolveVerifierJudge = async (opts: {
  ctx: PluginContext;
  repoRoot: string;
  verifierPrompt: string;
  runId: string;
  taskId: string;
  capabilitySummary: string;
  agent?: string;
}): Promise<{ judge: PrdJudgeAttempt } | { transportFailure: PrdJudgeAttempt; errorMessage: string }> => {
  const { ctx, repoRoot, verifierPrompt, runId, taskId, capabilitySummary, agent } = opts;
  try {
    const verifierText = await promptAndResolveWithRetry({
      ctx,
      repoRoot,
      promptText: verifierPrompt,
      runId,
      taskId,
      ...(agent ? { agent } : {}),
      timeoutMs: TIMEOUTS.SESSION_IDLE_TIMEOUT_MS,
      capabilitySummary,
    });
    return { judge: enforceJudgeOutputQuality(parseJudgeAttemptFromText(verifierText)) };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      transportFailure: buildVerifierTransportFailureJudge(
        "VERIFIER_TRANSPORT_EOF",
        `Verifier transport failed: ${errMsg}`,
      ),
      errorMessage: errMsg,
    };
  }
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
  await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_FAIL_EARLY, `Run blocked on ${task.id}`, {
    taskId: task.id,
    reason: judge.reason?.[0] ?? "Unknown failure",
  }, { runId, taskId: task.id, reasonCode: RUN_REASON.TASK_FAIL_EARLY });
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

  const statusTool = createStatusTool({
    ctx,
    repoRoot,
    ensurePrd,
    logToolEvent,
    notifyControlSession,
  });
  const doctorTool = createDoctorTool({
    ctx,
    repoRoot,
    logToolEvent,
    redactForLog,
  });
  const backlogTools = createBacklogTools({
    ctx,
    repoRoot,
    ensurePrd,
    logToolEvent,
  });
  const newTool = createNewTool({
    ctx,
    repoRoot,
    ensurePrd,
    logToolEvent,
    hasNonEmpty,
    extractStyleReferencesFromText,
    mergeStyleReferences,
    parseQualityGateSelectionState,
    writeQualityGateSelectionState,
    resolveQualityGatePresetChoice,
    applyInterviewUpdates,
    normalizeTextArray,
    normalizeQuestionKey,
    isNoneLikeAnswer,
    interviewPrompt,
    parseInterviewTurn,
    interviewTurnRepairPrompt,
    parseCompileInterviewResponse,
    compileInterviewPrompt,
    compileRepairPrompt,
    qualityGatePresetPrompt,
    parseQualityGatePresetResponse,
    qualityGatePresetRepairPrompt,
    formatQualityGateSelectionQuestion,
    repeatedQuestionRepairPrompt,
    seedTasksFromPrd,
    logPrdComplete,
    STYLE_REFS_ACK_KEY,
    INTERVIEW_ANSWER_PREFIX,
    QUALITY_GATES_STATE_KEY,
    STYLE_REFS_REQUIRED_QUESTION,
  });

  return {
    ...newTool,

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
        await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.PRECHECK_START, "Run preflight started", {
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
          await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.PRECHECK_DUPLICATE_WINDOW, "Returning cached run result in duplicate window", {
            cachedAt: previousRun.lastRunAt,
            duplicateWindowMs: TIMEOUTS.RUN_DUPLICATE_WINDOW_MS,
          }, { runId, reasonCode: RUN_REASON.DUPLICATE_WINDOW });
          return previousRun.lastRunResult;
        }

        const lock = await acquireRunLock(repoRoot, context.sessionID, async (event) => {
          if (event.type === "stale-pid-removed") {
            await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.LOCK_STALE_PID, "Removed stale run lock owned by dead process", {
              lockPath: event.lockPath,
              stalePid: event.stalePid,
            }, { runId, reasonCode: RUN_REASON.STALE_LOCK_REMOVED });
          }
        });
        if (!lock.ok) {
          await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.LOCK_ACQUIRE_FAILED, "Run lock acquire failed", {
            lockMessage: lock.message,
          }, { runId, reasonCode: RUN_REASON.RUN_LOCK_HELD });
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
            await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_HEARTBEAT, "Run blocked: preflight heartbeat failed", {
              phase: "preflight",
              lockPath: runLockPath(repoRoot),
            }, { runId, reasonCode: RUN_REASON.HEARTBEAT_FAILED });
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
            await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.STATE_STALE_DOING_RECOVERED, "Recovered stale in-progress run state", {
              previousPhase: currentRun.phase,
              previousCurrentPI: currentRun.currentPI ?? null,
              previousStartedAt: currentRun.startedAt ?? null,
              previousControlSessionId: currentRun.controlSessionId ?? null,
            }, { runId, reasonCode: RUN_REASON.STALE_DOING_RECOVERED });
            await showToast(ctx, "Run: recovered stale in-progress state from interrupted session", "warning");
          }

          let prd = await ensurePrd(repoRoot);
          const workspaceRoot = await resolveNodeWorkspaceRoot(repoRoot);
          const workspaceAbs = workspaceRoot === "." ? repoRoot : path.join(repoRoot, workspaceRoot);
          const prerequisites = validateRunPrerequisites(prd);
          if (!prerequisites.ok) {
            const event = prerequisites.reasonCode === RUN_REASON.PRD_INCOMPLETE
              ? RUN_EVENT.BLOCKED_PRD_INCOMPLETE
              : prerequisites.reasonCode === RUN_REASON.NO_TASKS
                ? RUN_EVENT.BLOCKED_NO_TASKS
                : RUN_EVENT.BLOCKED_NO_QUALITY_GATES;
            await logRunEvent(ctx, repoRoot, "warn", event, "Run blocked during preflight validation", {
              ...(prerequisites.extra ?? {}),
            }, { runId, ...(prerequisites.reasonCode ? { reasonCode: prerequisites.reasonCode } : {}) });
            return prerequisites.message ?? "Run blocked during preflight validation.";
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
          await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_INVALID_TASK_STATE, "Run blocked: invalid in_progress task state", {
            inProgressTaskIds: inProgress.map((t) => t.id),
          }, { runId, reasonCode: RUN_REASON.INVALID_TASK_STATE });
          return judge.reason.concat(["", "See tasks[].lastAttempt.judge.nextActions in .mario/prd.json."]).join("\n");
        }

        const taskGraphIssue = validateTaskGraph(prd);
        if (taskGraphIssue) {
          const focusTask = (prd.tasks ?? []).find((t) => t.id === taskGraphIssue.taskId) ?? (prd.tasks ?? [])[0];
          if (focusTask) {
            const state = await bumpIteration(repoRoot);
            const attemptAt = nowIso();
            const gates: PrdGatesAttempt = { ok: false, commands: [] };
            const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
            const judge: PrdJudgeAttempt = {
              status: "FAIL",
              exitSignal: false,
              reason: [
                formatReasonCode(taskGraphIssue.reasonCode),
                taskGraphIssue.message,
              ],
              nextActions: taskGraphIssue.nextActions,
            };
            prd = await persistBlockedTaskAttempt({
              ctx,
              repoRoot,
              prd,
              task: focusTask,
              attemptAt,
              iteration: state.iteration,
              gates,
              ui,
              judge,
              runId,
            });
          }
          await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_TASK_GRAPH, "Run blocked: invalid task dependency graph", {
            reasonCode: taskGraphIssue.reasonCode,
            taskId: taskGraphIssue.taskId,
            message: taskGraphIssue.message,
          }, { runId, taskId: taskGraphIssue.taskId, reasonCode: taskGraphIssue.reasonCode });
          return [
            formatReasonCode(taskGraphIssue.reasonCode),
            taskGraphIssue.message,
            ...taskGraphIssue.nextActions,
          ].join("\n");
        }

          const frontendSync = await syncFrontendAgentsConfig({
            repoRoot,
            workspaceRoot,
            prd,
          });
          if (frontendSync.parseWarnings > 0) {
            await showToast(ctx, `Run warning: AGENTS.md parse warnings (${frontendSync.parseWarnings})`, "warning");
          }

        const maxItems = parseMaxItems(args.max_items);

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
          await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.UI_CAPABILITIES, "Discovered agent-browser capabilities", {
            available: agentBrowserCaps.available,
            version: agentBrowserCaps.version,
            openUsage: agentBrowserCaps.openUsage,
            commands: agentBrowserCaps.commands,
            notes: agentBrowserCaps.notes,
          }, { runId });
        }

          const runStartIteration = (await readRunState(repoRoot)).iteration;

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
          const runLog = async (
            level: "info" | "warn" | "error",
            event: string,
            message: string,
            extra?: Record<string, unknown>,
            meta?: RunLogMeta,
          ): Promise<void> => {
            await logRunEvent(ctx, repoRoot, level, event, message, extra, meta);
          };
          const logGateRunResults = async (
            phase: RunPhaseName,
            taskId: string,
            gateResults: GateRunItem[],
          ): Promise<void> => {
            await logGateRunResultsPhase({
              phase,
              taskId,
              gateResults,
              runCtx,
              logRunEvent: runLog,
            });
          };
          const runUiVerifyForTask = async (taskId: string): Promise<{ ok: boolean; note?: string } | null> => {
            return runUiVerifyForTaskPhase({
              shouldRunUiVerify,
              taskId,
              ctx,
              uiVerifyCmd,
              uiVerifyUrl,
              waitMs: TIMEOUTS.UI_VERIFY_WAIT_MS,
              runCtx,
              logRunEvent: runLog,
            });
          };
          await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.STARTED, "Run started", {
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

            const dependencyBlockers = getTaskDependencyBlockers(prd, task);
            if (dependencyBlockers.pending.length > 0 || dependencyBlockers.missing.length > 0) {
              const blockerTask = dependencyBlockers.pending[0];
              const missingDep = dependencyBlockers.missing[0] ?? "unknown";
              const state = await bumpIteration(repoRoot);
              const attemptAt = nowIso();
              const gates: PrdGatesAttempt = { ok: false, commands: [] };
              const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
              const detail = blockerTask
                ? `Cannot execute ${task.id} before dependency ${blockerTask.id} (${blockerTask.title}) is completed.`
                : `Cannot execute ${task.id} because dependency ${missingDep} is missing from .mario/prd.json.`;
              const judge: PrdJudgeAttempt = {
                status: "FAIL",
                exitSignal: false,
                reason: [
                  formatReasonCode(RUN_REASON.PREREQ_TASK_PENDING),
                  detail,
                ],
                nextActions: [
                  blockerTask
                    ? `Complete ${blockerTask.id} first, then rerun /mario-devx:run 1.`
                    : `Fix missing dependency ${missingDep} in .mario/prd.json, then rerun /mario-devx:run 1.`,
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
              runNotes.push(`Blocked before execution: unresolved dependency for ${task.id}.`);
              await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.BLOCKED_PREREQ, `Run blocked: unresolved dependency for ${task.id}`, {
                taskId: task.id,
                dependencyTaskIds: dependencyBlockers.pending.map((x) => x.id),
                missingDependencies: dependencyBlockers.missing,
              }, { runId, taskId: task.id, reasonCode: RUN_REASON.PREREQ_TASK_PENDING });
              await showToast(ctx, blockerTask
                ? `Run blocked: ${task.id} requires ${blockerTask.id}`
                : `Run blocked: ${task.id} has missing dependency ${missingDep}`,
              "warning");
              break;
            }

            const effectiveDoneWhen = resolveEffectiveDoneWhen(prd, task);
            const gateCommands = toGateCommands(effectiveDoneWhen);
            attempted += 1;
            logInfo("task", `Starting ${task.id}: ${task.title}`);

            const shouldReconcileFirst = task.status === "blocked";
            if (shouldReconcileFirst) {
              const reconcileGateResult = await runGateCommands(gateCommands, ctx.$, runCtx.workspaceAbs);
              await logGateRunResults(RUN_PHASE.RECONCILE, task.id, reconcileGateResult.results);
              if (reconcileGateResult.ok) {
                const uiResult = await runUiVerifyForTask(task.id);

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
                  await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_UI_PREREQ, `Run blocked: UI prerequisites missing for ${task.id}`, {
                    taskId: task.id,
                    uiVerifyRequired,
                    cliOk,
                    skillOk,
                    browserOk,
                    autoInstallAttempted,
                  }, { runId, taskId: task.id, reasonCode: RUN_REASON.UI_PREREQ_MISSING });
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
                  await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_UI_RECONCILE, `Run blocked: UI verification failed during reconcile for ${task.id}`, {
                    taskId: task.id,
                    uiNote: uiResult?.note ?? null,
                  }, { runId, taskId: task.id, reasonCode: RUN_REASON.UI_VERIFY_FAILED });
                  await showToast(ctx, `Run stopped: UI verification failed on ${task.id}`, "warning");
                  break;
                }

                await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.VERIFY_START, "Starting verifier pass (reconcile)", {
                  taskId: task.id,
                }, { runId, taskId: task.id });
                const verifierPrompt = await buildPrompt(
                  repoRoot,
                  "verify",
                  buildVerifierContextText({
                    task,
                    doneWhen: effectiveDoneWhen,
                    gates: reconcileGateResult.results,
                    uiResult,
                    ...(uiResult?.note ? { uiNote: uiResult.note } : {}),
                    visualDirection: prd.ui.visualDirection,
                    uxRequirements: prd.ui.uxRequirements,
                    styleReferences: prd.ui.styleReferences,
                    caps: agentBrowserCaps,
                    uiUrl: uiVerifyUrl,
                  }),
                );
                const verifierOutcome = await resolveVerifierJudge({
                  ctx,
                  repoRoot,
                  verifierPrompt,
                  runId,
                  taskId: task.id,
                  capabilitySummary: buildCapabilitySummary(agentBrowserCaps),
                  ...(context.agent ? { agent: context.agent } : {}),
                });
                if ("transportFailure" in verifierOutcome) {
                  const judge = {
                    ...verifierOutcome.transportFailure,
                    reason: [
                      formatReasonCode(RUN_REASON.VERIFIER_TRANSPORT_EOF),
                      `Verifier transport failed during reconcile: ${verifierOutcome.errorMessage}`,
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
                  await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_VERIFY_TRANSPORT, `Run blocked: verifier transport failed during reconcile for ${task.id}`, {
                    taskId: task.id,
                    error: verifierOutcome.errorMessage,
                  }, { runId, taskId: task.id, reasonCode: RUN_REASON.VERIFIER_TRANSPORT_EOF });
                  await showToast(ctx, `Run stopped: verifier transport failed on ${task.id}`, "warning");
                  break;
                }
                const judge = applyRepeatedFailureBackpressure(task.lastAttempt, verifierOutcome.judge);
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
                  await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.RECONCILE_PASS, `Run reconciled ${task.id}`, {
                    taskId: task.id,
                  }, { runId, taskId: task.id });
                  await showToast(ctx, `Run: reconciled ${task.id} (already passing)`, "success");
                  continue;
                }

                logWarning("task", `${task.id} blocked during reconcile: ${judge.reason?.[0] ?? "No reason provided"}`);
                runNotes.push(`Reconcile failed for ${task.id}; falling back to build/repair.`);
                await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.RECONCILE_VERIFIER_FAIL, `Verifier failed during reconcile; falling back to build/repair for ${task.id}`, {
                  taskId: task.id,
                  reason: judge.reason?.[0] ?? "No reason provided",
                }, { runId, taskId: task.id, reasonCode: RUN_REASON.VERIFIER_FAILED });
                await showToast(ctx, `Run: reconcile failed for ${task.id}; attempting build/repair`, "info");
              }
            } else {
              await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.RECONCILE_SKIPPED, "Skipping reconcile pass for non-blocked task", {
                taskId: task.id,
                taskStatus: task.status,
              }, { runId, taskId: task.id });
            }

            prd = setPrdTaskStatus(prd, task.id, "in_progress");
            await writePrdJson(repoRoot, prd);

          const state = await bumpIteration(repoRoot);
          const attemptAt = nowIso();
          const carryForwardIssues = collectCarryForwardIssues(task);
          if (carryForwardIssues.length > 0) {
            await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.FEEDBACK_APPLIED, "Applied carry-forward verifier findings", {
              taskId: task.id,
              findings: carryForwardIssues,
            }, { runId, taskId: task.id });
          }

          const iterationPlan = buildIterationTaskPlan({
            task,
            prd,
            effectiveDoneWhen,
            carryForwardIssues,
          });
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
              await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_HEARTBEAT, `Run blocked: lock heartbeat failed during ${phase}`, {
                taskId: task.id,
                phase,
                lockPath: runLockPath(repoRoot),
              }, { runId, taskId: task.id, reasonCode: RUN_REASON.HEARTBEAT_FAILED });
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
              const buildSnapshotBefore = await captureWorkspaceSnapshot(repoRoot);
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

              const idle = await waitForSessionIdleStableDetailed(ctx, ws.sessionId, TIMEOUTS.SESSION_IDLE_TIMEOUT_MS);
              if (!idle.ok) {
                if (idle.reason === "timeout-unknown") {
                  await failEarly([
                    formatReasonCode(RUN_REASON.WORK_SESSION_STATUS_UNKNOWN),
                    "Work session status remained unknown while waiting for build to finish.",
                  ], [
                    "Check OpenCode session health via /sessions and rerun /mario-devx:run 1.",
                    "If this repeats, restart OpenCode and rerun the command.",
                  ]);
                  await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_WORK_STATUS_UNKNOWN, `Run blocked: unknown work session status for ${task.id}`, {
                    taskId: task.id,
                    unknownChecks: idle.unknownChecks,
                    activeChecks: idle.activeChecks,
                  }, { runId, taskId: task.id, reasonCode: RUN_REASON.WORK_SESSION_STATUS_UNKNOWN });
                  await showToast(ctx, `Run stopped: unknown work session status on ${task.id}`, "warning");
                  break;
                }
                const gates: PrdGatesAttempt = { ok: false, commands: [] };
                const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
                const judge: PrdJudgeAttempt = {
                  status: "FAIL",
                  exitSignal: false,
                  reason: ["Build timed out waiting for the work session to go idle."],
                  nextActions: ["Rerun /mario-devx:status; if it remains stuck, inspect the work session via /sessions."],
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
                await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_BUILD_TIMEOUT, `Run blocked: build timed out for ${task.id}`, {
                  taskId: task.id,
                }, { runId, taskId: task.id, reasonCode: RUN_REASON.BUILD_TIMEOUT });
                await showToast(ctx, `Run stopped: build timed out on ${task.id}`, "warning");
                break;
              }

              if (!(await heartbeatRunLock(repoRoot))) {
                await blockForHeartbeatFailure("after-build-idle");
                await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
                break;
              }

              const buildSnapshotAfter = await captureWorkspaceSnapshot(repoRoot);
              const buildDelta = summarizeWorkspaceDelta(buildSnapshotBefore, buildSnapshotAfter);
              if (buildDelta.changed === 0) {
                await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.REPAIR_NO_PROGRESS, "No workspace changes after build prompt", {
                  taskId: task.id,
                  phase: "build",
                  changed: buildDelta.changed,
                }, { runId, taskId: task.id, reasonCode: RUN_REASON.WORK_SESSION_NO_PROGRESS });
              }

              const taskRepairStartedAt = Date.now();
              let repairAttempts = 0;
              let totalRepairAttempts = 0;
              const maxTotalRepairAttempts = LIMITS.MAX_TOTAL_REPAIR_ATTEMPTS;
              let noProgressStreak = 0;
              let noChangeStreak = buildDelta.changed === 0 ? 1 : 0;
              let stoppedForNoChanges = false;
              let lastNoChangeGate: string | null = null;
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
                    event: RUN_EVENT.BOOTSTRAP_INSTALL_FAILED,
                    message: `Dependency install failed while bootstrapping ${task.id}`,
                    reasonCode: RUN_REASON.BOOTSTRAP_INSTALL_FAILED,
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

                if (repairAttempts > 0 && (elapsedMs >= TIMEOUTS.MAX_TASK_REPAIR_MS || noProgressStreak >= LIMITS.MAX_NO_PROGRESS_STREAK || totalRepairAttempts >= maxTotalRepairAttempts)) {
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
                    event: RUN_EVENT.SCAFFOLD_DEFAULT_FAILED,
                    message: `Default scaffold command failed for ${task.id}`,
                    reasonCode: RUN_REASON.SCAFFOLD_COMMAND_FAILED,
                    runId,
                    taskId: task.id,
                  });
                  repairAttempts += 1;
                  totalRepairAttempts += 1;
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

                const repairPrompt = buildGateRepairPrompt({
                  taskId: task.id,
                  failedGate,
                  carryForwardIssues,
                  missingScript,
                  scaffoldHint,
                  scaffoldGateFailure: Boolean(gateResult.failed?.command && isScaffoldMissingGateCommand(gateResult.failed.command)),
                });

                const repairSnapshotBefore = await captureWorkspaceSnapshot(repoRoot);

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

                const repairIdle = await waitForSessionIdleStableDetailed(ctx, ws.sessionId, TIMEOUTS.REPAIR_IDLE_TIMEOUT_MS);
                if (!repairIdle.ok) {
                  if (repairIdle.reason === "timeout-unknown") {
                    await failEarly([
                      formatReasonCode(RUN_REASON.WORK_SESSION_STATUS_UNKNOWN),
                      "Work session status became unknown while waiting for repair turn to finish.",
                    ], [
                      "Check OpenCode session health via /sessions and rerun /mario-devx:run 1.",
                    ]);
                    await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_WORK_STATUS_UNKNOWN, `Run blocked: unknown work session status during repair for ${task.id}`, {
                      taskId: task.id,
                      unknownChecks: repairIdle.unknownChecks,
                      activeChecks: repairIdle.activeChecks,
                    }, { runId, taskId: task.id, reasonCode: RUN_REASON.WORK_SESSION_STATUS_UNKNOWN });
                  }
                  break;
                }

                const repairSnapshotAfter = await captureWorkspaceSnapshot(repoRoot);
                const repairDelta = summarizeWorkspaceDelta(repairSnapshotBefore, repairSnapshotAfter);
                if (repairDelta.changed === 0) {
                  noChangeStreak += 1;
                  lastNoChangeGate = failedGate;
                  await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.REPAIR_NO_PROGRESS, "No workspace changes after repair attempt", {
                    taskId: task.id,
                    phase: "repair",
                    repairAttempt: repairAttempts + 1,
                    noChangeStreak,
                    failedGate,
                  }, { runId, taskId: task.id, reasonCode: RUN_REASON.WORK_SESSION_NO_PROGRESS });
                  if (noChangeStreak >= 2) {
                    stoppedForNoChanges = true;
                    break;
                  }
                } else {
                  noChangeStreak = 0;
                }

                repairAttempts += 1;
                totalRepairAttempts += 1;
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

              let latestGateResult = gateResult;
              let latestUiResult = latestGateResult.ok ? await runUiVerifyForTask(task.id) : null;

              if (!(await heartbeatRunLock(repoRoot))) {
                await blockForHeartbeatFailure("after-gates-ui");
                await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
                break;
              }

          let gates: PrdGatesAttempt = toGatesAttempt(latestGateResult);
          let ui: PrdUiAttempt = toUiAttempt({
            gateOk: latestGateResult.ok,
            uiResult: latestUiResult,
            uiVerifyEnabled,
            isWebApp,
            cliOk,
            skillOk,
            browserOk,
          });

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

          if (!latestGateResult.ok && stoppedForNoChanges) {
            await failEarly([
              formatReasonCode(RUN_REASON.WORK_SESSION_NO_PROGRESS),
              `Repair loop produced no source-file changes across consecutive attempts (last failing gate: ${lastNoChangeGate ?? "unknown"}).`,
            ], [
              "Inspect the work session output and ensure concrete file edits are applied.",
              "Apply explicit edits for the failing gate and acceptance artifacts, then rerun /mario-devx:run 1.",
            ]);
            await showToast(ctx, `Run stopped: no progress detected on ${task.id}`, "warning");
            break;
          }

          if (!latestGateResult.ok) {
            const failed = latestGateResult.failed
              ? `${latestGateResult.failed.command} (exit ${latestGateResult.failed.exitCode})`
              : "(unknown command)";
            const scaffoldHint = firstScaffoldHintFromNotes(task.notes);
            const missingScript = latestGateResult.failed
              ? await missingPackageScriptForCommand(repoRoot, workspaceRoot, latestGateResult.failed.command)
              : null;
            const elapsedMs = Date.now() - taskRepairStartedAt;
            const reasonCodes: string[] = [];
            if (missingScript) {
              reasonCodes.push(formatReasonCode(`MISSING_SCRIPT_${missingScript.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`));
            }
            if (task.id === "T-0002" && latestGateResult.failed?.command) {
              reasonCodes.push(formatReasonCode(RUN_REASON.QUALITY_BOOTSTRAP_INCOMPLETE));
            }
            if (latestGateResult.failed?.exitCode === 127) {
              reasonCodes.push(formatReasonCode(RUN_REASON.COMMAND_NOT_FOUND));
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
              `Auto-repair stopped after ${Math.round(elapsedMs / 1000)}s across ${repairAttempts} attempt(s) (total repair turns: ${totalRepairAttempts}/${maxTotalRepairAttempts}; no-progress or time budget reached).`,
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

          if (uiVerifyEnabled && isWebApp && uiVerifyRequired && latestUiResult && !latestUiResult.ok) {
            await failEarly([
              "UI verification failed.",
            ]);
            await showToast(ctx, `Run stopped: UI verification failed on ${task.id}`, "warning");
            break;
          }

          const artifactCheck = await checkAcceptanceArtifacts(repoRoot, task.acceptance ?? []);
          if (artifactCheck.missingFiles.length > 0 || artifactCheck.missingLabels.length > 0) {
            await failEarly([
              formatReasonCode(RUN_REASON.ACCEPTANCE_ARTIFACTS_MISSING),
              ...(artifactCheck.missingFiles.length > 0
                ? [`Missing expected files: ${artifactCheck.missingFiles.join(", ")}.`]
                : []),
              ...(artifactCheck.missingLabels.length > 0
                ? [`Missing expected navigation labels in app shell: ${artifactCheck.missingLabels.join(", ")}.`]
                : []),
            ], [
              ...(artifactCheck.missingFiles.length > 0
                ? [`Create required files: ${artifactCheck.missingFiles.join(", ")}.`]
                : []),
              ...(artifactCheck.missingLabels.length > 0
                ? ["Add required navigation labels to `src/app/layout.tsx` or `src/app/page.tsx`."]
                : []),
              "Then rerun /mario-devx:run 1.",
            ]);
            await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.BLOCKED_ACCEPTANCE_ARTIFACTS, `Run blocked: missing acceptance artifacts for ${task.id}`, {
              taskId: task.id,
              missingFiles: artifactCheck.missingFiles,
              missingLabels: artifactCheck.missingLabels,
            }, { runId, taskId: task.id, reasonCode: RUN_REASON.ACCEPTANCE_ARTIFACTS_MISSING });
            await showToast(ctx, `Run stopped: missing acceptance artifacts on ${task.id}`, "warning");
            break;
          }

          await showToast(
            ctx,
            `Gates: PASS${latestUiResult ? `; UI: ${latestUiResult.ok ? "PASS" : "FAIL"}` : ""}. Running verifier...`,
            "info",
          );

          let blockedByVerifierFailure = false;
          let judge: PrdJudgeAttempt | null = null;
          let semanticRepairAttempts = 0;
          let semanticNoProgressStreak = 0;

          while (true) {
            const verifierPrompt = await buildPrompt(
              repoRoot,
              "verify",
              buildVerifierContextText({
                task,
                doneWhen: effectiveDoneWhen,
                gates: latestGateResult.results,
                uiResult: latestUiResult,
                ...(latestUiResult?.note ? { uiNote: latestUiResult.note } : {}),
                visualDirection: prd.ui.visualDirection,
                uxRequirements: prd.ui.uxRequirements,
                styleReferences: prd.ui.styleReferences,
                caps: agentBrowserCaps,
                uiUrl: uiVerifyUrl,
              }),
            );

            await setWorkSessionTitle(ctx, ws.sessionId, `mario-devx (work) - judge ${task.id}`);
            await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.VERIFY_START, "Starting verifier pass", {
              taskId: task.id,
              semanticRepairAttempts,
            }, { runId, taskId: task.id });

            const verifierOutcome = await resolveVerifierJudge({
              ctx,
              repoRoot,
              verifierPrompt,
              runId,
              taskId: task.id,
              capabilitySummary: buildCapabilitySummary(agentBrowserCaps),
              ...(context.agent ? { agent: context.agent } : {}),
            });

            if ("transportFailure" in verifierOutcome) {
              const transportJudge = verifierOutcome.transportFailure;
              await failEarly(transportJudge.reason, transportJudge.nextActions);
              await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_VERIFY_TRANSPORT, `Run blocked: verifier transport failed for ${task.id}`, {
                taskId: task.id,
                error: verifierOutcome.errorMessage,
              }, { runId, taskId: task.id, reasonCode: RUN_REASON.VERIFIER_TRANSPORT_EOF });
              await showToast(ctx, `Run stopped: verifier transport failed on ${task.id}`, "warning");
              blockedByVerifierFailure = true;
              break;
            }

            if (!(await heartbeatRunLock(repoRoot))) {
              await blockForHeartbeatFailure("after-judge");
              await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
              blockedByVerifierFailure = true;
              break;
            }

            judge = applyRepeatedFailureBackpressure(task.lastAttempt, verifierOutcome.judge);
            const isPass = judge.status === "PASS" && judge.exitSignal;
            if (isPass) {
              break;
            }

            if (semanticRepairAttempts >= LIMITS.MAX_VERIFIER_REPAIR_ATTEMPTS || totalRepairAttempts >= maxTotalRepairAttempts) {
              break;
            }

            semanticRepairAttempts += 1;
            totalRepairAttempts += 1;
            const actionableReason = firstActionableJudgeReason(judge) ?? "Verifier failed to confirm acceptance.";
            const strictChecklist = semanticNoProgressStreak > 0
              ? "Repeated finding detected with no clear progress. Make explicit file edits that directly satisfy acceptance criteria; avoid generic refinements."
              : "";
            const semanticRepairPrompt = buildSemanticRepairPrompt({
              taskId: task.id,
              acceptance: task.acceptance ?? [],
              actionableReason,
              judge,
              carryForwardIssues,
              strictChecklist,
            });

            await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.REPAIR_SEMANTIC_START, "Starting verifier-driven semantic repair", {
              taskId: task.id,
              semanticRepairAttempt: semanticRepairAttempts,
              maxSemanticRepairAttempts: LIMITS.MAX_VERIFIER_REPAIR_ATTEMPTS,
              totalRepairAttempts,
              maxTotalRepairAttempts,
              primaryReason: actionableReason,
              noProgressStreak: semanticNoProgressStreak,
            }, { runId, taskId: task.id });
            await showToast(ctx, `Run: verifier requested targeted repair on ${task.id} (${semanticRepairAttempts}/${LIMITS.MAX_VERIFIER_REPAIR_ATTEMPTS}, total ${totalRepairAttempts}/${maxTotalRepairAttempts})`, "info");

            const semanticSnapshotBefore = await captureWorkspaceSnapshot(repoRoot);
            await setWorkSessionTitle(ctx, ws.sessionId, `mario-devx (work) - semantic repair ${task.id}`);
            await ctx.client.session.promptAsync({
              path: { id: ws.sessionId },
              body: {
                ...(context.agent ? { agent: context.agent } : {}),
                parts: [{ type: "text", text: semanticRepairPrompt }],
              },
            });

            if (!(await heartbeatRunLock(repoRoot))) {
              await blockForHeartbeatFailure("during-semantic-repair");
              await showToast(ctx, `Run stopped: lock heartbeat failed on ${task.id}`, "warning");
              blockedByVerifierFailure = true;
              break;
            }

            const semanticIdle = await waitForSessionIdleStableDetailed(ctx, ws.sessionId, TIMEOUTS.REPAIR_IDLE_TIMEOUT_MS);
            if (!semanticIdle.ok) {
              if (semanticIdle.reason === "timeout-unknown") {
                await failEarly([
                  formatReasonCode(RUN_REASON.WORK_SESSION_STATUS_UNKNOWN),
                  "Work session status became unknown while waiting for semantic repair to finish.",
                ], [
                  "Check OpenCode session health via /sessions and rerun /mario-devx:run 1.",
                ]);
                await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_WORK_STATUS_UNKNOWN, `Run blocked: unknown work session status during semantic repair for ${task.id}`, {
                  taskId: task.id,
                  unknownChecks: semanticIdle.unknownChecks,
                  activeChecks: semanticIdle.activeChecks,
                }, { runId, taskId: task.id, reasonCode: RUN_REASON.WORK_SESSION_STATUS_UNKNOWN });
                blockedByVerifierFailure = true;
                break;
              }
              await failEarly([
                `Semantic repair timed out waiting for idle (${Math.round(TIMEOUTS.REPAIR_IDLE_TIMEOUT_MS / 1000)}s).`,
              ], [
                "Retry /mario-devx:run 1.",
                "If this repeats, inspect the work session and reduce repair scope to concrete acceptance items.",
              ]);
              blockedByVerifierFailure = true;
              break;
            }

            const semanticSnapshotAfter = await captureWorkspaceSnapshot(repoRoot);
            const semanticDelta = summarizeWorkspaceDelta(semanticSnapshotBefore, semanticSnapshotAfter);
            if (semanticDelta.changed === 0) {
              semanticNoProgressStreak += 1;
              await logRunEvent(ctx, repoRoot, "warn", RUN_EVENT.REPAIR_NO_PROGRESS, "No workspace changes after semantic repair attempt", {
                taskId: task.id,
                phase: "semantic-repair",
                semanticRepairAttempt: semanticRepairAttempts,
                noProgressStreak: semanticNoProgressStreak,
              }, { runId, taskId: task.id, reasonCode: RUN_REASON.WORK_SESSION_NO_PROGRESS });
              if (semanticNoProgressStreak >= 2 || semanticRepairAttempts >= LIMITS.MAX_VERIFIER_REPAIR_ATTEMPTS) {
                await failEarly([
                  formatReasonCode(RUN_REASON.WORK_SESSION_NO_PROGRESS),
                  `No source file changes detected after semantic repair attempt ${semanticRepairAttempts}.`,
                  `Primary blocker remains: ${actionableReason}`,
                ], [
                  "Inspect the work session output and ensure concrete file edits are applied.",
                  "Apply explicit edits for required acceptance artifacts, then rerun /mario-devx:run 1.",
                ]);
                blockedByVerifierFailure = true;
                break;
              }
            } else {
              semanticNoProgressStreak = 0;
            }

            latestGateResult = await runGateCommands(gateCommands, ctx.$, runCtx.workspaceAbs);
            await logGateRunResults(RUN_PHASE.REPAIR, task.id, latestGateResult.results);
            latestUiResult = latestGateResult.ok ? await runUiVerifyForTask(task.id) : null;

            gates = toGatesAttempt(latestGateResult);
            ui = toUiAttempt({
              gateOk: latestGateResult.ok,
              uiResult: latestUiResult,
              uiVerifyEnabled,
              isWebApp,
              cliOk,
              skillOk,
              browserOk,
            });

            if (!latestGateResult.ok) {
              const failed = latestGateResult.failed
                ? `${latestGateResult.failed.command} (exit ${latestGateResult.failed.exitCode})`
                : "(unknown command)";
              await failEarly([
                formatReasonCode(RUN_REASON.SEMANTIC_REPAIR_GATE_REGRESSION),
                `Deterministic gate failed after semantic repair: ${failed}.`,
              ], [
                `Fix deterministic gate '${failed}'.`,
                "Then rerun /mario-devx:run 1.",
              ]);
              blockedByVerifierFailure = true;
              break;
            }

            if (uiVerifyEnabled && isWebApp && uiVerifyRequired && latestUiResult && !latestUiResult.ok) {
              await failEarly([
                formatReasonCode(RUN_REASON.SEMANTIC_REPAIR_UI_REGRESSION),
                "UI verification failed after semantic repair.",
              ], [
                "Fix UI verification failures introduced by semantic repair.",
                "Then rerun /mario-devx:run 1.",
              ]);
              blockedByVerifierFailure = true;
              break;
            }
          }

          if (blockedByVerifierFailure || !judge) {
            break;
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
              const blockedReason = firstActionableJudgeReason(judge) ?? judge.reason?.[0] ?? "No reason provided";
              logWarning("task", `${task.id} blocked: ${blockedReason}`);
              await logTaskBlocked(ctx, repoRoot, task.id, blockedReason);
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

          const blockedThisRun = (prd.tasks ?? []).some((t) => {
            if (t.status !== "blocked" || !t.lastAttempt) return false;
            return t.lastAttempt.iteration > runStartIteration;
          });
          const finalRunStatus = blockedThisRun ? "BLOCKED" : "DONE";

          // Mark the run complete once the loop ends.
          await updateRunState(repoRoot, {
            status: finalRunStatus,
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
          await logRunEvent(ctx, repoRoot, finalRunStatus === "DONE" ? "info" : "warn", RUN_EVENT.FINISHED, "Run finished", {
            attempted,
            completed,
            status: finalRunStatus,
            latestTaskId: latestTask?.id ?? null,
            reason: judgeTopReason,
          }, { runId, ...(latestTask?.id ? { taskId: latestTask.id } : {}) });

          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.FATAL_EXCEPTION, "Run crashed with unhandled exception", {
            error: errorMessage,
            stack: error instanceof Error ? error.stack ?? "" : "",
          }, { runId, reasonCode: RUN_REASON.RUN_FATAL_EXCEPTION });
          const current = await readRunState(repoRoot);
          await writeRunState(repoRoot, {
            ...current,
            status: "BLOCKED",
            phase: "run",
            updatedAt: nowIso(),
            ...(context.sessionID ? { controlSessionId: context.sessionID } : {}),
            lastRunAt: nowIso(),
            lastRunResult: `Run failed unexpectedly: ${errorMessage}. See .mario/state/mario-devx.log for details.`,
          });
          await showToast(ctx, "Run crashed unexpectedly; see mario-devx.log for details", "warning");
          return `Run failed unexpectedly: ${errorMessage}\nCheck .mario/state/mario-devx.log and rerun /mario-devx:run 1.`;
        } finally {
          await releaseRunLock(repoRoot);
        }
      },
    }),

    ...backlogTools,

    ...statusTool,
    ...doctorTool,

  };
};
