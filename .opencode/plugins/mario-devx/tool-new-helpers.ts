import { LAST_QUESTION_KEY, compactIdea, mergeStyleReferences, normalizeTextArray } from "./interview";
import { makeTask, normalizeTaskId } from "./planner";
import { buildCompileInterviewPrompt, buildCompileRepairPrompt, buildInterviewPrompt, buildInterviewTurnRepairPrompt, buildQualityGatePresetPrompt, buildQualityGatePresetRepairPrompt, buildRepeatedQuestionRepairPrompt, buildTaskGenerationPrompt } from "./prompt-builders";
import { withTemporaryWorkSession, resolvePromptText } from "./runner";
import { logError } from "./errors";
import { logEvent } from "./logging";
import type { PrdJson, PrdTask } from "./prd";
import type { PluginContext } from "./tool-common";
import { extractFirstJsonObject, extractTaggedBlock, tryParseJson } from "./llm-json";

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

type InterviewTurn =
  | {
    ok: true;
    done: true;
    question: null;
  }
  | {
    ok: true;
    done: false;
    question: string;
  }
  | {
    ok: false;
    done: false;
    question: string | null;
    error: string;
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
export const INTERVIEW_ANSWER_PREFIX = "a-";
export const STYLE_REFS_ACK_KEY = "__style_refs_ack";
export const QUALITY_GATES_STATE_KEY = "__quality_gates_selection";
export const STYLE_REFS_REQUIRED_QUESTION = "Share at least one style reference URL/image path, or reply 'none' to proceed without references.";

export const parseQualityGateSelectionState = (raw: string | undefined): QualityGateSelectionState | null => {
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

export const writeQualityGateSelectionState = (prd: PrdJson, state: QualityGateSelectionState | null): PrdJson => {
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

export const isNoneLikeAnswer = (input: string): boolean => {
  return /^(none|no references?|n\/a|na)$/i.test(input.trim());
};

const generateFallbackTasks = (prd: PrdJson): PrdTask[] => {
  const tasks: PrdTask[] = [];
  let n = 1;
  const doneWhen = prd.qualityGates || [];

  tasks.push(makeTask({
    id: normalizeTaskId(n++),
    title: `Scaffold project baseline: ${compactIdea(prd.idea || "project")}`,
    doneWhen,
    labels: ["scaffold"],
    acceptance: ["Project scaffolding exists and runs locally."],
  }));

  if (doneWhen.length > 0) {
    tasks.push(makeTask({
      id: normalizeTaskId(n++),
      title: "Make quality gates pass consistently",
      doneWhen,
      labels: ["quality"],
      acceptance: ["All configured quality gates pass locally."],
      dependsOn: [normalizeTaskId(1)],
    }));
  }

  for (const feature of prd.product.mustHaveFeatures || []) {
    tasks.push(makeTask({
      id: normalizeTaskId(n++),
      title: `Implement: ${feature}`,
      doneWhen,
      labels: ["feature"],
      acceptance: [feature],
      dependsOn: doneWhen.length > 0 ? [normalizeTaskId(2)] : [normalizeTaskId(1)],
    }));
  }

  if (tasks.length === 0) {
    tasks.push(makeTask({
      id: normalizeTaskId(1),
      title: `Implement MVP: ${compactIdea(prd.idea || "project")}`,
      doneWhen,
      labels: ["mvp"],
      acceptance: ["Core MVP is implemented and verifiable."],
    }));
  }

  return tasks;
};

export const seedTasksFromPrd = async (repoRoot: string, prd: PrdJson, pluginCtx: PluginContext): Promise<PrdJson> => {
  if (Array.isArray(prd.tasks) && prd.tasks.length > 0) {
    return prd;
  }

  return withTemporaryWorkSession({
    ctx: pluginCtx,
    repoRoot,
    run: async (ws) => {
      const taskGenPrompt = buildTaskGenerationPrompt(prd);

      await logEvent(pluginCtx, repoRoot, {
        level: "info",
        event: "task-generation.start",
        message: "Generating tasks from PRD via LLM",
      });
      const taskResponse = await pluginCtx.client.session.prompt({
        path: { id: ws.sessionId },
        body: { parts: [{ type: "text", text: taskGenPrompt }] },
      });

      const taskText = await resolvePromptText(pluginCtx, ws.sessionId, taskResponse);
      const taskJson = extractTaggedBlock(taskText, "TASK_JSON");

      let tasks: PrdTask[];
      if (taskJson) {
        const parsedResult = tryParseJson<{
          tasks?: Array<{
            id?: unknown;
            title?: unknown;
            doneWhen?: unknown;
            labels?: unknown;
            acceptance?: unknown;
            dependsOn?: unknown;
            notes?: unknown;
          }>;
        }>(taskJson);
        if (parsedResult.ok === true) {
          tasks = (parsedResult.value.tasks ?? [])
            .map((task, idx) => {
              const title = typeof task.title === "string" ? task.title.trim() : "";
              if (!title) return null;
              return makeTask({
                id: typeof task.id === "string" && task.id.trim().length > 0 ? task.id : normalizeTaskId(idx + 1),
                title,
                doneWhen: Array.isArray(task.doneWhen) ? normalizeTextArray(task.doneWhen as string[]) : (prd.qualityGates || []),
                labels: Array.isArray(task.labels) ? normalizeTextArray(task.labels as string[]) : ["feature"],
                acceptance: Array.isArray(task.acceptance) ? normalizeTextArray(task.acceptance as string[]) : [title],
                ...(Array.isArray(task.dependsOn) ? { dependsOn: normalizeTextArray(task.dependsOn as string[]) } : {}),
                ...(Array.isArray(task.notes) ? { notes: normalizeTextArray(task.notes as string[]) } : {}),
              });
            })
            .filter((task): task is PrdTask => Boolean(task));
          await logEvent(pluginCtx, repoRoot, {
            level: "info",
            event: "task-generation.complete",
            message: "Task generation completed",
            extra: { tasks: tasks.length },
          });
        } else {
          logError("task-generation", `Failed to parse LLM task generation, using fallback: ${parsedResult.error}`);
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
    },
  });
};

const interviewTranscript = (prd: PrdJson): string[] => {
  const entries = Object.entries(prd.wizard.answers ?? {})
    .filter(([key]) => key !== LAST_QUESTION_KEY)
    .map(([key, value], index) => {
      const qMatch = key.match(/^q-(\d{5,})$/);
      if (qMatch) {
        return { key, value, index, kind: "q" as const, ts: Number.parseInt(qMatch[1], 10) };
      }
      const aMatch = key.match(/^(?:a|turn)-(\d{5,})$/);
      if (aMatch) {
        return { key, value, index, kind: "a" as const, ts: Number.parseInt(aMatch[1], 10) };
      }
      return { key, value, index, kind: "other" as const, ts: Number.NaN };
    })
    .filter((entry) => entry.kind !== "other")
    .sort((a, b) => {
      const aTsValid = Number.isFinite(a.ts);
      const bTsValid = Number.isFinite(b.ts);
      if (aTsValid && bTsValid && a.ts !== b.ts) {
        return a.ts - b.ts;
      }
      if (a.kind !== b.kind) {
        return a.kind === "q" ? -1 : 1;
      }
      return a.index - b.index;
    });

  return entries
    .map(({ key, value }) => {
      const text = String(value ?? "").trim();
      if (!text) return null;
      if (key.startsWith(INTERVIEW_QUESTION_PREFIX)) return `Q: ${text}`;
      if (key.startsWith(INTERVIEW_ANSWER_PREFIX) || key.startsWith("turn-")) return `A: ${text}`;
      return `${key}: ${text}`;
    })
    .filter((line): line is string => !!line);
};

export const interviewPrompt = (prd: PrdJson, input: string): string => {
  return buildInterviewPrompt(prd, input, interviewTranscript(prd));
};

export const parseInterviewTurn = (text: string): InterviewTurn => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { ok: false, done: false, question: null, error: "Empty interviewer response" };
  }

  if (lines.some((line) => /^DONE$/i.test(line))) {
    return { ok: true, done: true, question: null };
  }

  const normalized = lines
    .map((line) => line.replace(/^question\s*:\s*/i, "").trim())
    .filter((line) => !/^thinking[:\s]/i.test(line));

  const questionLine = [...normalized].reverse().find((line) => line.endsWith("?"))
    ?? [...normalized].reverse().find((line) => line.length > 0)
    ?? null;

  if (!questionLine) {
    return { ok: false, done: false, question: null, error: "No question found in interviewer response" };
  }

  return {
    ok: true,
    done: false,
    question: questionLine.endsWith("?") ? questionLine : `${questionLine}?`,
  };
};

export const interviewTurnRepairPrompt = (invalidResponse: string): string => {
  return buildInterviewTurnRepairPrompt(invalidResponse);
};

export const repeatedQuestionRepairPrompt = (previousQuestion: string, latestAnswer: string): string => {
  return buildRepeatedQuestionRepairPrompt(previousQuestion, latestAnswer);
};

export const formatQualityGateSelectionQuestion = (state: QualityGateSelectionState): string => {
  const optionLines = state.options.map((opt) => `- ${opt.label}`).join("\n");
  return [
    state.question.trim() || "Which quality gate preset should we use?",
    "OPTIONS:",
    optionLines,
  ].join("\n");
};

export const qualityGatePresetPrompt = (prd: PrdJson): string => {
  return buildQualityGatePresetPrompt(prd);
};

export const qualityGatePresetRepairPrompt = (invalidResponse: string): string => {
  return buildQualityGatePresetRepairPrompt(invalidResponse);
};

export const parseQualityGatePresetResponse = (text: string): QualityGateSelectionState | null => {
  const jsonText = extractFirstJsonObject(text);
  if (!jsonText) return null;
  const parsedResult = tryParseJson<{ question?: unknown; options?: Array<{ label?: unknown; commands?: unknown }> }>(jsonText);
  if (!parsedResult.ok) return null;

  const question = typeof parsedResult.value.question === "string"
    ? parsedResult.value.question.trim()
    : "Which quality gate preset should we use?";
  const options = Array.isArray(parsedResult.value.options)
    ? parsedResult.value.options
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
};

export const resolveQualityGatePresetChoice = (answer: string, state: QualityGateSelectionState): QualityGatePreset | null => {
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

export const normalizeQuestionKey = (input: string): string => {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
};

export const compileInterviewPrompt = (prd: PrdJson): string => {
  return buildCompileInterviewPrompt(prd, interviewTranscript(prd));
};

export const parseCompileInterviewResponse = (text: string):
  | { ok: true; envelope: CompileInterviewEnvelope }
  | { ok: false; error: string } => {
  const jsonText = extractFirstJsonObject(text);
  if (!jsonText) {
    return { ok: false, error: "No JSON object found in compile response" };
  }
  const parsedResult = tryParseJson<CompileInterviewEnvelope>(jsonText);
  if (parsedResult.ok === false) {
    return { ok: false, error: `Compile JSON parse error: ${parsedResult.error}` };
  }
  if (!parsedResult.value || typeof parsedResult.value !== "object") {
    return { ok: false, error: "Compile response is not an object" };
  }
  return { ok: true, envelope: parsedResult.value };
};

export const compileRepairPrompt = (invalidResponse: string): string => {
  return buildCompileRepairPrompt(invalidResponse);
};

export const applyInterviewUpdates = (prd: PrdJson, updates: InterviewUpdates | undefined): PrdJson => {
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
      uiPolicy: next.uiVerificationRequired ? "required" : "off",
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
