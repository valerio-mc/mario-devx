import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import path from "path";
import { ensureDir, readTextIfExists, writeText } from "./fs";
import { buildPrompt } from "./prompt";
import { resolveGateCommands, persistGateCommands } from "./gates";
import { ensureMario, bumpIteration, readIterationState, writeIterationState, readPendingPlan, writePendingPlan, clearPendingPlan, getPendingPlanPath, readWorkSessionState, writeWorkSessionState, readRunState, writeRunState } from "./state";
import { marioRoot, marioRunsDir } from "./paths";
import { PendingPlan, RunPhase, RunState } from "./types";

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
): Promise<{ ok: boolean; summary: string }> => {
  if (commands.length === 0) {
    return { ok: false, summary: "No quality gates detected." };
  }
  if (!$) {
    return { ok: false, summary: "Bun shell not available to run gates." };
  }

  const logLines: string[] = [];
  let ok = true;

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

    const result = await $`sh -c ${cmd}`.nothrow();
    logLines.push(`exitCode: ${result.exitCode}`);
    logLines.push(result.stdout.toString());
    logLines.push(result.stderr.toString());

    if (result.exitCode !== 0) {
      ok = false;
      break;
    }
  }

  await writeText(path.join(runDir, "gates.log"), logLines.join("\n"));
  return {
    ok,
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
    "- Specs: .mario/specs/*",
    "- Plan: .mario/IMPLEMENTATION_PLAN.md",
    "- Agent config: .mario/AGENTS.md",
    "- Feedback: .mario/state/feedback.md",
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

const runInChildSession = async (
  ctx: PluginContext,
  agent: string | undefined,
  prompt: string,
): Promise<{ sessionID: string; outputText: string }> => {
  const created = await ctx.client.session.create();
  const sessionID = (created as { data?: { id?: string } }).data?.id;
  if (!sessionID) {
    return { sessionID: "", outputText: "" };
  }
  const response = await ctx.client.session.prompt({
    path: { id: sessionID },
    body: {
      agent,
      parts: [{ type: "text", text: prompt }],
    },
  });
  return { sessionID, outputText: extractTextFromPromptResponse(response) };
};

const draftPendingPlan = async (
  repoRoot: string,
  idea: string | undefined,
): Promise<{ pending: PendingPlan; content: string } | null> => {
  const planPath = path.join(repoRoot, ".mario", "IMPLEMENTATION_PLAN.md");
  const planItem = await getNextPlanItem(planPath);
  if (!planItem) {
    return null;
  }
  const content = [
    `# Pending Iteration Plan (${planItem.id})`,
    "",
    `Title: ${planItem.title}`,
    idea ? `Idea: ${idea}` : null,
    "",
    "Plan item:",
    planItem.block,
    "",
    "Proposed steps:",
    "- ",
    "- ",
  ]
    .filter((line) => line !== null)
    .join("\n");

  const pending: PendingPlan = {
    id: planItem.id,
    title: planItem.title,
    block: planItem.block,
    createdAt: nowIso(),
    idea,
  };
  return { pending, content };
};

export const createTools = (ctx: PluginContext) => {
  const repoRoot = getRepoRoot(ctx);

  return {
    mario_devx_init: tool({
      description: "Initialize mario-devx state files",
      args: {
        force: tool.schema.boolean().optional().describe("Overwrite existing files"),
      },
      async execute(args) {
        await ensureMario(repoRoot, Boolean(args.force));
        return "mario-devx initialized in .mario/";
      },
    }),

    mario_devx_prd: tool({
      description: "Start PRD interview",
      args: {
        idea: tool.schema.string().optional().describe("Initial idea"),
      },
      async execute(args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }
        await ensureMario(repoRoot, false);
        const ws = await resetWorkSession(ctx, repoRoot, context.agent);
        const prompt = await buildPrompt(repoRoot, "prd", args.idea ? `Initial idea: ${args.idea}` : undefined);
        await ctx.client.session.promptAsync({
          path: { id: ws.sessionId },
          body: {
            ...(context.agent ? { agent: context.agent } : {}),
            parts: [{ type: "text", text: prompt }],
          },
        });
        await showToast(ctx, "PRD started in work session (use /sessions to open)", "info");
        await notifyControlSession(
          ctx,
          context.sessionID,
          `mario-devx PRD started in work session: ${ws.sessionId} (open via /sessions).`,
        );
        return `PRD is running in work session: ${ws.sessionId}. Use /sessions to open it and answer the questions.`;
      },
    }),

    mario_devx_plan: tool({
      description: "Generate/update implementation plan",
      args: {},
      async execute(_args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }
        await ensureMario(repoRoot, false);
        const ws = await resetWorkSession(ctx, repoRoot, context.agent);
        const prompt = await buildPrompt(repoRoot, "plan");
        await ctx.client.session.promptAsync({
          path: { id: ws.sessionId },
          body: {
            ...(context.agent ? { agent: context.agent } : {}),
            parts: [{ type: "text", text: prompt }],
          },
        });
        await showToast(ctx, "Plan started in work session (use /sessions to open)", "info");
        await notifyControlSession(
          ctx,
          context.sessionID,
          `mario-devx plan started in work session: ${ws.sessionId} (open via /sessions).`,
        );
        return `Plan is running in work session: ${ws.sessionId}. Use /sessions to open it. Next: /mario-devx:build.`;
      },
    }),

    mario_devx_build: tool({
      description: "Draft the next iteration plan (HITL checkpoint)",
      args: {
        idea: tool.schema.string().optional().describe("Additional idea or hint"),
      },
      async execute(args) {
        await ensureMario(repoRoot, false);
        const draft = await draftPendingPlan(repoRoot, args.idea);
        if (!draft) {
          return [
            "No TODO/DOING plan items found in .mario/IMPLEMENTATION_PLAN.md.",
            "",
            "Common causes:",
            "- The plan contains placeholders like '[... existing ...]' instead of real plan items.",
            "- Plan item headers are not in the format: '### PI-0003 - TODO - Title'",
            "",
            "Fix:",
            "- Run /mario-devx:plan again and ensure it writes fully-expanded plan items (no placeholders).",
          ].join("\n");
        }
        await writePendingPlan(repoRoot, draft.pending, draft.content);
        await showToast(ctx, `Pending plan drafted for ${draft.pending.id}.`, "info");
        return `Drafted pending plan at ${getPendingPlanPath(repoRoot)}. Review it, then run /mario-devx:approve.`;
      },
    }),

    mario_devx_approve: tool({
      description: "Approve and execute the pending iteration",
      args: {},
      async execute(_args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }
        const { pending, content } = await readPendingPlan(repoRoot);
        if (!pending || !content) {
          return "No pending plan found. Run /mario-devx:build first.";
        }
        const state = await bumpIteration(repoRoot, "build");
        const runDir = path.join(
          marioRunsDir(repoRoot),
          `${new Date().toISOString().replace(/[:.]/g, "")}-build-iter${state.iteration}`,
        );
        await ensureDir(runDir);
        const prompt = await buildPrompt(repoRoot, "build", content);
        await writeRunArtifacts(runDir, prompt);

        const ws = await resetWorkSession(ctx, repoRoot, context.agent);

        await updateRunState(repoRoot, {
          status: "DOING",
          phase: "build",
          currentPI: pending.id,
          runDir,
          workSessionId: ws.sessionId,
          baselineMessageId: ws.baselineMessageId,
          lastGate: "NONE",
          lastUI: "NONE",
          lastVerifier: "NONE",
          startedAt: nowIso(),
        });

        await setPlanItemStatus(repoRoot, pending.id, "DOING");

        await ctx.client.session.promptAsync({
          path: { id: ws.sessionId },
          body: {
            ...(context.agent ? { agent: context.agent } : {}),
            parts: [{ type: "text", text: prompt }],
          },
        });

        await clearPendingPlan(repoRoot);
        await writeIterationState(repoRoot, {
          ...state,
          lastRunDir: runDir,
          lastStatus: "NONE",
        });

        await showToast(ctx, `Approved ${pending.id}. Build running in work session.`, "info");
        await notifyControlSession(
          ctx,
          context.sessionID,
          `mario-devx approved ${pending.id}. Build running in work session: ${ws.sessionId}.`,
        );

        return [
          `Build started in work session: ${ws.sessionId}`,
          `Plan item: ${pending.id}`,
          `Run dir: ${runDir}`,
          "",
          "Open the work session via /sessions to watch progress.",
          "After implementation, run /mario-devx:verify from a control session.",
        ].join("\n");
      },
    }),

    mario_devx_cancel: tool({
      description: "Cancel pending iteration plan",
      args: {},
      async execute() {
        await clearPendingPlan(repoRoot);
        return "Pending plan cleared.";
      },
    }),

    mario_devx_verify: tool({
      description: "Run deterministic gates + LLM judge without executing",
      args: {},
      async execute(_args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }
        await ensureMario(repoRoot, false);
        const current = await readIterationState(repoRoot);
        const state = current.iteration === 0 ? await bumpIteration(repoRoot, "build") : current;

        const runDir =
          state.lastRunDir && state.lastRunDir.length > 0
            ? state.lastRunDir
            : path.join(
                marioRunsDir(repoRoot),
                `${new Date().toISOString().replace(/[:.]/g, "")}-verify-iter${state.iteration}`,
              );

        await ensureDir(runDir);
        const prdPath = path.join(repoRoot, ".mario", "PRD.md");
        const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
        const gateCommands = await resolveGateCommands(repoRoot, prdPath, agentsPath);
        await persistGateCommands(agentsPath, gateCommands);
        const gateResult = await runGateCommands(gateCommands, ctx.$, runDir);

        const planItemId = await readMostRecentPlanItemId(repoRoot);

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
        const uiResult = shouldRunUiVerify
          ? await runUiVerification({
              ctx,
              runDir,
              devCmd: uiVerifyCmd,
              url: uiVerifyUrl,
            })
          : null;

        const failEarly = async (reasonLines: string[]): Promise<string> => {
          const text = [
            "Status: FAIL",
            "EXIT_SIGNAL: false",
            "Reason:",
            ...reasonLines.map((l) => `- ${l}`),
            "Next actions:",
            "- Fix the failing checks, then rerun /mario-devx:verify.",
          ].join("\n");
          await writeText(path.join(runDir, "judge.out"), text);
          await writeText(path.join(marioRoot(repoRoot), "state", "feedback.md"), text);
          await updateRunState(repoRoot, {
            status: "BLOCKED",
            phase: "verify",
            currentPI: planItemId ?? undefined,
            runDir,
            lastGate: gateResult.ok ? "PASS" : "FAIL",
            lastUI: uiResult ? (uiResult.ok ? "PASS" : "FAIL") : "NONE",
            lastVerifier: "FAIL",
          });
          await writeIterationState(repoRoot, {
            ...state,
            lastRunDir: runDir,
            lastStatus: "FAIL",
          });
          await appendLine(path.join(repoRoot, ".mario", "progress.md"), `- ${nowIso()} verify iter=${state.iteration} result=FAIL`);
          await showToast(ctx, "Verification: FAIL", "warning");
          return text;
        };

        if (!gateResult.ok) {
          return failEarly([
            `Deterministic gates failed (see ${path.join(runDir, "gates.log")}).`,
          ]);
        }

        if (uiVerifyEnabled && isWebApp && uiVerifyRequired && (!cliOk || !skillOk)) {
          return failEarly([
            "UI verification is required but agent-browser prerequisites are missing.",
            `Repo: ${agentBrowserRepo}`,
            "Install: npx skills add vercel-labs/agent-browser",
            "Install: npm install -g agent-browser && agent-browser install",
          ]);
        }

        if (uiVerifyEnabled && isWebApp && uiVerifyRequired && uiResult && !uiResult.ok) {
          return failEarly([
            `UI verification failed (see ${path.join(runDir, "ui-verify.log")}).`,
          ]);
        }

        await appendLine(path.join(repoRoot, ".mario", "progress.md"), `- ${nowIso()} verify iter=${state.iteration} gates=PASS${uiResult ? ` ui=${uiResult.ok ? "PASS" : "FAIL"}` : ""}`);

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
            planItemId ? `Plan item: ${planItemId}` : "Plan item: (unknown)",
            uiResult ? `UI verification: ${uiResult.ok ? "PASS" : "FAIL"}` : "UI verification: (not run)",
            uiResult ? `UI log: ${path.join(runDir, "ui-verify.log")}` : "",
          ].join("\n"),
        );

        const ws = await resetWorkSession(ctx, repoRoot, context.agent);
        const verifierResponse = await ctx.client.session.prompt({
          path: { id: ws.sessionId },
          body: {
            ...(context.agent ? { agent: context.agent } : {}),
            parts: [{ type: "text", text: verifierPrompt }],
          },
        });
        const verifierText = extractTextFromPromptResponse(verifierResponse);
        await writeText(path.join(runDir, "judge.out"), verifierText);
        await writeText(path.join(marioRoot(repoRoot), "state", "feedback.md"), verifierText || "Status: FAIL\nEXIT_SIGNAL: false\n");

        const parsed = parseVerifierStatus(verifierText);
        await updateRunState(repoRoot, {
          status: parsed.status === "PASS" ? "DONE" : "BLOCKED",
          phase: "verify",
          currentPI: planItemId ?? undefined,
          runDir,
          lastGate: "PASS",
          lastUI: uiResult ? (uiResult.ok ? "PASS" : "FAIL") : "NONE",
          lastVerifier: parsed.status,
        });
        await writeIterationState(repoRoot, {
          ...state,
          lastRunDir: runDir,
          lastStatus: parsed.status,
        });

        await showToast(ctx, `Verifier: ${parsed.status}`, parsed.status === "PASS" ? "success" : "warning");
        return `Verification complete. Gates: PASS${uiResult ? `; UI: ${uiResult.ok ? "PASS" : "FAIL"}` : ""}. Verifier: ${parsed.status}.`;
      },
    }),

    mario_devx_ui_verify: tool({
      description: "Configure UI verification (agent-browser) for mario-devx",
      args: {},
      async execute() {
        await ensureMario(repoRoot, false);

        const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
        const agentsRaw = (await readTextIfExists(agentsPath)) ?? "";
        const isWebApp = await isLikelyWebApp(repoRoot);
        if (!isWebApp) {
          return "This project does not look like a Node web app (no Next/Vite/react-scripts detected).";
        }

        const cliOk = await hasAgentBrowserCli(ctx);
        const skillOk = await hasAgentBrowserSkill(repoRoot);

        let next = agentsRaw;
        next = upsertAgentsKey(next, "UI_VERIFY", "1");
        next = upsertAgentsKey(next, "UI_VERIFY_REQUIRED", "0");
        next = upsertAgentsKey(next, "UI_VERIFY_CMD", "npm run dev");
        next = upsertAgentsKey(next, "UI_VERIFY_URL", "http://localhost:3000");
        next = upsertAgentsKey(next, "AGENT_BROWSER_REPO", "https://github.com/vercel-labs/agent-browser");
        await writeText(agentsPath, next);

        const missing: string[] = [];
        if (!skillOk) missing.push("agent-browser skill");
        if (!cliOk) missing.push("agent-browser CLI");

        if (missing.length === 0) {
          return "UI verification enabled in .mario/AGENTS.md (UI_VERIFY=1). agent-browser prerequisites found.";
        }

        return [
          "UI verification enabled in .mario/AGENTS.md (UI_VERIFY=1), but prerequisites are missing:",
          `- Missing: ${missing.join(", ")}`,
          "",
          "Install options:",
          "- Skill: npx skills add vercel-labs/agent-browser",
          "- CLI: npm install -g agent-browser && agent-browser install",
          "",
          "Reply with which ones to install (skill / cli / both), or keep going without UI verification.",
        ].join("\n");
      },
    }),

    mario_devx_auto: tool({
      description: "Run up to N plan items automatically (stops on failure)",
      args: {
        max_items: tool.schema
          .number()
          .min(1)
          .max(100)
          .describe("Maximum number of plan items to attempt")
          .default(1),
      },
      async execute(args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }
        await ensureMario(repoRoot, false);

        const maxItems = Math.floor(args.max_items);
        const prdPath = path.join(repoRoot, ".mario", "PRD.md");
        const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
        const gateCommands = await resolveGateCommands(repoRoot, prdPath, agentsPath);
        await persistGateCommands(agentsPath, gateCommands);

        let attempted = 0;
        let completed = 0;

        while (attempted < maxItems) {
          const draft = await draftPendingPlan(repoRoot, undefined);
          if (!draft) {
            break;
          }

          attempted += 1;
          const state = await bumpIteration(repoRoot, "build");
          const runDir = path.join(
            marioRunsDir(repoRoot),
            `${new Date().toISOString().replace(/[:.]/g, "")}-auto-iter${state.iteration}`,
          );
          await ensureDir(runDir);

          const buildModePrompt = await buildPrompt(repoRoot, "build", draft.content);
          await writeRunArtifacts(runDir, buildModePrompt);

          await showToast(ctx, `Auto: running ${draft.pending.id} (step ${attempted}/${maxItems})`, "info");

          // Run build in the persistent work session (reset to baseline first).
          const ws = await resetWorkSession(ctx, repoRoot, context.agent);
          await updateRunState(repoRoot, {
            status: "DOING",
            phase: "auto",
            currentPI: draft.pending.id,
            runDir,
            workSessionId: ws.sessionId,
            baselineMessageId: ws.baselineMessageId,
            lastGate: "NONE",
            lastUI: "NONE",
            lastVerifier: "NONE",
            startedAt: nowIso(),
          });
          await setPlanItemStatus(repoRoot, draft.pending.id, "DOING");

          await notifyControlSession(
            ctx,
            context.sessionID,
            `mario-devx auto: started ${draft.pending.id} in work session ${ws.sessionId} (step ${attempted}/${maxItems}).`,
          );

          await ctx.client.session.promptAsync({
            path: { id: ws.sessionId },
            body: {
              ...(context.agent ? { agent: context.agent } : {}),
              parts: [{ type: "text", text: buildModePrompt }],
            },
          });

          const idle = await waitForSessionIdle(ctx, ws.sessionId, 20 * 60 * 1000);
          if (!idle) {
            await updateRunState(repoRoot, {
              status: "BLOCKED",
              phase: "auto",
              currentPI: draft.pending.id,
              runDir,
              lastGate: "NONE",
              lastVerifier: "NONE",
            });
            await showToast(ctx, `Auto stopped: build timed out on ${draft.pending.id}`, "warning");
            break;
          }

          // Deterministic gates in the plugin process (fast feedback).
          const gateResult = await runGateCommands(gateCommands, ctx.$, runDir);

          // Verifier runs as another child session. It must write feedback to .mario/state/feedback.md.
          const verifierPrompt = await buildPrompt(
            repoRoot,
            "verify",
            [
              `Run artifacts: ${runDir}`,
              `Deterministic gates: ${gateResult.ok ? "PASS" : "FAIL"}`,
              `Gates log: ${path.join(runDir, "gates.log")}`,
              `Plan item: ${draft.pending.id} - ${draft.pending.title}`,
            ].join("\n"),
          );

          await resetWorkSession(ctx, repoRoot, context.agent);
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
          await writeText(path.join(marioRoot(repoRoot), "state", "feedback.md"), verifierText || "Status: FAIL\n");

          await updateRunState(repoRoot, {
            status: parsed.status === "PASS" ? "DONE" : "BLOCKED",
            phase: "auto",
            currentPI: draft.pending.id,
            runDir,
            lastGate: gateResult.ok ? "PASS" : "FAIL",
            lastUI: "NONE",
            lastVerifier: parsed.status,
          });

          await setPlanItemStatus(repoRoot, draft.pending.id, parsed.status === "PASS" ? "DONE" : "BLOCKED");

          await appendLine(
            path.join(repoRoot, ".mario", "progress.md"),
            `- ${nowIso()} auto iter=${state.iteration} item=${draft.pending.id} gates=${gateResult.ok ? "PASS" : "FAIL"} judge=${parsed.status}`,
          );

          await writeIterationState(repoRoot, {
            ...state,
            lastRunDir: runDir,
            lastStatus: parsed.status,
          });

          if (!gateResult.ok) {
            await showToast(ctx, `Auto stopped: gates failed on ${draft.pending.id}`, "warning");
            break;
          }

          if (parsed.status !== "PASS" || !parsed.exit) {
            await showToast(ctx, `Auto stopped: verifier failed on ${draft.pending.id}`, "warning");
            break;
          }

          completed += 1;
        }

        const note =
          completed === attempted && attempted === maxItems
            ? "Reached max_items limit."
            : completed === attempted
              ? "No more TODO plan items found."
              : "Stopped early due to failure. See .mario/state/feedback.md.";

        return `Auto finished. Attempted: ${attempted}. Completed: ${completed}. ${note}`;
      },
    }),

    mario_devx_status: tool({
      description: "Show mario-devx status",
      args: {},
      async execute() {
        const state = await readIterationState(repoRoot);
        const pending = await readPendingPlan(repoRoot);
        const ws = await readWorkSessionState(repoRoot);
        const run = await readRunState(repoRoot);
        return [
          `Iteration: ${state.iteration}`,
          `Last mode: ${state.lastMode ?? "none"}`,
          `Last status: ${state.lastStatus ?? "none"}`,
          `Work session: ${ws?.sessionId ?? "none"}`,
          `Run state: ${run.status} (${run.phase})${run.currentPI ? ` ${run.currentPI}` : ""}`,
          pending.pending ? `Pending plan: ${pending.pending.id} (${getPendingPlanPath(repoRoot)})` : "Pending plan: none",
        ].join("\n");
      },
    }),

    mario_devx_resume: tool({
      description: "Resume from the last run state",
      args: {},
      async execute(_args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          return notInWork.message;
        }
        await ensureMario(repoRoot, false);

        const pending = await readPendingPlan(repoRoot);
        if (pending.pending) {
          return `Pending plan exists (${pending.pending.id}). Review ${getPendingPlanPath(repoRoot)}, then run /mario-devx:approve.`;
        }

        const run = await readRunState(repoRoot);
        if (run.status === "DOING") {
          return [
            `Last run is in progress: ${run.phase}${run.currentPI ? ` ${run.currentPI}` : ""}.`,
            "Next: run /mario-devx:verify to evaluate current state.",
          ].join("\n");
        }

        if (run.status === "BLOCKED") {
          return [
            `Last run is BLOCKED${run.currentPI ? ` on ${run.currentPI}` : ""}.`,
            "Read .mario/state/feedback.md, then run /mario-devx:build to draft the next iteration (or rerun /mario-devx:verify after fixing).",
          ].join("\n");
        }

        return "Run /mario-devx:build to draft the next iteration plan.";
      },
    }),

    mario_devx_help: tool({
      description: "Show mario-devx help",
      args: {},
      async execute() {
        return [
          "mario-devx commands:",
          "- /mario-devx:init",
          "- /mario-devx:prd [idea]",
          "- /mario-devx:plan",
          "- /mario-devx:build [idea] (draft pending plan)",
          "- /mario-devx:approve (execute pending plan)",
          "- /mario-devx:cancel",
          "- /mario-devx:verify",
          "- /mario-devx:auto <N>",
          "- /mario-devx:ui-verify",
          "- /mario-devx:status",
          "- /mario-devx:resume",
          "",
          "Note: PRD/plan/build/verifier run in a persistent per-repo work session.",
        ].join("\n");
      },
    }),
  };
};
