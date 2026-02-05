import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
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

const ensurePrd = async (repoRoot: string): Promise<PrdJson> => {
  const existing = await readPrdJsonIfExists(repoRoot);
  if (existing) {
    const createdAt = existing.meta?.createdAt?.trim() ? existing.meta.createdAt : nowIso();
    const updatedAt = nowIso();
    const next: PrdJson = { ...existing, meta: { createdAt, updatedAt } };
    if (createdAt !== existing.meta.createdAt || updatedAt !== existing.meta.updatedAt) {
      await writePrdJson(repoRoot, next);
    }
    return next;
  }
  const created = defaultPrdJson();
  await writePrdJson(repoRoot, created);
  return created;
};

const parseWizardInput = (raw: string): { choice: "A" | "B" | "C" | "D"; extra: string } | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const first = trimmed[0]?.toUpperCase();
  if (first !== "A" && first !== "B" && first !== "C" && first !== "D") {
    return null;
  }
  const rest = trimmed.slice(1).trimStart();
  const extra = rest.startsWith(":" ) ? rest.slice(1).trimStart() : rest;
  return { choice: first, extra } as { choice: "A" | "B" | "C" | "D"; extra: string };
};

const linesFromExtra = (extra: string): string[] => {
  return extra
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
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

const parseJudgeAttemptFromText = (text: string): PrdJudgeAttempt => {
  const statusMatch = text.match(/^Status:\s*(PASS|FAIL)\s*$/im);
  const exitMatch = text.match(/^EXIT_SIGNAL:\s*(true|false)\s*$/im);
  const status = (statusMatch?.[1] ?? "FAIL") as "PASS" | "FAIL";
  const exitSignal = (exitMatch?.[1] ?? "false").toLowerCase() === "true";

  const lines = text.split(/\r?\n/);
  const collectBulletsBetween = (start: RegExp, end: RegExp): string[] => {
    const startIdx = lines.findIndex((l) => start.test(l));
    if (startIdx === -1) return [];
    const endIdx = lines.findIndex((l, i) => i > startIdx && end.test(l));
    const slice = lines.slice(startIdx + 1, endIdx === -1 ? lines.length : endIdx);
    return slice
      .map((l) => l.trim())
      .filter((l) => l.startsWith("-"))
      .map((l) => l.replace(/^[-\s]+/, "").trim())
      .filter((l) => l.length > 0);
  };

  const reason = collectBulletsBetween(/^Reason:\s*$/i, /^Next actions:\s*$/i);
  const nextActions = collectBulletsBetween(/^Next actions:\s*$/i, /^\s*$/);

  const normalizedReason = reason.length > 0 ? reason : ["Verifier did not provide a parsable Reason list."];
  const normalizedNext = nextActions.length > 0 ? nextActions : ["Fix issues and rerun /mario-devx:run 1."];

  if (status === "PASS" && exitSignal !== true) {
    return {
      status: "FAIL",
      exitSignal: false,
      reason: ["Verifier output invalid: Status: PASS requires EXIT_SIGNAL: true."],
      nextActions: ["Fix the verifier output format (PASS must set EXIT_SIGNAL: true), then rerun /mario-devx:run 1."],
    };
  }

  return {
    status,
    exitSignal: status === "PASS" ? true : false,
    reason: normalizedReason,
    nextActions: normalizedNext,
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

const parseAgentsEnv = (content: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const idx = line.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (!key) {
      continue;
    }
    env[key] = parseEnvValue(value);
  }
  return env;
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
    // stop server
    await ctx.$`sh -c ${`kill ${pid} >/dev/null 2>&1 || true`}`.nothrow();
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
      // Ensure close and stop server.
      await ctx.$`sh -c ${"agent-browser close >/dev/null 2>&1 || true"}`.nothrow();
      await ctx.$`sh -c ${`kill ${pid} >/dev/null 2>&1 || true`}`.nothrow();
      return {
        ok: false,
        note: `agent-browser failed at '${item.label}'. If this is first run, you may need: agent-browser install`,
      };
    }
  }

  // Stop server.
  await ctx.$`sh -c ${`kill ${pid} >/dev/null 2>&1 || true`}`.nothrow();
  return { ok: true, note: "UI verification completed." };
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

const tail = (input: string, maxChars: number): string => {
  if (input.length <= maxChars) return input;
  return input.slice(input.length - maxChars);
};

const runGateCommands = async (
  commands: { name: string; command: string }[],
  $: PluginContext["$"] | undefined,
): Promise<{
  ok: boolean;
  failed?: { name: string; command: string; exitCode: number };
  results: Array<{ name: string; command: string; ok: boolean; exitCode: number; durationMs: number; outputTail?: string }>;
  note?: string;
}> => {
  if (commands.length === 0) {
    return { ok: false, note: "No quality gates detected.", results: [] };
  }
  if (!$) {
    return { ok: false, note: "Bun shell not available to run gates.", results: [] };
  }

  const results: Array<{ name: string; command: string; ok: boolean; exitCode: number; durationMs: number; outputTail?: string }> = [];
  let ok = true;
  let failed: { name: string; command: string; exitCode: number } | undefined;

  for (const command of commands) {
    const cmd = command.command.trim();
    if (cmd.length === 0) {
      ok = false;
      results.push({ name: command.name, command: "", ok: false, exitCode: 1, durationMs: 0, outputTail: "ERROR: empty gate command" });
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
        outputTail: "ERROR: gate command contains newline characters (refusing to run)",
      });
      break;
    }

    const startedAt = Date.now();
    const result = await $`sh -c ${cmd}`.nothrow();
    const durationMs = Date.now() - startedAt;
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    const outputTail = tail([stdout, stderr].filter((x) => x.trim().length > 0).join("\n"), 4000);
    results.push({
      name: command.name,
      command: cmd,
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      durationMs,
      ...(outputTail.trim().length > 0 ? { outputTail } : {}),
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

const parseCustomGateCommands = (raw: string): string[] => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const backticked = Array.from(trimmed.matchAll(/`([^`]+)`/g)).map((m) => (m[1] ?? "").trim());
  const source = backticked.length > 0 ? backticked : trimmed.split(/\r?\n|;/g).map((s) => s.trim());
  return source.filter((s) => s.length > 0);
};

const detectNodeQualityGates = async (repoRoot: string): Promise<string[]> => {
  const pkgRaw = await readTextIfExists(path.join(repoRoot, "package.json"));
  if (!pkgRaw) {
    return [];
  }
  try {
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const preferred = ["lint", "typecheck", "test", "build"];
    const gates: string[] = [];
    for (const key of preferred) {
      if (typeof scripts[key] === "string" && scripts[key].trim().length > 0) {
        gates.push(`npm run ${key}`);
      }
    }
    return gates;
  } catch {
    return [];
  }
};

type WizardQuestion = {
  id: string;
  title: string;
  prompt: string;
  options: Array<{ key: "A" | "B" | "C" | "D"; label: string }>;
};

const wizardQuestionFor = (params: { repoRoot: string; prd: PrdJson; step: number }): WizardQuestion => {
  const { repoRoot, prd, step } = params;
  switch (step) {
    case 0:
      return {
        id: "idea",
        title: "Idea Source",
        prompt: "How should mario-devx set the idea one-liner? (Tip: you can also run `/mario-devx:new <idea>` to skip this.)",
        options: [
          { key: "A", label: "Use repo name" },
          { key: "B", label: "Keep existing" },
          { key: "C", label: "Type it (C: ...)" },
          { key: "D", label: "Leave blank" },
        ],
      };
    case 1:
      return {
        id: "platform",
        title: "Platform",
        prompt: "What are we building?",
        options: [
          { key: "A", label: "Web app" },
          { key: "B", label: "API service" },
          { key: "C", label: "CLI tool" },
          { key: "D", label: "Library" },
        ],
      };
    case 2:
      return {
        id: "frontend",
        title: "Frontend",
        prompt: "Does this project need a browser UI?",
        options: [
          { key: "A", label: "Yes" },
          { key: "B", label: "No" },
          { key: "C", label: "Not sure (assume yes)" },
          { key: "D", label: "Skip (leave null)" },
        ],
      };
    case 3:
      return {
        id: "language",
        title: "Language",
        prompt: "Primary implementation language?",
        options: [
          { key: "A", label: "TypeScript" },
          { key: "B", label: "Python" },
          { key: "C", label: "Go" },
          { key: "D", label: "Rust" },
        ],
      };
    case 4:
      return {
        id: "framework",
        title: "Framework",
        prompt: "Pick a main framework/runtime (or specify other).",
        options: [
          { key: "A", label: "Use existing" },
          { key: "B", label: prd.platform === "web" ? "Next.js / React" : "Express" },
          { key: "C", label: prd.language === "python" ? "FastAPI" : prd.language === "go" ? "net/http" : "(skip)" },
          { key: "D", label: "Other (D: ...)" },
        ],
      };
    case 5:
      return {
        id: "persistence",
        title: "Persistence",
        prompt: "Do you need a database?",
        options: [
          { key: "A", label: "None" },
          { key: "B", label: "SQLite" },
          { key: "C", label: "Postgres" },
          { key: "D", label: "Supabase/Managed" },
        ],
      };
    case 6:
      return {
        id: "auth",
        title: "Auth",
        prompt: "Authentication approach?",
        options: [
          { key: "A", label: "None" },
          { key: "B", label: "Password" },
          { key: "C", label: "OAuth" },
          { key: "D", label: "Magic link" },
        ],
      };
    case 7:
      return {
        id: "deploy",
        title: "Deploy",
        prompt: "Target deployment?",
        options: [
          { key: "A", label: "Local only" },
          { key: "B", label: "Vercel" },
          { key: "C", label: "Docker" },
          { key: "D", label: "Fly/Other" },
        ],
      };
    case 8:
      return {
        id: "qualityGates",
        title: "Quality Gates",
        prompt:
          "Pick quality gates. Commands must be single-line and safe to run locally.",
        options: [
          { key: "A", label: "Auto-detect" },
          { key: "B", label: "Skip (empty)" },
          { key: "C", label: "Fast defaults" },
          { key: "D", label: "Custom (D: `cmd` ...)" },
        ],
      };
    case 9:
      return {
        id: "users",
        title: "Users",
        prompt: "Who is the primary user?",
        options: [
          { key: "A", label: "Internal team" },
          { key: "B", label: "Consumers" },
          { key: "C", label: "Developers" },
          { key: "D", label: "Other (D: ...)" },
        ],
      };
    case 10:
      return {
        id: "problem",
        title: "Problem",
        prompt: "What problem category are you solving?",
        options: [
          { key: "A", label: "Automation" },
          { key: "B", label: "Data/UI" },
          { key: "C", label: "LLM assistant" },
          { key: "D", label: "Other (D: ...)" },
        ],
      };
    case 11:
    default:
      return {
        id: "features",
        title: "Must-have Features",
        prompt:
          "Seed feature tasks. Provide a list after the letter, one per line (or semicolon-separated).",
        options: [
          { key: "A", label: "Scaffold-only" },
          { key: "B", label: "3 features (B: ...)" },
          { key: "C", label: "6 features (C: ...)" },
          { key: "D", label: "Custom list (D: ...)" },
        ],
      };
  }
};

const renderWizardQuestion = (q: WizardQuestion, step: number, total: number): string => {
  const header = `PRD wizard (${step + 1}/${total}): ${q.title}`;
  const opts = q.options.map((o) => `${o.key}) ${o.label}`).join("\n");
  return [header, q.prompt, "", opts, "", "Reply with A/B/C/D (you can append text like: D: ...)"]
    .filter((x) => x)
    .join("\n");
};

const applyWizardAnswer = async (params: {
  repoRoot: string;
  prd: PrdJson;
  step: number;
  input: string;
  initialIdeaArg?: string;
}): Promise<{ prd: PrdJson; advanced: boolean; error?: string }> => {
  const { repoRoot, prd, step, input, initialIdeaArg } = params;
  const parsed = parseWizardInput(input);
  if (!parsed) {
    return { prd, advanced: false, error: "Invalid input. Reply with A/B/C/D." };
  }
  const { choice, extra } = parsed;
  const q = wizardQuestionFor({ repoRoot, prd, step });

  const next: PrdJson = {
    ...prd,
    wizard: {
      ...prd.wizard,
      lastQuestionId: q.id,
      answers: { ...prd.wizard.answers, [q.id]: input.trim() },
    },
  };

  const advance = (): { prd: PrdJson; advanced: boolean } => {
    return {
      prd: {
        ...next,
        wizard: {
          ...next.wizard,
          step: Math.min(next.wizard.step + 1, next.wizard.totalSteps),
        },
      },
      advanced: true,
    };
  };

  switch (q.id) {
    case "idea": {
      if (choice === "A") {
        next.idea = path.basename(repoRoot);
        return advance();
      }
      if (choice === "B") {
        if (!next.idea.trim()) {
          return { prd: next, advanced: false, error: "No existing idea set. Use A/C/D." };
        }
        return advance();
      }
      if (choice === "D") {
        next.idea = "";
        return advance();
      }
      if (!extra.trim()) {
        return { prd: next, advanced: false, error: "Missing idea text. Use C: your idea." };
      }
      next.idea = extra.trim();
      return advance();
    }
    case "platform": {
      next.platform = choice === "A" ? "web" : choice === "B" ? "api" : choice === "C" ? "cli" : "library";
      if (next.platform !== "web") {
        next.frontend = false;
      }
      return advance();
    }
    case "frontend": {
      if (next.platform !== "web") {
        // Auto-skip; frontend already forced false.
        return advance();
      }
      next.frontend = choice === "A" ? true : choice === "B" ? false : choice === "C" ? true : null;
      return advance();
    }
    case "language": {
      next.language = choice === "A" ? "typescript" : choice === "B" ? "python" : choice === "C" ? "go" : "rust";
      next.stack = next.stack;
      return advance();
    }
    case "framework": {
      if (choice === "A") {
        // Keep existing; user can edit prd.json manually.
        return advance();
      }
      if (choice === "B") {
        next.framework = next.platform === "web" ? "nextjs" : "express";
        return advance();
      }
      if (choice === "C") {
        next.framework = next.language === "python" ? "fastapi" : next.language === "go" ? "net/http" : null;
        return advance();
      }
      if (!extra.trim()) {
        return { prd: next, advanced: false, error: "Missing framework text. Use D: name." };
      }
      next.framework = extra.trim();
      return advance();
    }
    case "persistence": {
      next.persistence = choice === "A" ? "none" : choice === "B" ? "sqlite" : choice === "C" ? "postgres" : "supabase";
      return advance();
    }
    case "auth": {
      next.auth = choice === "A" ? "none" : choice === "B" ? "password" : choice === "C" ? "oauth" : "magic_link";
      return advance();
    }
    case "deploy": {
      next.deploy = choice === "A" ? "local" : choice === "B" ? "vercel" : choice === "C" ? "docker" : "other";
      return advance();
    }
    case "qualityGates": {
      if (choice === "A") {
        next.qualityGates = await detectNodeQualityGates(repoRoot);
        return advance();
      }
      if (choice === "B") {
        next.qualityGates = [];
        return advance();
      }
      if (choice === "C") {
        // Deterministic fast default that works when scripts exist; otherwise empty.
        const detected = await detectNodeQualityGates(repoRoot);
        next.qualityGates = detected.filter((c) => c.includes("lint") || c.includes("typecheck"));
        return advance();
      }
      const cmds = parseCustomGateCommands(extra);
      if (cmds.length === 0) {
        return { prd: next, advanced: false, error: "No commands found. Use D: `npm test` `npm run lint`" };
      }
      next.qualityGates = cmds;
      return advance();
    }
    case "users": {
      next.product = {
        ...next.product,
        users: choice === "A" ? "internal team" : choice === "B" ? "consumers" : choice === "C" ? "developers" : extra.trim() || "other",
      };
      return advance();
    }
    case "problem": {
      next.product = {
        ...next.product,
        problem: choice === "A" ? "automation" : choice === "B" ? "data/ui" : choice === "C" ? "llm assistant" : extra.trim() || "other",
      };
      return advance();
    }
    case "features": {
      if (choice === "A") {
        next.product = { ...next.product, mustHaveFeatures: [] };
        return advance();
      }
      const rawList = extra.includes("\n") ? linesFromExtra(extra) : extra.split(";").map((s) => s.trim()).filter(Boolean);
      const list = rawList.filter((x) => x.length > 0);
      if (list.length === 0) {
        return { prd: next, advanced: false, error: "No features found. Example: D: login; dashboard; export csv" };
      }
      const max = choice === "B" ? 3 : choice === "C" ? 6 : 50;
      next.product = { ...next.product, mustHaveFeatures: list.slice(0, max) };
      return advance();
    }
    default:
      return { prd: next, advanced: false, error: "Unknown wizard question." };
  }
};

export const createTools = (ctx: PluginContext) => {
  const repoRoot = getRepoRoot(ctx);

  return {
    mario_devx_new: tool({
      description: "PRD wizard (writes .mario/prd.json)",
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

        // Auto-advance step 0 when user passes a raw idea (not A/B/C/D).
        const rawInput = (args.idea ?? "").trim();
        if (prd.wizard.status !== "completed" && prd.wizard.step === 0 && rawInput && !parseWizardInput(rawInput)) {
          prd = {
            ...prd,
            idea: rawInput,
            wizard: {
              ...prd.wizard,
              lastQuestionId: "idea",
              answers: { ...prd.wizard.answers, idea: `D: ${rawInput}` },
              step: 1,
            },
          };
          await writePrdJson(repoRoot, prd);
        }

        if (prd.wizard.status === "completed") {
          return [
            "PRD wizard: completed.",
            `Edit: ${path.join(repoRoot, ".mario", "prd.json")}`,
            "Next: /mario-devx:run 1",
          ].join("\n");
        }

        // Auto-skip frontend question when not a web platform.
        while (prd.wizard.step === 2 && prd.platform && prd.platform !== "web") {
          prd = {
            ...prd,
            frontend: false,
            wizard: { ...prd.wizard, step: prd.wizard.step + 1 },
          };
          await writePrdJson(repoRoot, prd);
        }

        const step = prd.wizard.step;
        const total = prd.wizard.totalSteps;
        const q = wizardQuestionFor({ repoRoot, prd, step });

        if (!rawInput) {
          return renderWizardQuestion(q, step, total);
        }

        const result = await applyWizardAnswer({
          repoRoot,
          prd,
          step,
          input: rawInput,
          initialIdeaArg: args.idea,
        });
        prd = result.prd;
        if (result.error) {
          await writePrdJson(repoRoot, prd);
          return [result.error, "", renderWizardQuestion(q, step, total)].join("\n");
        }
        if (result.advanced) {
          // Completion.
          if (prd.wizard.step >= prd.wizard.totalSteps) {
            const doneWhen = prd.qualityGates ?? [];
            if (prd.tasks.length === 0) {
              const tasks: PrdTask[] = [];
              let n = 1;
              tasks.push(
                makeTask({
                  id: normalizeTaskId(n++),
                  title: prd.idea.trim() ? `Project baseline: ${prd.idea.trim()}` : "Project baseline",
                  doneWhen,
                  notes: ["Seeded by PRD wizard."],
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
              prd = { ...prd, tasks };
            }
            prd = { ...prd, wizard: { ...prd.wizard, status: "completed" } };
            await writePrdJson(repoRoot, prd);
            return [
              "PRD wizard: completed.",
              `PRD: ${path.join(repoRoot, ".mario", "prd.json")}`,
              `Tasks: ${prd.tasks.length}`,
              "Next: /mario-devx:run 1",
            ].join("\n");
          }

          await writePrdJson(repoRoot, prd);
          const nextQ = wizardQuestionFor({ repoRoot, prd, step: prd.wizard.step });
          return renderWizardQuestion(nextQ, prd.wizard.step, prd.wizard.totalSteps);
        }

        await writePrdJson(repoRoot, prd);
        return renderWizardQuestion(q, step, total);
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

        const inProgress = (prd.tasks ?? []).filter((t) => t.status === "in_progress");
        if (inProgress.length > 1) {
          const focus = inProgress[0];
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
          if (focus) {
            prd = setPrdTaskStatus(prd, focus.id, "blocked");
            prd = setPrdTaskLastAttempt(prd, focus.id, lastAttempt);
            await writePrdJson(repoRoot, prd);
          }
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
          const env = parseAgentsEnv(raw);
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
        const gateCommands = (prd.qualityGates ?? []).map((command, idx) => ({
          name: `gate-${idx + 1}`,
          command,
        }));

        const agentsRaw = await readTextIfExists(agentsPath);
        const agentsEnv = agentsRaw ? parseAgentsEnv(agentsRaw) : {};
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
            task.doneWhen.length > 0 ? `Done when:\n${task.doneWhen.map((d) => `- ${d}`).join("\n")}` : "Done when: (none)",
          ]
            .filter((x) => x)
            .join("\n");
          const buildModePrompt = await buildPrompt(repoRoot, "build", iterationPlan);

          await showToast(ctx, `Run: started ${task.id} (${attempted}/${maxItems})`, "info");

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


          await ctx.client.session.promptAsync({
            path: { id: ws.sessionId },
            body: {
              ...(context.agent ? { agent: context.agent } : {}),
              parts: [{ type: "text", text: buildModePrompt }],
            },
          });

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

          const gateResult = await runGateCommands(gateCommands, ctx.$);
          const uiResult = shouldRunUiVerify
            ? await runUiVerification({
                ctx,
                devCmd: uiVerifyCmd,
                url: uiVerifyUrl,
              })
            : null;

          const gates: PrdGatesAttempt = {
            ok: gateResult.ok,
            commands: gateResult.results.map((r) => ({
              command: r.command,
              ok: r.ok,
              exitCode: r.exitCode,
              durationMs: r.durationMs,
              ...(r.outputTail ? { outputTail: r.outputTail } : {}),
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
            await failEarly([
              `Deterministic gate failed: ${failed}.`,
            ]);
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
              task.doneWhen.length > 0
                ? `Done when:\n${task.doneWhen.map((d) => `- ${d}`).join("\n")}`
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
            status: judge.status === "PASS" ? "DONE" : "BLOCKED",
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
        }

        const note =
          completed === attempted && attempted === maxItems
            ? "Reached max_items limit."
            : completed === attempted
              ? "No more open/in_progress tasks found."
              : "Stopped early due to failure. See task.lastAttempt.judge in .mario/prd.json.";

        return `Run finished. Attempted: ${attempted}. Completed: ${completed}. ${note}`;
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
          const blocked = (prd.tasks ?? []).filter((t) => t.status === "blocked").map((t) => t.id);
          if (blocked.length > 0) {
            issues.push(`Blocked tasks: ${blocked.join(", ")}`);
            fixes.push("For each blocked task, read prd.json.tasks[].lastAttempt.judge.nextActions, fix them, then rerun /mario-devx:run 1.");
          }
        }

        // UI verification prerequisites
        const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
        const agentsRaw = await readTextIfExists(agentsPath);
        const agentsEnv = agentsRaw ? parseAgentsEnv(agentsRaw) : {};
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

    mario_devx_help: tool({
      description: "Show mario-devx help",
      args: {},
      async execute() {
        return [
          "mario-devx commands:",
          "- /mario-devx:new <idea>",
          "- /mario-devx:run <N>",
          "- /mario-devx:status",
          "- /mario-devx:doctor",
          "",
          "Note: build/verifier run in a persistent per-repo work session.",
        ].join("\n");
      },
    }),
  };
};
