import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { readTextIfExists, writeText } from "./fs";
import { buildPrompt } from "./prompt";
import { ensureMario, bumpIteration, readWorkSessionState, writeWorkSessionState, readRunState, writeRunState } from "./state";
import { RunState } from "./types";
import { getRepoRoot } from "./paths";
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
        totalSteps: Math.max(existing.wizard?.totalSteps ?? 0, 12),
      },
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

const WIZARD_TOTAL_STEPS = 12;
const LAST_QUESTION_KEY = "__last_question";
const MIN_FEATURES = 3;
const MIN_QUALITY_GATES = 2;

const hasNonEmpty = (value: string | null | undefined): boolean => typeof value === "string" && value.trim().length > 0;

const normalizeTextArray = (value: string[] | undefined): string[] => {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)))
    : [];
};

const hasMeaningfulList = (value: string[] | undefined, min = 1): boolean => normalizeTextArray(value).length >= min;

const hasDiverseQualityGates = (gates: string[]): boolean => {
  const normalized = normalizeTextArray(gates);
  const hasTest = normalized.some((gate) => /(\btest\b|pytest|vitest|jest|playwright|cypress|go test|cargo test)/i.test(gate));
  const hasStatic = normalized.some((gate) => /(lint|typecheck|mypy|ruff|flake8|eslint|tsc|build|check|fmt --check)/i.test(gate));
  return hasTest && hasStatic;
};

const looksLikeUiChoiceArtifact = (input: string): boolean => {
  const s = input.trim();
  if (!s) {
    return false;
  }
  if (/^answer in my own words/i.test(s)) {
    return true;
  }
  return /(single-choice|multi-choice|free-text|show current status|stop for now|hardcoded|fixed questions|generate 3 questions)/i.test(s);
};

const looksTooBroadQuestion = (question: string): boolean => {
  const q = question.trim();
  if (!q) {
    return true;
  }
  const wordCount = q.split(/\s+/).filter(Boolean).length;
  const clauseSignals = (q.match(/,| and | or |;/gi) ?? []).length;
  const hasListCue = /(include|cover|describe.*(flow|end-to-end)|what.*and.*what|first.*then)/i.test(q);
  return wordCount > 30 || clauseSignals >= 4 || hasListCue;
};

const isPrdComplete = (prd: PrdJson): boolean => {
  return (
    hasNonEmpty(prd.idea)
    && prd.platform !== null
    && typeof prd.frontend === "boolean"
    && prd.language !== null
    && hasNonEmpty(prd.framework)
    && hasMeaningfulList(prd.product.targetUsers)
    && hasMeaningfulList(prd.product.userProblems)
    && hasMeaningfulList(prd.product.mustHaveFeatures, MIN_FEATURES)
    && hasMeaningfulList(prd.product.nonGoals)
    && hasMeaningfulList(prd.product.successMetrics)
    && hasMeaningfulList(prd.product.constraints)
    && hasMeaningfulList(prd.qualityGates, MIN_QUALITY_GATES)
    && hasDiverseQualityGates(prd.qualityGates)
  );
};

const deriveWizardStep = (prd: PrdJson): number => {
  let step = 0;
  if (hasNonEmpty(prd.idea)) step = 1;
  if (prd.platform !== null) step = 2;
  if (typeof prd.frontend === "boolean") step = 3;
  if (prd.language !== null) step = 4;
  if (hasNonEmpty(prd.framework)) step = 5;
  if (hasMeaningfulList(prd.product.targetUsers)) step = 6;
  if (hasMeaningfulList(prd.product.userProblems)) step = 7;
  if (hasMeaningfulList(prd.product.mustHaveFeatures, MIN_FEATURES)) step = 8;
  if (hasMeaningfulList(prd.product.nonGoals)) step = 9;
  if (hasMeaningfulList(prd.product.successMetrics)) step = 10;
  if (hasMeaningfulList(prd.product.constraints)) step = 11;
  if (hasMeaningfulList(prd.qualityGates, MIN_QUALITY_GATES) && hasDiverseQualityGates(prd.qualityGates)) step = 12;
  return Math.min(WIZARD_TOTAL_STEPS, step);
};

const firstMissingField = (prd: PrdJson): string => {
  if (!hasNonEmpty(prd.idea)) return "idea";
  if (prd.platform === null) return "platform";
  if (typeof prd.frontend !== "boolean") return "frontend";
  if (prd.language === null) return "language";
  if (!hasNonEmpty(prd.framework)) return "framework";
  if (!hasMeaningfulList(prd.product.targetUsers)) return "targetUsers";
  if (!hasMeaningfulList(prd.product.userProblems)) return "userProblems";
  if (!hasMeaningfulList(prd.product.mustHaveFeatures, MIN_FEATURES)) return "mustHaveFeatures";
  if (!hasMeaningfulList(prd.product.nonGoals)) return "nonGoals";
  if (!hasMeaningfulList(prd.product.successMetrics)) return "successMetrics";
  if (!hasMeaningfulList(prd.product.constraints)) return "constraints";
  if (!hasMeaningfulList(prd.qualityGates, MIN_QUALITY_GATES) || !hasDiverseQualityGates(prd.qualityGates)) return "qualityGates";
  return "done";
};

const fallbackQuestion = (prd: PrdJson): string => {
  const missing = firstMissingField(prd);
  switch (missing) {
    case "idea":
      return "What one-line idea should this project build?";
    case "platform":
      return "What are we building: web app, API service, CLI tool, or library?";
    case "frontend":
      return "Does this project need a browser UI?";
    case "language":
      return "What is the primary language: TypeScript, Python, Go, Rust, or other?";
    case "framework":
      return "Which framework/runtime should be the default?";
    case "targetUsers":
      return "Who are the primary target users? List user segments explicitly.";
    case "userProblems":
      return "What concrete user problems are we solving for those users?";
    case "mustHaveFeatures":
      return `List at least ${MIN_FEATURES} must-have features for V1.`;
    case "nonGoals":
      return "What is explicitly out of scope for V1?";
    case "successMetrics":
      return "How will success be measured? List measurable metrics.";
    case "constraints":
      return "List constraints: technical, timeline, budget, compliance, or deployment constraints.";
    case "qualityGates":
      return `List at least ${MIN_QUALITY_GATES} quality gate commands, including both test and static checks.`;
    default:
      return "Anything else I should capture before we run the first iteration?";
  }
};

const compactIdea = (idea: string): string => {
  const oneLine = idea.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 80) {
    return oneLine;
  }
  return `${oneLine.slice(0, 77).trim()}...`;
};

const scaffoldPlanFromPrd = async (repoRoot: string, prd: PrdJson): Promise<{ doneWhen: string[]; notes: string[] }> => {
  const framework = (prd.framework ?? "").toLowerCase();
  const notes: string[] = [
    "Seeded by PRD interviewer.",
    "First task scaffolds project artifacts before strict quality gates are enforced.",
    "Scaffold implementation is agent-chosen; command hints below are optional defaults.",
  ];

  if (prd.platform === "web" && prd.language === "typescript" && framework.includes("next")) {
    notes.push("Preferred scaffold command (optional): npx create-next-app@latest __tmp_next --ts --eslint --app --src-dir --use-npm --yes && rsync -a __tmp_next/ ./ --exclude .git --exclude node_modules && rm -rf __tmp_next && npm install");
    return {
      doneWhen: ["test -f package.json", "test -d app || test -d src/app"],
      notes,
    };
  }

  if (prd.platform === "web" && prd.language === "typescript" && (framework.includes("vite") || framework.includes("react"))) {
    notes.push("Preferred scaffold command (optional): npm create vite@latest __tmp_vite -- --template react-ts && rsync -a __tmp_vite/ ./ --exclude .git --exclude node_modules && rm -rf __tmp_vite && npm install");
    return {
      doneWhen: ["test -f package.json", "test -f src/main.tsx"],
      notes,
    };
  }

  if (prd.platform === "api" && prd.language === "python" && framework.includes("fastapi")) {
    notes.push("Preferred scaffold command (optional): python -m pip install fastapi uvicorn[standard]");
    return {
      doneWhen: ["test -f pyproject.toml || test -f requirements.txt"],
      notes,
    };
  }

  const inferred = await inferBootstrapDoneWhen(repoRoot, prd);
  notes.push("Preferred scaffold command (optional): initialize project skeleton for selected stack before implementing features.");
  return { doneWhen: inferred, notes };
};

const firstScaffoldHintFromNotes = (notes: string[] | undefined): string | null => {
  if (!notes || notes.length === 0) {
    return null;
  }
  const line = notes.find((n) => n.startsWith("Preferred scaffold command (optional):"));
  return line ? line.replace(/^Preferred scaffold command \(optional\):\s*/, "").trim() : null;
};

const inferBootstrapDoneWhen = async (repoRoot: string, prd: PrdJson): Promise<string[]> => {
  const qualityGates = prd.qualityGates ?? [];
  const qualityText = qualityGates.join("\n");
  const hasPackageJson = !!(await readTextIfExists(path.join(repoRoot, "package.json")));
  const hasPyproject = !!(await readTextIfExists(path.join(repoRoot, "pyproject.toml")));
  const hasRequirements = !!(await readTextIfExists(path.join(repoRoot, "requirements.txt")));
  const hasGoMod = !!(await readTextIfExists(path.join(repoRoot, "go.mod")));
  const hasCargoToml = !!(await readTextIfExists(path.join(repoRoot, "Cargo.toml")));

  const wantsNode = prd.language === "typescript"
    || /\b(npm|pnpm|yarn|bun)\b/i.test(qualityText)
    || prd.platform === "web";
  const wantsPython = prd.language === "python" || /\b(pytest|python|poetry|uv|mypy|ruff|flake8)\b/i.test(qualityText);
  const wantsGo = prd.language === "go" || /\bgo\b/i.test(qualityText);
  const wantsRust = prd.language === "rust" || /\bcargo\b/i.test(qualityText);

  if (wantsNode && !hasPackageJson) {
    return ["test -f package.json"];
  }
  if (wantsPython && !hasPyproject && !hasRequirements) {
    return ["test -f pyproject.toml || test -f requirements.txt"];
  }
  if (wantsGo && !hasGoMod) {
    return ["test -f go.mod"];
  }
  if (wantsRust && !hasCargoToml) {
    return ["test -f Cargo.toml"];
  }
  return qualityGates;
};

const seedTasksFromPrd = async (repoRoot: string, prd: PrdJson): Promise<PrdJson> => {
  if (Array.isArray(prd.tasks) && prd.tasks.length > 0) {
    return prd;
  }
  const bootstrapPlan = await scaffoldPlanFromPrd(repoRoot, prd);
  const doneWhen = prd.qualityGates ?? [];
  const tasks: PrdTask[] = [];
  let n = 1;
  tasks.push(
    makeTask({
      id: normalizeTaskId(n++),
      title: prd.idea.trim() ? `Scaffold project baseline: ${compactIdea(prd.idea)}` : "Scaffold project baseline",
      doneWhen: bootstrapPlan.doneWhen,
      notes: bootstrapPlan.notes,
    }),
  );
  for (const feature of prd.product.mustHaveFeatures ?? []) {
    tasks.push(
      makeTask({
        id: normalizeTaskId(n++),
        title: `Implement: ${feature}`,
        doneWhen,
      }),
    );
  }
  return { ...prd, tasks };
};

const normalizeTaskId = (n: number): string => `T-${String(n).padStart(4, "0")}`;

const makeTask = (params: {
  id: string;
  status?: PrdTaskStatus;
  title: string;
  scope?: string[];
  doneWhen: string[];
  evidence?: string[];
  notes?: string[];
}): PrdTask => {
  return {
    id: params.id,
    status: params.status ?? "open",
    title: params.title,
    scope: params.scope ?? ["**/*"],
    doneWhen: params.doneWhen,
    evidence: params.evidence ?? [],
    ...(params.notes ? { notes: params.notes } : {}),
  };
};

const getNextPrdTask = (prd: PrdJson): PrdTask | null => {
  const tasks = prd.tasks ?? [];
  const doing = tasks.filter((t) => t.status === "in_progress");
  if (doing.length >= 1) {
    return doing[0] ?? null;
  }
  return tasks.find((t) => t.status === "open") ?? null;
};

const setPrdTaskStatus = (prd: PrdJson, taskId: string, status: PrdTaskStatus): PrdJson => {
  const tasks = (prd.tasks ?? []).map((t) => (t.id === taskId ? { ...t, status } : t));
  return { ...prd, tasks };
};

const setPrdTaskLastAttempt = (prd: PrdJson, taskId: string, lastAttempt: PrdTaskAttempt): PrdJson => {
  const tasks = (prd.tasks ?? []).map((t) => (t.id === taskId ? { ...t, lastAttempt } : t));
  return { ...prd, tasks };
};

const interviewPrompt = (prd: PrdJson, input: string): string => {
  const missingField = firstMissingField(prd);
  const readiness = {
    idea: hasNonEmpty(prd.idea),
    platform: prd.platform !== null,
    frontend: typeof prd.frontend === "boolean",
    language: prd.language !== null,
    framework: hasNonEmpty(prd.framework),
    targetUsers: hasMeaningfulList(prd.product.targetUsers),
    userProblems: hasMeaningfulList(prd.product.userProblems),
    mustHaveFeatures: hasMeaningfulList(prd.product.mustHaveFeatures, MIN_FEATURES),
    nonGoals: hasMeaningfulList(prd.product.nonGoals),
    successMetrics: hasMeaningfulList(prd.product.successMetrics),
    constraints: hasMeaningfulList(prd.product.constraints),
    qualityGates: hasMeaningfulList(prd.qualityGates, MIN_QUALITY_GATES) && hasDiverseQualityGates(prd.qualityGates),
  };
  const current = {
    idea: prd.idea,
    platform: prd.platform,
    frontend: prd.frontend,
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
    "- language (typescript|python|go|rust|other)",
    "- framework (string)",
    "- targetUsers (non-empty string[])",
    "- userProblems (non-empty string[])",
    `- mustHaveFeatures (at least ${MIN_FEATURES} string items)`,
    "- nonGoals (non-empty string[])",
    "- successMetrics (non-empty string[])",
    "- constraints (non-empty string[])",
    `- qualityGates (at least ${MIN_QUALITY_GATES} runnable commands including both test and static checks)`,
    "",
    "Envelope schema:",
    '{"done": boolean, "updates": {idea?, platform?, frontend?, language?, framework?, targetUsers?, userProblems?, mustHaveFeatures?, nonGoals?, successMetrics?, constraints?, qualityGates?}, "next_question": string}',
    "",
    "Rules:",
    "- updates MUST include only fields changed by this answer.",
    "- Ask probing follow-ups until requirements are testable and implementation-ready.",
    "- Ask direct natural-language questions; do NOT use A/B/C/D multiple-choice formatting.",
    "- Ask about ONE missing field only; do not combine multiple fields in one question.",
    "- Keep question short (max 22 words), concrete, and answerable in one message.",
    "- For boolean fields, ask yes/no in plain language (never ask for true/false literals).",
    "- Do not re-ask fields that are already satisfied in the readiness checklist.",
    "- qualityGates must be explicit runnable commands (eg: npm run lint).",
    "- Do not accept vague features (like 'good UX'); ask for concrete behavior.",
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
  if (!updates) {
    return prd;
  }
  let next = { ...prd };
  if (typeof updates.idea === "string") next.idea = updates.idea.trim();
  if (updates.platform) next.platform = updates.platform;
  if (typeof updates.frontend === "boolean") next.frontend = updates.frontend;
  if (updates.language) next.language = updates.language;
  if (typeof updates.framework === "string" || updates.framework === null) next.framework = updates.framework;
  if (Array.isArray(updates.targetUsers)) {
    next.product = { ...next.product, targetUsers: normalizeTextArray(updates.targetUsers) };
  }
  if (Array.isArray(updates.userProblems)) {
    next.product = { ...next.product, userProblems: normalizeTextArray(updates.userProblems) };
  }
  if (Array.isArray(updates.qualityGates)) {
    next.qualityGates = normalizeTextArray(updates.qualityGates);
  }
  if (Array.isArray(updates.mustHaveFeatures)) {
    next.product = {
      ...next.product,
      mustHaveFeatures: normalizeTextArray(updates.mustHaveFeatures),
    };
  }
  if (Array.isArray(updates.nonGoals)) {
    next.product = { ...next.product, nonGoals: normalizeTextArray(updates.nonGoals) };
  }
  if (Array.isArray(updates.successMetrics)) {
    next.product = { ...next.product, successMetrics: normalizeTextArray(updates.successMetrics) };
  }
  if (Array.isArray(updates.constraints)) {
    next.product = { ...next.product, constraints: normalizeTextArray(updates.constraints) };
  }
  if (next.platform && next.platform !== "web") {
    next.frontend = false;
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
  let statusConflict = false;
  let exitSignal = false;
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
      status = next;
      continue;
    }
    const em = line.match(/^EXIT_SIGNAL:\s*(true|false)\s*$/i);
    if (em) {
      exitSignal = (em[1] ?? "false").toLowerCase() === "true";
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

const getXdgConfigHome = (): string => {
  return process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "", ".config");
};

const getGlobalSkillPath = (skillName: string): string => {
  return path.join(getXdgConfigHome(), "opencode", "skill", skillName, "SKILL.md");
};

const parseEnvValue = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseAgentsEnv = (content: string): { env: Record<string, string>; warnings: string[] } => {
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const idx = line.indexOf("=");
    if (idx === -1) {
      warnings.push(`Line ${i + 1}: ignored (missing '='): ${line}`);
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (!key) {
      warnings.push(`Line ${i + 1}: ignored (empty key): ${line}`);
      continue;
    }
    env[key] = parseEnvValue(value);
  }
  return { env, warnings };
};

const upsertAgentsKey = (content: string, key: string, value: string): string => {
  const lines = content.split(/\r?\n/);
  const nextLine = `${key}='${value.replace(/'/g, "'\\''")}'`;
  let updated = false;
  const nextLines = lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#") || !trimmed.startsWith(`${key}=`)) {
      return line;
    }
    updated = true;
    return nextLine;
  });
  if (updated) {
    return nextLines.join("\n");
  }
  return `${content.trimEnd()}\n${nextLine}\n`;
};

const isLikelyWebApp = async (repoRoot: string): Promise<boolean> => {
  const pkgRaw = await readTextIfExists(path.join(repoRoot, "package.json"));
  if (!pkgRaw) {
    return false;
  }
  try {
    const pkg = JSON.parse(pkgRaw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return Boolean(deps.next || deps.vite || deps["react-scripts"]);
  } catch {
    return false;
  }
};

const hasAgentBrowserSkill = async (repoRoot: string): Promise<boolean> => {
  const localCandidates = [
    path.join(repoRoot, ".opencode", "skill", "agent-browser", "SKILL.md"),
    path.join(repoRoot, ".opencode", "skills", "agent-browser", "SKILL.md"),
    path.join(repoRoot, ".claude", "skills", "agent-browser", "SKILL.md"),
  ];
  for (const candidate of localCandidates) {
    if ((await readTextIfExists(candidate)) !== null) {
      return true;
    }
  }
  // Many OpenCode setups install skills globally under XDG_CONFIG_HOME.
  if ((await readTextIfExists(getGlobalSkillPath("agent-browser"))) !== null) {
    return true;
  }
  return false;
};

const hasAgentBrowserCli = async (ctx: PluginContext): Promise<boolean> => {
  if (!ctx.$) {
    return false;
  }
  const result = await ctx.$`sh -c ${"command -v agent-browser"}`.nothrow();
  return result.exitCode === 0;
};

const runUiVerification = async (params: {
  ctx: PluginContext;
  devCmd: string;
  url: string;
}): Promise<{ ok: boolean; note?: string }> => {
  const { ctx, devCmd, url } = params;
  if (!ctx.$) {
    return { ok: false, note: "Bun shell not available to run UI verification." };
  }

  let pid = "";

  const cleanup = async (): Promise<void> => {
    // Always attempt to close the browser and stop the dev server.
    await ctx.$`sh -c ${"agent-browser close >/dev/null 2>&1 || true"}`.nothrow();
    if (pid) {
      await ctx.$`sh -c ${`kill ${pid} >/dev/null 2>&1 || true`}`.nothrow();
    }
  };

  try {
    // Start dev server in background.
    const start = await ctx.$`sh -c ${`${devCmd} >/dev/null 2>&1 & echo $!`}`.nothrow();
    pid = start.stdout.toString().trim();
    if (!pid) {
      return { ok: false, note: "Failed to start dev server." };
    }

    // Wait for URL to respond.
    const waitCmd = `i=0; while [ $i -lt 60 ]; do curl -fsS ${url} >/dev/null 2>&1 && exit 0; i=$((i+1)); sleep 1; done; exit 1`;
    const waited = await ctx.$`sh -c ${waitCmd}`.nothrow();
    if (waited.exitCode !== 0) {
      return { ok: false, note: `Dev server did not become ready at ${url}.` };
    }

    // Drive browser with agent-browser.
    const cmds: { label: string; cmd: string }[] = [
      { label: "open", cmd: `agent-browser open ${url}` },
      { label: "snapshot", cmd: "agent-browser snapshot -i --json" },
      { label: "console", cmd: "agent-browser console --json" },
      { label: "errors", cmd: "agent-browser errors --json" },
      { label: "close", cmd: "agent-browser close" },
    ];

    for (const item of cmds) {
      const r = await ctx.$`sh -c ${item.cmd}`.nothrow();
      if (r.exitCode !== 0) {
        return {
          ok: false,
          note: `agent-browser failed at '${item.label}'. If this is first run, you may need: agent-browser install`,
        };
      }
    }

    return { ok: true, note: "UI verification completed." };
  } finally {
    await cleanup();
  }
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

const waitForSessionIdle = async (
  ctx: PluginContext,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = await ctx.client.session.status();
    const status = (statuses as Record<string, { type?: string }>)[sessionId];
    if (!status || status.type === "idle") {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
};

const runGateCommands = async (
  commands: { name: string; command: string }[],
  $: PluginContext["$"] | undefined,
): Promise<{
  ok: boolean;
  failed?: { name: string; command: string; exitCode: number };
  results: Array<{ name: string; command: string; ok: boolean; exitCode: number; durationMs: number }>;
  note?: string;
}> => {
  if (commands.length === 0) {
    return { ok: false, note: "No quality gates detected.", results: [] };
  }
  if (!$) {
    return { ok: false, note: "Bun shell not available to run gates.", results: [] };
  }

  const results: Array<{ name: string; command: string; ok: boolean; exitCode: number; durationMs: number }> = [];
  let ok = true;
  let failed: { name: string; command: string; exitCode: number } | undefined;

  for (const command of commands) {
    const cmd = command.command.trim();
    if (cmd.length === 0) {
      ok = false;
      results.push({ name: command.name, command: "", ok: false, exitCode: 1, durationMs: 0 });
      break;
    }

    if (cmd.includes("\n") || cmd.includes("\r")) {
      ok = false;
      results.push({
        name: command.name,
        command: cmd,
        ok: false,
        exitCode: 1,
        durationMs: 0,
      });
      break;
    }

    const startedAt = Date.now();
    const result = await $`sh -c ${cmd}`.nothrow();
    const durationMs = Date.now() - startedAt;
    const isOk = result.exitCode === 0;
    results.push({
      name: command.name,
      command: cmd,
      ok: isOk,
      exitCode: result.exitCode,
      durationMs,
    });

    if (result.exitCode !== 0) {
      ok = false;
      failed = { name: command.name, command: cmd, exitCode: result.exitCode };
      break;
    }
  }
  return {
    ok,
    results,
    ...(failed ? { failed } : {}),
  };
};

const getBaselineText = (repoRoot: string): string => {
  return [
    "# mario-devx work session",
    "",
    "This is the mario-devx work session for this repo.",
    "",
    "Hard rules:",
    "- Never edit the control plane: do not modify .opencode/plugins/mario-devx/**",
    "- Keep work state in .mario/ and git.",
    "- One task per build iteration.",
    "",
    "Canonical files:",
    "- PRD + tasks: .mario/prd.json",
    "- Agent config: .mario/AGENTS.md",
    "- State: .mario/state/state.json",
    "",
    `Repo: ${repoRoot}`,
  ].join("\n");
};

const extractSessionId = (response: unknown): string | null => {
  const candidate = response as { data?: { id?: string } };
  return candidate.data?.id ?? null;
};

const extractMessageId = (response: unknown): string | null => {
  const candidate = response as { data?: { info?: { id?: string } }; info?: { id?: string } };
  return candidate.data?.info?.id ?? candidate.info?.id ?? null;
};

const ensureWorkSession = async (
  ctx: PluginContext,
  repoRoot: string,
  agent: string | undefined,
): Promise<{ sessionId: string; baselineMessageId: string }> => {
  await ensureMario(repoRoot, false);
  const existing = await readWorkSessionState(repoRoot);
  if (existing?.sessionId && existing?.baselineMessageId) {
    return { sessionId: existing.sessionId, baselineMessageId: existing.baselineMessageId };
  }

  const created = await ctx.client.session.create();
  const sessionId = extractSessionId(created);
  if (!sessionId) {
    throw new Error("Failed to create work session");
  }

  await ctx.client.session.update({
    path: { id: sessionId },
    body: { title: "mario-devx (work)" },
  });

  const baseline = getBaselineText(repoRoot);
  const baselineResp = await ctx.client.session.prompt({
    path: { id: sessionId },
    body: {
      noReply: true,
      ...(agent ? { agent } : {}),
      parts: [{ type: "text", text: baseline }],
    },
  });
  const baselineMessageId = extractMessageId(baselineResp);
  if (!baselineMessageId) {
    throw new Error("Failed to create baseline message in work session");
  }

  const now = nowIso();
  await writeWorkSessionState(repoRoot, {
    sessionId,
    baselineMessageId,
    createdAt: now,
    updatedAt: now,
  });
  return { sessionId, baselineMessageId };
};

const resetWorkSession = async (
  ctx: PluginContext,
  repoRoot: string,
  agent: string | undefined,
): Promise<{ sessionId: string; baselineMessageId: string }> => {
  const ws = await ensureWorkSession(ctx, repoRoot, agent);
  await ctx.client.session.revert({
    path: { id: ws.sessionId },
    body: { messageID: ws.baselineMessageId },
  });
  return ws;
};

const setWorkSessionTitle = async (
  ctx: PluginContext,
  sessionId: string,
  title: string,
): Promise<void> => {
  try {
    await ctx.client.session.update({
      path: { id: sessionId },
      body: { title },
    });
  } catch {
    // Best-effort only.
  }
};

const ensureNotInWorkSession = async (
  repoRoot: string,
  context: ToolContext,
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const ws = await readWorkSessionState(repoRoot);
  if (!ws?.sessionId) {
    return { ok: true };
  }
  if (context.sessionID && context.sessionID === ws.sessionId) {
    return {
      ok: false,
      message: "You are in the mario-devx work session. Run this command from a control session (open a new session and run it there).",
    };
  }
  return { ok: true };
};

const updateRunState = async (repoRoot: string, patch: Partial<RunState>): Promise<void> => {
  const existing = await readRunState(repoRoot);
  await writeRunState(repoRoot, {
    ...existing,
    ...patch,
    updatedAt: nowIso(),
  });
};

const extractTextFromPromptResponse = (response: unknown): string => {
  if (!response) {
    return "";
  }
  const candidate = response as {
    data?: { parts?: { type?: string; text?: string }[] };
    parts?: { type?: string; text?: string }[];
  };
  const parts = candidate.parts ?? candidate.data?.parts ?? [];
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
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
              [LAST_QUESTION_KEY]: nextQuestion,
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
          nextQuestion,
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
            if (parsed.warnings.length > 0) {
              await showToast(ctx, `Run warning: AGENTS.md parse warnings (${parsed.warnings.length})`, "warning");
            }
            if (env.UI_VERIFY !== "1") {
              let next = raw;
              next = upsertAgentsKey(next, "UI_VERIFY", "1");
              next = upsertAgentsKey(next, "UI_VERIFY_REQUIRED", "0");
              if (!env.UI_VERIFY_CMD) next = upsertAgentsKey(next, "UI_VERIFY_CMD", "npm run dev");
              if (!env.UI_VERIFY_URL) next = upsertAgentsKey(next, "UI_VERIFY_URL", "http://localhost:3000");
              if (!env.AGENT_BROWSER_REPO) next = upsertAgentsKey(next, "AGENT_BROWSER_REPO", "https://github.com/vercel-labs/agent-browser");
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
        const uiVerifyCmd = agentsEnv.UI_VERIFY_CMD || "npm run dev";
        const uiVerifyUrl = agentsEnv.UI_VERIFY_URL || "http://localhost:3000";
        const uiVerifyRequired = agentsEnv.UI_VERIFY_REQUIRED === "1";
        const agentBrowserRepo = agentsEnv.AGENT_BROWSER_REPO || "https://github.com/vercel-labs/agent-browser";

        const isWebApp = await isLikelyWebApp(repoRoot);
        const cliOk = await hasAgentBrowserCli(ctx);
        const skillOk = await hasAgentBrowserSkill(repoRoot);
        const shouldRunUiVerify = uiVerifyEnabled && isWebApp && cliOk && skillOk;

          let attempted = 0;
          let completed = 0;

          while (attempted < maxItems) {
            const task = getNextPrdTask(prd);
            if (!task) {
              break;
            }
            const effectiveDoneWhen = task.doneWhen.length > 0 ? task.doneWhen : (prd.qualityGates ?? []);
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
              let gateResult = await runGateCommands(gateCommands, ctx.$);

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
                const repairPrompt = [
                  `Task ${task.id} failed deterministic gate: ${failedGate}.`,
                  gateResult.failed?.command?.includes("package.json")
                    ? "If project scaffold is missing, scaffold the app first before feature edits."
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
                gateResult = await runGateCommands(gateCommands, ctx.$);
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
            : { ran: false, ok: null, note: uiVerifyEnabled && isWebApp ? "UI verification skipped (prerequisites missing)." : "UI verification not configured." };

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
            const elapsedMs = Date.now() - taskRepairStartedAt;
            await failEarly([
              `Deterministic gate failed: ${failed}.`,
              `Auto-repair stopped after ${Math.round(elapsedMs / 1000)}s across ${repairAttempts} attempt(s) (no-progress or time budget reached).`,
            ], scaffoldHint
              ? [
                  "Scaffold artifacts are missing; choose any valid scaffold approach for this stack.",
                  `Optional default command: ${scaffoldHint}`,
                  "Then rerun /mario-devx:run 1.",
                ]
              : undefined);
            await showToast(ctx, `Run stopped: gates failed on ${task.id}`, "warning");
            break;
          }

          if (uiVerifyEnabled && isWebApp && uiVerifyRequired && (!cliOk || !skillOk)) {
            await failEarly(
              [
              "UI verification is required but agent-browser prerequisites are missing.",
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

          const note =
            completed === attempted && attempted === maxItems
              ? "Reached max_items limit."
              : completed === attempted
                ? "No more open/in_progress tasks found."
                : "Stopped early due to failure. See task.lastAttempt.judge in .mario/prd.json.";

          return `Run finished. Attempted: ${attempted}. Completed: ${completed}. ${note}`;
        } finally {
          await releaseRunLock(repoRoot);
        }
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

        const issues: string[] = [];
        const fixes: string[] = [];

        // PRD JSON
        const prd = await readPrdJsonIfExists(repoRoot);
        if (!prd) {
          issues.push("Missing or invalid .mario/prd.json");
          fixes.push("Run /mario-devx:new <idea>");
        } else {
          if (prd.wizard.status !== "completed") {
            issues.push("PRD wizard not completed (prd.json.wizard.status != completed)."
            );
            fixes.push("Run /mario-devx:new and answer the wizard questions.");
          }
          if (!Array.isArray(prd.qualityGates) || prd.qualityGates.length === 0) {
            issues.push("No quality gates configured in .mario/prd.json (qualityGates is empty)."
            );
            fixes.push("Edit .mario/prd.json: add commands under qualityGates (example: npm test)."
            );
          }
          if (!Array.isArray(prd.tasks) || prd.tasks.length === 0) {
            issues.push("No tasks in .mario/prd.json (tasks is empty)."
            );
            fixes.push("Run /mario-devx:new to seed tasks or add tasks manually to .mario/prd.json."
            );
          }
          const inProgress = (prd.tasks ?? []).filter((t) => t.status === "in_progress").map((t) => t.id);
          if (inProgress.length > 1) {
            issues.push(`Invalid task state: multiple tasks are in_progress (${inProgress.join(", ")}).`);
            fixes.push("Edit .mario/prd.json so at most one task is in_progress (set the others to open/blocked/cancelled). Then rerun /mario-devx:run 1.");
          }
          const blocked = (prd.tasks ?? []).filter((t) => t.status === "blocked").map((t) => t.id);
          if (blocked.length > 0) {
            issues.push(`Blocked tasks: ${blocked.join(", ")}`);
            fixes.push("For each blocked task, read prd.json.tasks[].lastAttempt.judge.nextActions, fix them, then rerun /mario-devx:run 1.");
          }
        }

        // UI verification prerequisites
        const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
        const agentsRaw = await readTextIfExists(agentsPath);
        const agentsParsed = agentsRaw ? parseAgentsEnv(agentsRaw) : { env: {}, warnings: [] };
        const agentsEnv = agentsParsed.env;
        if (agentsParsed.warnings.length > 0) {
          issues.push(`AGENTS.md parse warnings (${agentsParsed.warnings.length}).`);
          fixes.push("Fix malformed lines in .mario/AGENTS.md (must be KEY=VALUE; use # for comments)." );
        }
        const uiVerifyEnabled = agentsEnv.UI_VERIFY === "1";
        if (uiVerifyEnabled) {
          const isWebApp = await isLikelyWebApp(repoRoot);
          if (!isWebApp) {
            issues.push("UI_VERIFY=1 but this repo does not look like a Node web app yet.");
            fixes.push("Either scaffold the web app first, or set UI_VERIFY=0 in .mario/AGENTS.md.");
          } else {
            const cliOk = await hasAgentBrowserCli(ctx);
            const skillOk = await hasAgentBrowserSkill(repoRoot);
          if (!cliOk || !skillOk) {
            issues.push(`UI_VERIFY=1 but agent-browser prerequisites missing (${[!cliOk ? "cli" : null, !skillOk ? "skill" : null].filter(Boolean).join(", ")}).`);
            fixes.push("Install: npx skills add vercel-labs/agent-browser");
            fixes.push("Install: npm install -g agent-browser && agent-browser install");
            fixes.push("Optional: set UI_VERIFY=0 in .mario/AGENTS.md to disable best-effort UI checks.");
          }
          }
        }

        // Work session sanity
        const ws = await readWorkSessionState(repoRoot);
        if (!ws?.sessionId || !ws.baselineMessageId) {
          issues.push("Work session state missing (will be created on next /mario-devx:new or /mario-devx:run).");
        } else {
          try {
            await ctx.client.session.get({ path: { id: ws.sessionId } });
          } catch {
            issues.push("Work session id in state file does not exist anymore.");
            fixes.push("Delete .mario/state/state.json and rerun /mario-devx:new.");
          }
          try {
            await ctx.client.session.message({ path: { id: ws.sessionId, messageID: ws.baselineMessageId } });
          } catch {
            issues.push("Work session baseline message id is missing.");
            fixes.push("Delete .mario/state/state.json and rerun /mario-devx:new.");
          }
        }

        if (issues.length === 0) {
          return "Doctor: OK (no obvious issues found).";
        }

        return [
          "Doctor: issues found",
          ...issues.map((i) => `- ${i}`),
          "",
          "Suggested fixes",
          ...Array.from(new Set(fixes)).map((f) => `- ${f}`),
        ].join("\n");
      },
    }),

  };
};
