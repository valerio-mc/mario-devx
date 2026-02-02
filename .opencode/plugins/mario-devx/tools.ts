import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import path from "path";
import { ensureDir, readTextIfExists, writeText } from "./fs";
import { buildPrompt } from "./prompt";
import { resolveGateCommands, persistGateCommands } from "./gates";
import { ensureMario, bumpIteration, readWorkSessionState, writeWorkSessionState, readRunState, writeRunState } from "./state";
import { marioRoot, marioRunsDir } from "./paths";
import { RunPhase, RunState } from "./types";
import { isFrontendProject, isPrdReadyForPlan } from "./bootstrap";

type ToolContext = {
  sessionID?: string;
  agent?: string;
};

type PluginContext = Parameters<Plugin>[0];

const nowIso = (): string => new Date().toISOString();

const getRepoRoot = (ctx: PluginContext): string => ctx.worktree ?? ctx.directory ?? process.cwd();

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

const ensureUiVerifyDefault = async (repoRoot: string): Promise<void> => {
  const prd = await readTextIfExists(path.join(repoRoot, ".mario", "PRD.md"));
  if (!prd || !isFrontendProject(prd)) {
    return;
  }

  const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
  const raw = (await readTextIfExists(agentsPath)) ?? "";
  const env = parseAgentsEnv(raw);
  if (env.UI_VERIFY === "1") {
    return;
  }

  let next = raw;
  next = upsertAgentsKey(next, "UI_VERIFY", "1");
  next = upsertAgentsKey(next, "UI_VERIFY_REQUIRED", "0");
  if (!env.UI_VERIFY_CMD) next = upsertAgentsKey(next, "UI_VERIFY_CMD", "npm run dev");
  if (!env.UI_VERIFY_URL) next = upsertAgentsKey(next, "UI_VERIFY_URL", "http://localhost:3000");
  if (!env.AGENT_BROWSER_REPO) next = upsertAgentsKey(next, "AGENT_BROWSER_REPO", "https://github.com/vercel-labs/agent-browser");
  await writeText(agentsPath, next);
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

const findQualityGatesNonBackticked = (prd: string): string[] => {
  const lines = prd.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Quality Gates");
  if (start === -1) {
    return [];
  }
  const offenders: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      break;
    }
    if (!trimmed.startsWith("-")) {
      continue;
    }
    if (trimmed.includes("`") || trimmed.toLowerCase().includes("todo")) {
      continue;
    }
    offenders.push(trimmed);
  }
  return offenders;
};

const findPlanPlaceholders = (plan: string): string[] => {
  const offenders: string[] = [];
  const patterns = ["[...", "... existing", "... rest", "(...", "...]"];
  const lower = plan.toLowerCase();
  for (const p of patterns) {
    if (lower.includes(p)) {
      offenders.push(p);
    }
  }
  return Array.from(new Set(offenders));
};

const findUnparseablePlanHeaders = (plan: string): string[] => {
  const bad: string[] = [];
  for (const line of plan.split(/\r?\n/)) {
    if (!line.startsWith("### PI-")) {
      continue;
    }
    const ok = /^###\s+PI-\d+\s+-\s+(TODO|DOING|DONE|BLOCKED)\s+-\s+.+$/i.test(line);
    if (!ok) {
      bad.push(line.trim());
    }
  }
  return bad;
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

const readMostRecentPlanItemId = async (repoRoot: string): Promise<string | null> => {
  const planPath = path.join(repoRoot, ".mario", "IMPLEMENTATION_PLAN.md");
  const content = await readTextIfExists(planPath);
  if (!content) {
    return null;
  }
  const matches = Array.from(content.matchAll(/^###\s+(PI-\d+)\s+-\s+(TODO|DOING|DONE|BLOCKED)\s+-/gm));
  if (matches.length === 0) {
    return null;
  }
  return matches[matches.length - 1]?.[1] ?? null;
};

const runUiVerification = async (params: {
  ctx: PluginContext;
  runDir: string;
  devCmd: string;
  url: string;
}): Promise<{ ok: boolean; summary: string }> => {
  const { ctx, runDir, devCmd, url } = params;
  if (!ctx.$) {
    return { ok: false, summary: "Bun shell not available to run UI verification." };
  }

  const logPath = path.join(runDir, "ui-verify.log");
  const pidPath = path.join(runDir, "devserver.pid");
  const snapshotPath = path.join(runDir, "ui-snapshot.json");
  const screenshotPath = path.join(runDir, "ui.png");
  const consolePath = path.join(runDir, "ui-console.json");
  const errorsPath = path.join(runDir, "ui-errors.json");

  const log: string[] = [];
  let pid = "";

  // Start dev server in background.
  log.push(`$ ${devCmd} (background)`);
  const start = await ctx.$`sh -c ${`${devCmd} >/dev/null 2>&1 & echo $!`}`.nothrow();
  pid = start.stdout.toString().trim();
  log.push(`devserver pid: ${pid || "(none)"}`);
  log.push(start.stderr.toString());
  if (!pid) {
    await writeText(logPath, log.join("\n"));
    return { ok: false, summary: "Failed to start dev server." };
  }
  await writeText(pidPath, `${pid}\n`);

  // Wait for URL to respond.
  log.push(`$ wait for ${url}`);
  const waitCmd = `i=0; while [ $i -lt 60 ]; do curl -fsS ${url} >/dev/null 2>&1 && exit 0; i=$((i+1)); sleep 1; done; exit 1`;
  const waited = await ctx.$`sh -c ${waitCmd}`.nothrow();
  log.push(`wait exitCode: ${waited.exitCode}`);
  if (waited.exitCode !== 0) {
    // stop server
    await ctx.$`sh -c ${`kill ${pid} >/dev/null 2>&1 || true`}`.nothrow();
    await writeText(logPath, log.join("\n"));
    return { ok: false, summary: `Dev server did not become ready at ${url}.` };
  }

  // Drive browser with agent-browser.
  const cmds: { label: string; cmd: string }[] = [
    { label: "open", cmd: `agent-browser open ${url}` },
    { label: "snapshot", cmd: `agent-browser snapshot -i --json > ${snapshotPath}` },
    { label: "screenshot", cmd: `agent-browser screenshot ${screenshotPath}` },
    { label: "console", cmd: `agent-browser console --json > ${consolePath}` },
    { label: "errors", cmd: `agent-browser errors --json > ${errorsPath}` },
    { label: "close", cmd: "agent-browser close" },
  ];

  for (const item of cmds) {
    log.push(`$ ${item.cmd}`);
    const r = await ctx.$`sh -c ${item.cmd}`.nothrow();
    log.push(`exitCode: ${r.exitCode}`);
    log.push(r.stdout.toString());
    log.push(r.stderr.toString());
    if (r.exitCode !== 0) {
      // Ensure close and stop server.
      await ctx.$`sh -c ${"agent-browser close >/dev/null 2>&1 || true"}`.nothrow();
      await ctx.$`sh -c ${`kill ${pid} >/dev/null 2>&1 || true`}`.nothrow();
      await writeText(logPath, log.join("\n"));
      return {
        ok: false,
        summary: `agent-browser failed at '${item.label}'. If this is first run, you may need: agent-browser install`,
      };
    }
  }

  // Stop server.
  log.push(`$ kill ${pid}`);
  await ctx.$`sh -c ${`kill ${pid} >/dev/null 2>&1 || true`}`.nothrow();
  await writeText(logPath, log.join("\n"));
  return { ok: true, summary: "UI verification completed." };
};

const appendLine = async (filePath: string, line: string): Promise<void> => {
  const existing = await readTextIfExists(filePath);
  const next = existing ? `${existing.trimEnd()}\n${line}\n` : `${line}\n`;
  await writeText(filePath, next);
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

const getNextPlanItem = async (planPath: string): Promise<{ id: string; title: string; block: string } | null> => {
  const content = await readTextIfExists(planPath);
  if (!content) {
    return null;
  }
  const lines = content.split(/\r?\n/);

  const parseHeader = (line: string): { id: string; status: "DOING" | "TODO"; title: string } | null => {
    const match = line.match(/^###\s+(PI-\d+)\s+-\s+(TODO|DOING)\s+-\s+(.*)$/i);
    if (!match) {
      return null;
    }
    const id = match[1] ?? "";
    const statusRaw = (match[2] ?? "").toUpperCase();
    const title = match[3] ?? "";
    if (!id || !title || (statusRaw !== "TODO" && statusRaw !== "DOING")) {
      return null;
    }
    return { id, status: statusRaw as "DOING" | "TODO", title };
  };

  // Prefer resuming a DOING item; otherwise pick the first TODO.
  let startIndex = -1;
  let parsed: { id: string; status: "DOING" | "TODO"; title: string } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const candidate = parseHeader(lines[i] ?? "");
    if (!candidate) {
      continue;
    }
    if (candidate.status === "DOING") {
      startIndex = i;
      parsed = candidate;
      break;
    }
    if (candidate.status === "TODO" && startIndex === -1) {
      startIndex = i;
      parsed = candidate;
    }
  }

  if (startIndex === -1 || !parsed) {
    return null;
  }

  const { id, title } = parsed;
  const blockLines: string[] = [];
  for (let i = startIndex; i < lines.length; i += 1) {
    if (i !== startIndex && lines[i].startsWith("### PI-")) {
      break;
    }
    blockLines.push(lines[i]);
  }
  return { id, title: title.trim(), block: blockLines.join("\n") };
};

const writeRunArtifacts = async (runDir: string, prompt: string): Promise<void> => {
  await ensureDir(runDir);
  await writeText(path.join(runDir, "prompt.md"), prompt);
};

const runGateCommands = async (
  commands: { name: string; command: string }[],
  $: PluginContext["$"] | undefined,
  runDir: string,
): Promise<{ ok: boolean; summary: string; failed?: { name: string; command: string; exitCode: number }; results: Array<{ name: string; command: string; exitCode: number; durationMs: number }> }> => {
  if (commands.length === 0) {
    return { ok: false, summary: "No quality gates detected.", results: [] };
  }
  if (!$) {
    return { ok: false, summary: "Bun shell not available to run gates.", results: [] };
  }

  const logLines: string[] = [];
  const results: Array<{ name: string; command: string; exitCode: number; durationMs: number }> = [];
  let ok = true;
  let failed: { name: string; command: string; exitCode: number } | undefined;

  for (const command of commands) {
    logLines.push(`$ ${command.command}`);

    const cmd = command.command.trim();
    if (cmd.length === 0) {
      ok = false;
      logLines.push("ERROR: empty gate command");
      break;
    }

    if (cmd.includes("\n") || cmd.includes("\r")) {
      ok = false;
      logLines.push("ERROR: gate command contains newline characters (refusing to run)");
      break;
    }

    const startedAt = Date.now();
    const result = await $`sh -c ${cmd}`.nothrow();
    const durationMs = Date.now() - startedAt;
    results.push({ name: command.name, command: cmd, exitCode: result.exitCode, durationMs });
    logLines.push(`exitCode: ${result.exitCode}`);
    logLines.push(result.stdout.toString());
    logLines.push(result.stderr.toString());

    if (result.exitCode !== 0) {
      ok = false;
      failed = { name: command.name, command: cmd, exitCode: result.exitCode };
      break;
    }
  }

  await writeText(path.join(runDir, "gates.log"), logLines.join("\n"));
  await writeText(path.join(runDir, "gates.json"), JSON.stringify(results, null, 2));
  return {
    ok,
    results,
    ...(failed ? { failed } : {}),
    summary: ok ? "All quality gates passed." : "Quality gate failed. See gates.log.",
  };
};

const formatPromptResult = (title: string, prompt: string): string => {
  return [
    title,
    "",
    "---",
    "",
    prompt,
  ].join("\n");
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
    "- One plan item per build iteration.",
    "",
    "Canonical files:",
    "- PRD: .mario/PRD.md",
    "- Plan: .mario/IMPLEMENTATION_PLAN.md",
    "- Agent config: .mario/AGENTS.md",
    "- State: .mario/state/state.json",
    "- Runs: .mario/runs/*",
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

const planPath = (repoRoot: string): string => path.join(repoRoot, ".mario", "IMPLEMENTATION_PLAN.md");

const startAsyncWorkSessionPrompt = async (params: {
  ctx: PluginContext;
  repoRoot: string;
  context: ToolContext;
  mode: "prd" | "plan";
  phase: RunPhase;
  extra?: string;
  workTitle?: string;
  runState?: Partial<RunState>;
  toast: string;
  notify: (sessionId: string) => string;
}): Promise<{ sessionId: string; baselineMessageId: string }> => {
  const { ctx, repoRoot, context, mode, phase, extra, workTitle, runState, toast, notify } = params;
  await ensureMario(repoRoot, false);
  const ws = await resetWorkSession(ctx, repoRoot, context.agent);
  if (workTitle) {
    await setWorkSessionTitle(ctx, ws.sessionId, workTitle);
  }
  const prompt = await buildPrompt(repoRoot, mode, extra);

  await updateRunState(repoRoot, {
    status: "DOING",
    phase,
    flow: undefined,
    flowNext: undefined,
    controlSessionId: context.sessionID,
    workSessionId: ws.sessionId,
    baselineMessageId: ws.baselineMessageId,
    lastGate: "NONE",
    lastUI: "NONE",
    lastVerifier: "NONE",
    startedAt: nowIso(),
    ...(runState ?? {}),
  });

  await ctx.client.session.promptAsync({
    path: { id: ws.sessionId },
    body: {
      ...(context.agent ? { agent: context.agent } : {}),
      parts: [{ type: "text", text: prompt }],
    },
  });

  await showToast(ctx, toast, "info");
  await notifyControlSession(ctx, context.sessionID, notify(ws.sessionId));

  return {
    sessionId: ws.sessionId,
    baselineMessageId: ws.baselineMessageId,
  };
};

const setPlanItemStatus = async (
  repoRoot: string,
  planItemId: string,
  status: "TODO" | "DOING" | "DONE" | "BLOCKED",
): Promise<void> => {
  const content = await readTextIfExists(planPath(repoRoot));
  if (!content) {
    return;
  }
  const lines = content.split(/\r?\n/);
  const next = lines.map((line) => {
    const match = line.match(/^###\s+(PI-\d+)\s+-\s+(TODO|DOING|DONE|BLOCKED)\s+-\s+(.*)$/i);
    if (!match) {
      return line;
    }
    const id = (match[1] ?? "").toUpperCase();
    if (id !== planItemId.toUpperCase()) {
      return line;
    }
    const title = match[3] ?? "";
    return `### ${planItemId.toUpperCase()} - ${status} - ${title}`;
  });
  await writeText(planPath(repoRoot), next.join("\n"));
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

const parseVerifierStatus = (text: string): { status: "PASS" | "FAIL"; exit: boolean } => {
  const status: "PASS" | "FAIL" = text.includes("Status: PASS") ? "PASS" : "FAIL";
  const exit = text.includes("EXIT_SIGNAL: true");
  if (status === "PASS" && exit) {
    return { status: "PASS", exit: true };
  }
  return { status: "FAIL", exit: false };
};

const formatIterationPlan = (planItem: { id: string; title: string; block: string }): string => {
  return [
    `# Iteration Plan (${planItem.id})`,
    "",
    `Title: ${planItem.title}`,
    "",
    "Plan item:",
    planItem.block,
  ].join("\n");
};

export const createTools = (ctx: PluginContext) => {
  const repoRoot = getRepoRoot(ctx);

  return {
    mario_devx_new: tool({
      description: "Bootstrap: init (if needed) + PRD + plan",
      args: {
        idea: tool.schema.string().optional().describe("Initial idea"),
      },
      async execute(args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }

        await ensureMario(repoRoot, false);
        const prdPath = path.join(repoRoot, ".mario", "PRD.md");
        const prd = await readTextIfExists(prdPath);
        if (prd && isPrdReadyForPlan(prd)) {
          const planWs = await startAsyncWorkSessionPrompt({
            ctx,
            repoRoot,
            context,
            mode: "plan",
            phase: "plan",
            workTitle: "mario-devx (work) - plan",
            toast: "Plan started in work session (use /sessions to open)",
            notify: (sessionId) => `mario-devx plan started in work session: ${sessionId} (open via /sessions).`,
          });
          return [
            `Plan is running in work session: ${planWs.sessionId}.`,
            "Open it via /sessions.",
            "Next: /mario-devx:run 1",
          ].join("\n");
        }

        const ws = await startAsyncWorkSessionPrompt({
          ctx,
          repoRoot,
          context,
          mode: "prd",
          phase: "prd",
          extra: args.idea ? `Initial idea: ${args.idea}` : undefined,
          workTitle: "mario-devx (work) - bootstrap",
          runState: {
            flow: "new",
            flowNext: "plan",
          },
          toast: "Bootstrap started in work session (PRD -> plan)",
          notify: (sessionId) => `mario-devx bootstrap started (PRD -> plan) in work session: ${sessionId} (open via /sessions).`,
        });

        return [
          `Bootstrap started in work session: ${ws.sessionId}`,
          "Open it via /sessions and answer the PRD interview.",
          "When PRD looks complete, mario-devx will automatically start plan generation in the same work session.",
        ].join("\n");
      },
    }),

    mario_devx_run: tool({
      description: "Run next plan items (build + verify, stops on failure)",
      args: {
        max_items: tool.schema.string().optional().describe("Maximum number of plan items to attempt (default: 1)"),
      },
      async execute(args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }

        await ensureMario(repoRoot, false);
        await ensureUiVerifyDefault(repoRoot);
        const rawMax = (args.max_items ?? "").trim();
        const parsed = rawMax.length === 0 ? 1 : Number.parseInt(rawMax, 10);
        const maxItems = Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 1;

        const prdPath = path.join(repoRoot, ".mario", "PRD.md");
        const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
        const gateCommands = await resolveGateCommands(repoRoot, prdPath, agentsPath);
        // Only persist auto-detected gates to avoid PRD/AGENTS drift.
        if (gateCommands.some((c) => c.source === "auto")) {
          await persistGateCommands(agentsPath, gateCommands);
        }

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
          const planItem = await getNextPlanItem(planPath(repoRoot));
          if (!planItem) {
            break;
          }
          attempted += 1;

          const state = await bumpIteration(repoRoot);
          const runDir = path.join(
            marioRunsDir(repoRoot),
            `${new Date().toISOString().replace(/[:.]/g, "")}-run-iter${state.iteration}`,
          );
          await ensureDir(runDir);

          const iterationPlan = formatIterationPlan(planItem);
          const buildModePrompt = await buildPrompt(repoRoot, "build", iterationPlan);
          await writeRunArtifacts(runDir, buildModePrompt);

          await showToast(ctx, `Run: started ${planItem.id} (${attempted}/${maxItems})`, "info");

          const ws = await resetWorkSession(ctx, repoRoot, context.agent);
          await setWorkSessionTitle(ctx, ws.sessionId, `mario-devx (work) - ${planItem.id}`);
          await updateRunState(repoRoot, {
            status: "DOING",
            phase: "run",
            currentPI: planItem.id,
            controlSessionId: context.sessionID,
            runDir,
            workSessionId: ws.sessionId,
            baselineMessageId: ws.baselineMessageId,
            lastGate: "NONE",
            lastUI: "NONE",
            lastVerifier: "NONE",
            startedAt: nowIso(),
          });

          await setPlanItemStatus(repoRoot, planItem.id, "DOING");

          await ctx.client.session.promptAsync({
            path: { id: ws.sessionId },
            body: {
              ...(context.agent ? { agent: context.agent } : {}),
              parts: [{ type: "text", text: buildModePrompt }],
            },
          });

          const idle = await waitForSessionIdle(ctx, ws.sessionId, 20 * 60 * 1000);
          if (!idle) {
            const text = [
              "Status: FAIL",
              "EXIT_SIGNAL: false",
              "Reason:",
              "- Build timed out waiting for the work session to go idle.",
              "Next actions:",
              "- Open /sessions -> mario-devx (work) and inspect the current state.",
            ].join("\n");
            await writeText(path.join(runDir, "judge.out"), text);
            await setPlanItemStatus(repoRoot, planItem.id, "BLOCKED");
            await updateRunState(repoRoot, {
              status: "BLOCKED",
              phase: "run",
              currentPI: planItem.id,
              runDir,
              latestVerdictPath: path.join(runDir, "judge.out"),
              lastGate: "NONE",
              lastUI: "NONE",
              lastVerifier: "FAIL",
            });
            await showToast(ctx, `Run stopped: build timed out on ${planItem.id}`, "warning");
            break;
          }

          const gateResult = await runGateCommands(gateCommands, ctx.$, runDir);
          const uiResult = shouldRunUiVerify
            ? await runUiVerification({
                ctx,
                runDir,
                devCmd: uiVerifyCmd,
                url: uiVerifyUrl,
              })
            : null;

          const failEarly = async (reasonLines: string[]): Promise<void> => {
            const text = [
              "Status: FAIL",
              "EXIT_SIGNAL: false",
              "Reason:",
              ...reasonLines.map((l) => `- ${l}`),
              "Next actions:",
              "- Fix the failing checks, then rerun /mario-devx:run 1.",
            ].join("\n");
            await writeText(path.join(runDir, "judge.out"), text);
            await setPlanItemStatus(repoRoot, planItem.id, "BLOCKED");
            await updateRunState(repoRoot, {
              status: "BLOCKED",
              phase: "run",
              currentPI: planItem.id,
              runDir,
              latestVerdictPath: path.join(runDir, "judge.out"),
              lastGate: gateResult.ok ? "PASS" : "FAIL",
              lastUI: uiResult ? (uiResult.ok ? "PASS" : "FAIL") : "NONE",
              lastVerifier: "FAIL",
            });
          };

          if (!gateResult.ok) {
            const failed = gateResult.failed
              ? `${gateResult.failed.command} (exit ${gateResult.failed.exitCode})`
              : "(unknown command)";
            await failEarly([
              `Deterministic gate failed: ${failed}.`,
              `Evidence: ${path.join(runDir, "gates.log")}`,
              `Evidence: ${path.join(runDir, "gates.json")}`,
            ]);
            await showToast(ctx, `Run stopped: gates failed on ${planItem.id}`, "warning");
            break;
          }

          if (uiVerifyEnabled && isWebApp && uiVerifyRequired && (!cliOk || !skillOk)) {
            await failEarly([
              "UI verification is required but agent-browser prerequisites are missing.",
              `Repo: ${agentBrowserRepo}`,
              "Install: npx skills add vercel-labs/agent-browser",
              "Install: npm install -g agent-browser && agent-browser install",
            ]);
            await showToast(ctx, `Run stopped: UI prerequisites missing on ${planItem.id}`, "warning");
            break;
          }

          if (uiVerifyEnabled && isWebApp && uiVerifyRequired && uiResult && !uiResult.ok) {
            await failEarly([
              `UI verification failed (see ${path.join(runDir, "ui-verify.log")}).`,
            ]);
            await showToast(ctx, `Run stopped: UI verification failed on ${planItem.id}`, "warning");
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
              `Run artifacts: ${runDir}`,
              "Deterministic gates: PASS",
              `Gates log: ${path.join(runDir, "gates.log")}`,
              `Plan item: ${planItem.id} - ${planItem.title}`,
              uiResult ? `UI verification: ${uiResult.ok ? "PASS" : "FAIL"}` : "UI verification: (not run)",
              uiResult ? `UI log: ${path.join(runDir, "ui-verify.log")}` : "",
            ]
              .filter((x) => x)
              .join("\n"),
          );

          await setWorkSessionTitle(ctx, ws.sessionId, `mario-devx (work) - judge ${planItem.id}`);
          const verifierResponse = await ctx.client.session.prompt({
            path: { id: ws.sessionId },
            body: {
              ...(context.agent ? { agent: context.agent } : {}),
              parts: [{ type: "text", text: verifierPrompt }],
            },
          });
          const verifierText = extractTextFromPromptResponse(verifierResponse);
          await writeText(path.join(runDir, "judge.out"), verifierText);

          const parsed = parseVerifierStatus(verifierText);
          const verdictPath = path.join(runDir, "judge.out");
          await updateRunState(repoRoot, {
            status: parsed.status === "PASS" ? "DONE" : "BLOCKED",
            phase: "run",
            currentPI: planItem.id,
            controlSessionId: context.sessionID,
            runDir,
            latestVerdictPath: verdictPath,
            lastGate: "PASS",
            lastUI: uiResult ? (uiResult.ok ? "PASS" : "FAIL") : "NONE",
            lastVerifier: parsed.status,
          });

          await setPlanItemStatus(repoRoot, planItem.id, parsed.status === "PASS" ? "DONE" : "BLOCKED");
        // History lives in .mario/runs/* (gates.log/gates.json/judge.out and optional UI artifacts).

          if (parsed.status !== "PASS" || !parsed.exit) {
            await showToast(ctx, `Run stopped: verifier failed on ${planItem.id}`, "warning");
            break;
          }

          completed += 1;
          await showToast(ctx, `Run: completed ${planItem.id} (${completed}/${maxItems})`, "success");
        }

        const note =
          completed === attempted && attempted === maxItems
            ? "Reached max_items limit."
            : completed === attempted
              ? "No more TODO/DOING plan items found."
              : "Stopped early due to failure. See .mario/runs/<latest>/judge.out.";

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

        const next =
          run.status === "DOING"
            ? "Open /sessions to watch mario-devx (work)."
            : run.status === "BLOCKED"
              ? "Read the last judge.out in .mario/runs/* (see state/state.json for runDir), fix issues, then run /mario-devx:run 1."
              : "Run /mario-devx:run 1 to execute the next plan item.";

        await notifyControlSession(
          ctx,
          context.sessionID,
          `mario-devx status: work session ${ws.sessionId}.`,
        );

        return [
          `Iteration: ${run.iteration}`,
          `Work session: ${ws.sessionId}`,
          `Run state: ${run.status} (${run.phase})${run.currentPI ? ` ${run.currentPI}` : ""}`,
          run.latestVerdictPath ? `Latest verdict: ${run.latestVerdictPath}` : "Latest verdict: (none)",
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

        // PRD gates
        const prdPath = path.join(repoRoot, ".mario", "PRD.md");
        const prd = await readTextIfExists(prdPath);
        if (!prd) {
          issues.push("Missing .mario/PRD.md");
          fixes.push("Run /mario-devx:new <idea>");
        } else {
          const offenders = findQualityGatesNonBackticked(prd);
          if (offenders.length > 0) {
            issues.push("PRD Quality Gates contains non-backticked bullets (these are not runnable commands).");
            fixes.push("Edit .mario/PRD.md: in ## Quality Gates, keep commands only and wrap them in backticks.");
          }
        }

        // Plan placeholders / headers
        const plan = await readTextIfExists(planPath(repoRoot));
        if (!plan) {
          issues.push("Missing .mario/IMPLEMENTATION_PLAN.md");
          fixes.push("Run /mario-devx:new <idea>");
        } else {
          const placeholders = findPlanPlaceholders(plan);
          if (placeholders.length > 0) {
            issues.push(`Implementation plan contains placeholders (${placeholders.join(", ")}).`);
            fixes.push("Run /mario-devx:new again; it must write a fully expanded plan (no placeholders).");
          }
          const badHeaders = findUnparseablePlanHeaders(plan);
          if (badHeaders.length > 0) {
            issues.push(`Found unparseable plan item headers (${badHeaders.length}).`);
            fixes.push("Fix plan headers to: ### PI-0007 - TODO - Title (or DOING/DONE/BLOCKED).",
            );
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
          "Note: PRD/plan/build/verifier run in a persistent per-repo work session.",
        ].join("\n");
      },
    }),
  };
};
