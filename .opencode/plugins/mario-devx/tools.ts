import { getRepoRoot } from "./paths";
import {
  LAST_QUESTION_KEY,
  compactIdea,
  extractStyleReferencesFromText,
  hasNonEmpty,
  mergeStyleReferences,
  normalizeTextArray,
} from "./interview";
import {
  makeTask,
  normalizeTaskId,
  setPrdTaskLastAttempt,
  setPrdTaskStatus,
} from "./planner";
import {
  ensureWorkSession,
  extractTextFromPromptResponse,
  updateRunState,
} from "./runner";
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
  WIZARD_REQUIREMENTS,
} from "./config";
import { logError, logInfo } from "./errors";
import { logEvent, logPrdComplete, redactForLog } from "./logging";
import { type RunLogMeta } from "./run-types";
import { runShellCommand } from "./shell";
import { createVerifierPhaseSession, disposeVerifierPhaseSession, runVerifierTurn } from "./verifier-session";
import { buildVerifierTransportFailureJudge, enforceJudgeOutputQuality } from "./run-verifier";
import { RUN_EVENT, RUN_REASON } from "./run-contracts";
import { createStatusTool } from "./tool-status";
import { createDoctorTool } from "./tool-doctor";
import { createBacklogTools } from "./tool-backlog";
import { createNewTool } from "./tool-new";
import { createRunTool } from "./tool-run";
import type { PluginContext } from "./tool-common";

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

/** Applies interview updates to the PRD with explicit field mapping. */
const applyInterviewUpdates = (prd: PrdJson, updates: InterviewUpdates | undefined): PrdJson => {
  if (!updates) return prd;

  const updatesAny = updates as Record<string, unknown>;
  const nestedUi = (updatesAny.ui && typeof updatesAny.ui === "object") ? updatesAny.ui as Record<string, unknown> : null;
  const nestedDocs = (updatesAny.docs && typeof updatesAny.docs === "object") ? updatesAny.docs as Record<string, unknown> : null;
  const nestedProduct = (updatesAny.product && typeof updatesAny.product === "object") ? updatesAny.product as Record<string, unknown> : null;

  let next: PrdJson = {
    ...prd,
    ui: { ...prd.ui },
    docs: { ...prd.docs },
    product: { ...prd.product },
    verificationPolicy: { ...prd.verificationPolicy },
  };

  if (typeof updates.idea === "string") next.idea = updates.idea.trim();
  if (updates.platform) next.platform = updates.platform;
  if (typeof updates.frontend === "boolean") next.frontend = updates.frontend;
  if (typeof updates.uiVerificationRequired === "boolean") next.uiVerificationRequired = updates.uiVerificationRequired;
  if (updates.language) next.language = updates.language;
  if (typeof updates.framework === "string") next.framework = updates.framework.trim();
  if (updates.framework === null) next.framework = null;

  const designSystem = updates.uiDesignSystem ?? nestedUi?.designSystem;
  if (designSystem === "none" || designSystem === "tailwind" || designSystem === "shadcn" || designSystem === "custom") {
    next.ui.designSystem = designSystem;
  }

  const styleReferenceMode = updates.uiStyleReferenceMode ?? nestedUi?.styleReferenceMode;
  if (styleReferenceMode === "url" || styleReferenceMode === "screenshot" || styleReferenceMode === "mixed") {
    next.ui.styleReferenceMode = styleReferenceMode;
  }

  const styleRefs = Array.isArray(updates.uiStyleReferences)
    ? updates.uiStyleReferences
    : (Array.isArray(nestedUi?.styleReferences) ? nestedUi.styleReferences as string[] : undefined);
  if (styleRefs) {
    next.ui.styleReferences = mergeStyleReferences(next.ui.styleReferences, normalizeTextArray(styleRefs));
  }

  const visualDirection = updates.uiVisualDirection ?? (typeof nestedUi?.visualDirection === "string" ? nestedUi.visualDirection : undefined);
  if (typeof visualDirection === "string") next.ui.visualDirection = visualDirection.trim();

  const uxRequirements = Array.isArray(updates.uiUxRequirements)
    ? updates.uiUxRequirements
    : (Array.isArray(nestedUi?.uxRequirements) ? nestedUi.uxRequirements as string[] : undefined);
  if (uxRequirements) next.ui.uxRequirements = normalizeTextArray(uxRequirements);

  const readmeRequired = updates.docsReadmeRequired ?? (typeof nestedDocs?.readmeRequired === "boolean" ? nestedDocs.readmeRequired : undefined);
  if (typeof readmeRequired === "boolean") next.docs.readmeRequired = readmeRequired;

  const readmeSections = Array.isArray(updates.docsReadmeSections)
    ? updates.docsReadmeSections
    : (Array.isArray(nestedDocs?.readmeSections) ? nestedDocs.readmeSections as string[] : undefined);
  if (readmeSections) next.docs.readmeSections = normalizeTextArray(readmeSections);

  const targetUsers = Array.isArray(updates.targetUsers)
    ? updates.targetUsers
    : (Array.isArray(nestedProduct?.targetUsers) ? nestedProduct.targetUsers as string[] : undefined);
  if (targetUsers) next.product.targetUsers = normalizeTextArray(targetUsers);

  const userProblems = Array.isArray(updates.userProblems)
    ? updates.userProblems
    : (Array.isArray(nestedProduct?.userProblems) ? nestedProduct.userProblems as string[] : undefined);
  if (userProblems) next.product.userProblems = normalizeTextArray(userProblems);

  const mustHaveFeatures = Array.isArray(updates.mustHaveFeatures)
    ? updates.mustHaveFeatures
    : (Array.isArray(nestedProduct?.mustHaveFeatures) ? nestedProduct.mustHaveFeatures as string[] : undefined);
  if (mustHaveFeatures) next.product.mustHaveFeatures = normalizeTextArray(mustHaveFeatures);

  const nonGoals = Array.isArray(updates.nonGoals)
    ? updates.nonGoals
    : (Array.isArray(nestedProduct?.nonGoals) ? nestedProduct.nonGoals as string[] : undefined);
  if (nonGoals) next.product.nonGoals = normalizeTextArray(nonGoals);

  const successMetrics = Array.isArray(updates.successMetrics)
    ? updates.successMetrics
    : (Array.isArray(nestedProduct?.successMetrics) ? nestedProduct.successMetrics as string[] : undefined);
  if (successMetrics) next.product.successMetrics = normalizeTextArray(successMetrics);

  const constraints = Array.isArray(updates.constraints)
    ? updates.constraints
    : (Array.isArray(nestedProduct?.constraints) ? nestedProduct.constraints as string[] : undefined);
  if (constraints) next.product.constraints = normalizeTextArray(constraints);

  if (Array.isArray(updates.qualityGates)) {
    next.qualityGates = normalizeTextArray(updates.qualityGates);
  }

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
  try {
    await ctx.client.tui.showToast({
      body: {
        message,
        variant,
      },
    });
  } catch {
    // Best-effort notifications only.
  }
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
  capabilitySummary: string;
}): Promise<string> => {
  const { ctx, repoRoot, promptText, runId, taskId, agent, capabilitySummary } = opts;
  const maxAttempts = 3;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let verifierPhaseSession: { sessionId: string; baselineMessageId: string; baselineFingerprint: string } | null = null;
    try {
      verifierPhaseSession = await createVerifierPhaseSession({
        ctx,
        capabilitySummary,
        ...(agent ? { agent } : {}),
      });
      await updateRunState(repoRoot, {
        verifierSessionId: verifierPhaseSession.sessionId,
      });
      await logRunEvent(ctx, repoRoot, "info", "verifier.phase.create.ok", "Verifier phase session created", {
        verifierSessionId: verifierPhaseSession.sessionId,
        baselineFingerprint: verifierPhaseSession.baselineFingerprint,
        attempt,
      }, { runId, taskId });
      await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.VERIFY_PROMPT_SENT, "Verifier prompt sent", {
        attempt,
        maxAttempts,
        verifierSessionId: verifierPhaseSession.sessionId,
      }, { runId, taskId });
      const verifierText = await runVerifierTurn({
        ctx,
        sessionId: verifierPhaseSession.sessionId,
        promptText,
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
    } finally {
      if (verifierPhaseSession?.sessionId) {
        await disposeVerifierPhaseSession(ctx, verifierPhaseSession.sessionId).catch(() => "failed");
      }
      await updateRunState(repoRoot, {
        verifierSessionId: undefined,
      });
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

    ...createRunTool({
      ctx,
      repoRoot,
      ensurePrd,
      nowIso,
      formatReasonCode,
      firstActionableJudgeReason,
      collectCarryForwardIssues,
      applyRepeatedFailureBackpressure,
      resolveVerifierJudge,
      persistBlockedTaskAttempt,
      showToast,
      logRunEvent,
      runShellWithFailureLog,
      buildCapabilitySummary,
    }),

    ...backlogTools,

    ...statusTool,
    ...doctorTool,

  };
};
