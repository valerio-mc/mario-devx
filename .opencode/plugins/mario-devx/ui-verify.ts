import path from "path";
import { spawn } from "child_process";
import { closeSync, openSync } from "fs";
import { copyFile, mkdir, stat } from "fs/promises";
import { ensureDir, readTextIfExists, writeTextAtomic } from "./fs";
import { redactForLog } from "./logging";
import { runShellCommand } from "./shell";
import { readUiVerifyState } from "./state";
import { marioStateDir } from "./paths";

export type LoggedShellResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type UiVerificationEvidence = {
  snapshot?: string;
  snapshotInteractive?: string;
  screenshot?: string;
  console?: string;
  errors?: string;
};

export type UiVerificationResult = {
  ok: boolean;
  note?: string;
  evidence?: UiVerificationEvidence;
};

type AgentBrowserPrereqJobStatus = "installing" | "ok" | "failed";

type AgentBrowserPrereqJobState = {
  status: AgentBrowserPrereqJobStatus;
  pid?: number | null;
  startedAt: string;
  updatedAt: string;
  attemptCount: number;
  logPath: string;
  commands: string[];
  lastErrorSummary?: string;
};

const uiPrereqDir = (repoRoot: string): string => path.join(marioStateDir(repoRoot), "ui-prereq");
const agentBrowserPrereqStatePath = (repoRoot: string): string => path.join(uiPrereqDir(repoRoot), "agent-browser.json");
const agentBrowserPrereqLogPath = (repoRoot: string): string => path.join(uiPrereqDir(repoRoot), "agent-browser.install.log");

const readAgentBrowserPrereqJob = async (repoRoot: string): Promise<AgentBrowserPrereqJobState | null> => {
  const raw = await readTextIfExists(agentBrowserPrereqStatePath(repoRoot));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AgentBrowserPrereqJobState>;
    if (!parsed || typeof parsed !== "object") return null;
    const status = parsed.status;
    if (status !== "installing" && status !== "ok" && status !== "failed") return null;
    const startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : new Date().toISOString();
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : startedAt;
    const attemptCount = Number.isFinite(Number(parsed.attemptCount)) ? Math.max(0, Number(parsed.attemptCount)) : 0;
    return {
      status,
      startedAt,
      updatedAt,
      attemptCount,
      logPath: typeof parsed.logPath === "string" && parsed.logPath.trim().length > 0 ? parsed.logPath : agentBrowserPrereqLogPath(repoRoot),
      commands: Array.isArray(parsed.commands) ? parsed.commands.filter((c) => typeof c === "string" && c.trim().length > 0) : [],
      ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
      ...(typeof parsed.lastErrorSummary === "string" && parsed.lastErrorSummary.trim().length > 0 ? { lastErrorSummary: parsed.lastErrorSummary } : {}),
    };
  } catch {
    return null;
  }
};

const writeAgentBrowserPrereqJob = async (repoRoot: string, state: AgentBrowserPrereqJobState): Promise<void> => {
  await ensureDir(uiPrereqDir(repoRoot));
  await writeTextAtomic(agentBrowserPrereqStatePath(repoRoot), `${JSON.stringify(state, null, 2)}\n`);
};

const isPidAlive = (pid: number | null | undefined): boolean => {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type UiLog = (entry: {
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  extra?: Record<string, unknown>;
  reasonCode?: string;
}) => Promise<void>;

const runShellLogged = async (
  ctx: any,
  command: string,
  log?: UiLog,
  options?: { eventPrefix?: string; reasonCode?: string },
): Promise<LoggedShellResult> => {
  const payload = await runShellCommand(ctx.$, command);
  if (log && payload.exitCode !== 0) {
    await log({
      level: "error",
      event: `${options?.eventPrefix ?? "shell.command"}.failed`,
      message: `Command failed: ${command}`,
      reasonCode: options?.reasonCode,
      extra: payload,
    });
  }
  return payload;
};

const getAgentBrowserVersion = async (ctx: any, log?: UiLog): Promise<string | null> => {
  if (!ctx.$) return null;
  const version = await runShellLogged(ctx, "agent-browser --version", log, {
    eventPrefix: "ui.prereq.version",
    reasonCode: "UI_PREREQ_VERSION_CHECK_FAILED",
  });
  if (version.exitCode !== 0) return null;
  const value = (version.stdout || version.stderr || "").trim();
  return value.length > 0 ? value : null;
};

const waitForUrlReady = async (url: string, timeoutMs: number): Promise<boolean> => {
  const started = Date.now();
  const attempt = async (): Promise<boolean> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url, { method: "GET", signal: ctrl.signal });
      clearTimeout(timer);
      return res.status < 500;
    } catch {
      return false;
    }
  };

  while (Date.now() - started < timeoutMs) {
    if (await attempt()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
};

const startDevServer = (command: string): { pid: number | null; stop: () => Promise<void> } => {
  const isWindows = process.platform === "win32";
  const child = spawn("sh", ["-c", command], {
    stdio: "ignore",
    env: { ...process.env, CI: "1", npm_config_yes: "true" },
    detached: !isWindows,
  });
  if (!isWindows) {
    child.unref();
  }
  const pid = child.pid ?? null;
  const stop = async (): Promise<void> => {
    if (!pid) return;
    const targetPid = isWindows ? pid : -pid;
    try {
      process.kill(targetPid, "SIGTERM");
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      process.kill(targetPid, "SIGKILL");
    } catch {
      // already closed
    }
  };
  return { pid, stop };
};

const getXdgConfigHome = (): string => process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config");

const getGlobalSkillPath = (skillName: string): string => {
  return path.join(getXdgConfigHome(), "opencode", "skill", skillName, "SKILL.md");
};

export const parseEnvValue = (raw: string): string => {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
};

export const parseAgentsEnv = (content: string): { env: Record<string, string>; warnings: string[] } => {
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  const lines = content.split(/\r?\n/);
  const envKeyPattern = /^[A-Z][A-Z0-9_]*$/;
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("```")) {
      continue;
    }
    if (line.startsWith("export ")) {
      const rest = line.slice("export ".length).trim();
      const idx = rest.indexOf("=");
      if (idx === -1) {
        warnings.push(`Line ${i + 1}: ignored malformed export: ${line}`);
        continue;
      }
      const key = rest.slice(0, idx).trim();
      const value = rest.slice(idx + 1);
      if (!key) {
        warnings.push(`Line ${i + 1}: ignored export with empty key: ${line}`);
        continue;
      }
      env[key] = parseEnvValue(value);
      continue;
    }
    const idx = line.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (!envKeyPattern.test(key)) {
      continue;
    }
    env[key] = parseEnvValue(value);
  }
  return { env, warnings };
};

export const upsertAgentsKey = (content: string, key: string, value: string): string => {
  const quoted = `'${value.replace(/'/g, "'\\''")}'`;
  const lines = content.split(/\r?\n/);
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  let replaced = false;
  const out = lines.map((line) => {
    if (re.test(line)) {
      replaced = true;
      return `${key}=${quoted}`;
    }
    return line;
  });
  const nextLine = `${key}=${quoted}`;
  if (replaced) {
    return `${out.join("\n").trimEnd()}\n`;
  }
  return `${content.trimEnd()}\n${nextLine}\n`;
};

export const hasAgentsKey = (content: string, key: string): boolean => {
  const pattern = new RegExp(`^\\s*${key}=`, "m");
  return pattern.test(content);
};

export const isLikelyWebApp = async (repoRoot: string): Promise<boolean> => {
  const pkgRaw = await readTextIfExists(path.join(repoRoot, "package.json"));
  const appPkgRaw = await readTextIfExists(path.join(repoRoot, "app", "package.json"));
  const candidates = [pkgRaw, appPkgRaw].filter((v): v is string => typeof v === "string");
  if (candidates.length === 0) {
    return false;
  }
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(candidate) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps.next || deps.vite || deps["react-scripts"]) {
        return true;
      }
    } catch {
      // Keep checking other package manifests.
    }
  }
  return false;
};

export const hasAgentBrowserSkill = async (repoRoot: string): Promise<boolean> => {
  const localSkill = await readTextIfExists(path.join(repoRoot, ".opencode", "skill", "agent-browser", "SKILL.md"));
  if (localSkill) return true;
  const globalSkill = await readTextIfExists(getGlobalSkillPath("agent-browser"));
  return !!globalSkill;
};

export const hasAgentBrowserCli = async (ctx: any): Promise<boolean> => {
  if (!ctx.$) return false;
  const r = await ctx.$`sh -c "command -v agent-browser"`.quiet().nothrow();
  return r.exitCode === 0;
};

export const hasAgentBrowserRuntime = async (
  ctx: any,
): Promise<{ ok: boolean; note?: string }> => {
  if (!ctx.$) return { ok: false, note: "No shell available." };
  const check = await runShellLogged(ctx, "agent-browser open about:blank", undefined, {
    eventPrefix: "ui.runtime.check",
    reasonCode: "UI_RUNTIME_CHECK_FAILED",
  });
  await runShellLogged(ctx, "agent-browser close", undefined, {
    eventPrefix: "ui.runtime.close",
    reasonCode: "UI_RUNTIME_CLOSE_FAILED",
  });
  if (check.exitCode === 0) {
    return { ok: true };
  }
  const detail = check.stderr.trim() || check.stdout.trim() || "Unknown agent-browser runtime error.";
  return { ok: false, note: detail };
};

const startAgentBrowserPrereqInstallJob = async (opts: {
  repoRoot: string;
  needsCli: boolean;
  needsBrowserRuntime: boolean;
  needsSkill: boolean;
  previousAttemptCount: number;
}): Promise<{ pid: number; logPath: string; commands: string[] }> => {
  const { repoRoot, needsCli, needsBrowserRuntime, needsSkill, previousAttemptCount } = opts;
  const logPath = agentBrowserPrereqLogPath(repoRoot);
  const statePath = agentBrowserPrereqStatePath(repoRoot);
  const commands: string[] = [];
  if (needsCli) commands.push("npm install -g agent-browser");
  if (needsBrowserRuntime) {
    commands.push("CI=1 npm_config_yes=true npx --yes playwright install chromium");
    commands.push("CI=1 npm_config_yes=true npx --yes playwright install");
    commands.push("CI=1 npm_config_yes=true agent-browser install");
  }
  if (needsSkill) commands.push("npx skills add vercel-labs/agent-browser");

  const now = new Date().toISOString();
  await writeAgentBrowserPrereqJob(repoRoot, {
    status: "installing",
    pid: null,
    startedAt: now,
    updatedAt: now,
    attemptCount: Math.max(0, previousAttemptCount) + 1,
    logPath,
    commands,
  });

  const workerScript = String.raw`
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const statePath = process.env.MARIO_UI_PREREQ_STATE_PATH;
const runStatePath = process.env.MARIO_UI_VERIFY_STATE_PATH;
const repoRoot = process.env.MARIO_UI_PREREQ_REPO_ROOT || process.cwd();
const needsCli = process.env.MARIO_UI_NEEDS_CLI === "1";
const needsBrowserRuntime = process.env.MARIO_UI_NEEDS_BROWSER === "1";
const needsSkill = process.env.MARIO_UI_NEEDS_SKILL === "1";

const nowIso = () => new Date().toISOString();

const readJson = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
};

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
};

const updateJob = (patch) => {
  const current = readJson(statePath);
  writeJson(statePath, {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  });
};

const patchUiVerifyState = (patch) => {
  if (!runStatePath) return;
  const current = readJson(runStatePath);
  const next = {
    ...current,
    version: 1,
    uiVerify: {
      ...((current && current.uiVerify) || {}),
      ...patch,
    },
  };
  writeJson(runStatePath, next);
};

const runCommand = (command) => {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: repoRoot,
      shell: true,
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
    child.on("error", () => resolve(1));
  });
};

const fail = (summary) => {
  updateJob({ status: "failed", pid: null, lastErrorSummary: summary });
  process.exit(1);
};

(async () => {
  if (needsCli) {
    const code = await runCommand("npm install -g agent-browser");
    if (code !== 0) {
      fail("npm install -g agent-browser failed");
      return;
    }
  }

  if (needsBrowserRuntime) {
    const browserInstallCommands = [
      "CI=1 npm_config_yes=true npx --yes playwright install chromium",
      "CI=1 npm_config_yes=true npx --yes playwright install",
      "CI=1 npm_config_yes=true agent-browser install",
    ];
    let lastCommand = browserInstallCommands[0];
    let installed = false;
    for (const command of browserInstallCommands) {
      lastCommand = command;
      patchUiVerifyState({
        lastInstallAttemptAt: nowIso(),
        lastInstallCommand: command,
      });
      const code = await runCommand(command);
      if (code === 0) {
        installed = true;
        break;
      }
    }
    if (!installed) {
      patchUiVerifyState({
        lastInstallExitCode: 1,
        lastInstallReasonCode: "UI_PREREQ_BROWSER_INSTALL_FAILED",
        lastInstallNote: "Failed to install browser runtime prerequisites.",
      });
      fail("browser runtime install failed");
      return;
    }

    let version = "";
    try {
      version = execSync("agent-browser --version", {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      }).toString().trim();
    } catch {
      version = "";
    }

    patchUiVerifyState({
      ...(version ? { agentBrowserVersion: version } : {}),
      lastInstallAttemptAt: nowIso(),
      lastInstallExitCode: 0,
      lastInstallReasonCode: "",
      lastInstallNote: "",
      browserInstallOkAt: nowIso(),
    });
  }

  if (needsSkill) {
    const code = await runCommand("npx skills add vercel-labs/agent-browser");
    if (code !== 0) {
      fail("npx skills add vercel-labs/agent-browser failed");
      return;
    }
  }

  updateJob({ status: "ok", pid: null, lastErrorSummary: "" });
  process.exit(0);
})().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
});
`;

  const logFd = openSync(logPath, "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, ["-e", workerScript], {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        MARIO_UI_PREREQ_STATE_PATH: statePath,
        MARIO_UI_VERIFY_STATE_PATH: path.join(marioStateDir(repoRoot), "state.json"),
        MARIO_UI_PREREQ_REPO_ROOT: repoRoot,
        MARIO_UI_NEEDS_CLI: needsCli ? "1" : "0",
        MARIO_UI_NEEDS_BROWSER: needsBrowserRuntime ? "1" : "0",
        MARIO_UI_NEEDS_SKILL: needsSkill ? "1" : "0",
      },
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();

  await writeAgentBrowserPrereqJob(repoRoot, {
    status: "installing",
    pid: child.pid ?? null,
    startedAt: now,
    updatedAt: new Date().toISOString(),
    attemptCount: Math.max(0, previousAttemptCount) + 1,
    logPath,
    commands,
  });

  if (typeof child.pid !== "number" || child.pid <= 0) {
    throw new Error("Failed to start agent-browser prerequisite installer process.");
  }

  return {
    pid: child.pid,
    logPath,
    commands,
  };
};

export type AgentBrowserPrereqStatus = {
  cliOk: boolean;
  skillOk: boolean;
  browserOk: boolean;
  attempted: string[];
  installing: boolean;
  installPid?: number;
  installLogPath?: string;
  note?: string;
};

export const ensureAgentBrowserPrereqs = async (
  ctx: any,
  repoRoot: string,
  log?: UiLog,
): Promise<AgentBrowserPrereqStatus> => {
  const attempted: string[] = [];
  const priorJob = await readAgentBrowserPrereqJob(repoRoot);

  if (!ctx.$) {
    return {
      cliOk: false,
      skillOk: false,
      browserOk: false,
      attempted,
      installing: false,
      note: "No shell available for auto-installing agent-browser prerequisites.",
    };
  }

  const cliOk = await hasAgentBrowserCli(ctx);
  const skillOk = await hasAgentBrowserSkill(repoRoot);
  const version = cliOk ? await getAgentBrowserVersion(ctx, log) : null;
  const cached = await readUiVerifyState(repoRoot);
  const browserOk = Boolean(
    cliOk
    && version
    && cached.lastInstallExitCode === 0
    && cached.browserInstallOkAt
    && cached.agentBrowserVersion === version,
  );

  const allReady = cliOk && skillOk && browserOk;
  if (allReady) {
    if (priorJob && priorJob.status !== "ok") {
      await writeAgentBrowserPrereqJob(repoRoot, {
        ...priorJob,
        status: "ok",
        pid: null,
        updatedAt: new Date().toISOString(),
        lastErrorSummary: "",
      });
    }
    return {
      cliOk,
      skillOk,
      browserOk,
      attempted,
      installing: false,
    };
  }

  if (priorJob?.status === "installing" && isPidAlive(priorJob.pid)) {
    await log?.({
      level: "info",
      event: "ui.prereq.install-job.running",
      message: "Agent-browser prerequisite installer is already running",
      extra: {
        pid: priorJob.pid,
        logPath: priorJob.logPath,
        attemptCount: priorJob.attemptCount,
      },
    });
    return {
      cliOk,
      skillOk,
      browserOk,
      attempted,
      installing: true,
      ...(typeof priorJob.pid === "number" ? { installPid: priorJob.pid } : {}),
      ...(priorJob.logPath ? { installLogPath: priorJob.logPath } : {}),
      note: `Installing agent-browser prerequisites (pid ${priorJob.pid ?? "unknown"}).`,
    };
  }

  if (priorJob?.status === "installing" && !isPidAlive(priorJob.pid)) {
    await writeAgentBrowserPrereqJob(repoRoot, {
      ...priorJob,
      status: "failed",
      pid: null,
      updatedAt: new Date().toISOString(),
      lastErrorSummary: priorJob.lastErrorSummary || "Installer process exited before prerequisites were satisfied.",
    });
  }

  const needsCli = !cliOk;
  const needsBrowserRuntime = !browserOk;
  const needsSkill = !skillOk;
  const planCommands: string[] = [];
  if (needsCli) planCommands.push("npm install -g agent-browser");
  if (needsBrowserRuntime) {
    planCommands.push("CI=1 npm_config_yes=true npx --yes playwright install chromium");
    planCommands.push("CI=1 npm_config_yes=true npx --yes playwright install");
    planCommands.push("CI=1 npm_config_yes=true agent-browser install");
  }
  if (needsSkill) planCommands.push("npx skills add vercel-labs/agent-browser");
  attempted.push(...planCommands);

  const started = await startAgentBrowserPrereqInstallJob({
    repoRoot,
    needsCli,
    needsBrowserRuntime,
    needsSkill,
    previousAttemptCount: priorJob?.attemptCount ?? 0,
  });

  await log?.({
    level: "info",
    event: "ui.prereq.install-job.start",
    message: "Started background installer for agent-browser prerequisites",
    extra: {
      pid: started.pid,
      logPath: started.logPath,
      commands: started.commands,
    },
  });

  return {
    cliOk,
    skillOk,
    browserOk,
    attempted,
    installing: true,
    installPid: started.pid,
    installLogPath: started.logPath,
    note: `Installing agent-browser prerequisites in background (pid ${started.pid}).`,
  };
};

export const runUiVerification = async (opts: {
  ctx: any;
  repoRoot: string;
  taskId: string;
  devCmd: string;
  url: string;
  log?: UiLog;
  waitMs?: number;
}): Promise<UiVerificationResult> => {
  const { ctx, repoRoot, taskId, devCmd, url, log, waitMs } = opts;
  if (!ctx.$) {
    return { ok: false, note: "No shell available for UI verification." };
  }

  const effectiveWait = Number.isFinite(waitMs) ? Math.max(5000, Number(waitMs)) : 60000;
  await log?.({
    level: "info",
    event: "ui.verify.start",
    message: "UI verification started",
    extra: { devCmd, url, waitMs: effectiveWait },
  });

  const summarize = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return trimmed.length > 1200 ? `${trimmed.slice(-1200)}` : trimmed;
  };

  const extractTmpFilePath = (value: string): string | null => {
    const match = value.match(/\/tmp\/[^\s"']+/);
    return match ? match[0] : null;
  };

  const relocateTmpEvidence = async (rawOutput: string, stepName: string): Promise<string> => {
    const tmpPath = extractTmpFilePath(rawOutput);
    if (!tmpPath) return summarize(rawOutput);
    try {
      const fileStat = await stat(tmpPath);
      if (!fileStat.isFile()) return summarize(rawOutput);
      const ext = path.extname(tmpPath) || ".txt";
      const evidenceDir = path.join(repoRoot, ".mario", "state", "ui-evidence", taskId);
      await mkdir(evidenceDir, { recursive: true });
      const targetName = `${stepName}${ext}`;
      const targetAbs = path.join(evidenceDir, targetName);
      await copyFile(tmpPath, targetAbs);
      const rel = path.relative(repoRoot, targetAbs).replace(/\\/g, "/");
      return rel;
    } catch {
      return summarize(rawOutput);
    }
  };

  const evidenceDirAbs = path.join(repoRoot, ".mario", "state", "ui-evidence", taskId);
  const screenshotAbs = path.join(evidenceDirAbs, "screenshot.png");
  const screenshotRel = path.relative(repoRoot, screenshotAbs).replace(/\\/g, "/");

  const steps: Array<{ name: "open" | "snapshot" | "snapshot-interactive" | "screenshot" | "console" | "errors"; command: string; optional?: boolean }> = [
    { name: "open", command: `agent-browser open ${JSON.stringify(url)}` },
    { name: "snapshot", command: "agent-browser snapshot" },
    { name: "snapshot-interactive", command: "agent-browser snapshot -i", optional: true },
    // Optional screenshot; write repo-local path to avoid /tmp permissions.
    { name: "screenshot", command: `agent-browser screenshot ${JSON.stringify(screenshotAbs)}`, optional: true },
    { name: "console", command: "agent-browser console --limit=50" },
    { name: "errors", command: "agent-browser errors" },
  ];

  const evidence: UiVerificationEvidence = {};

  const initialReady = await waitForUrlReady(url, 1500);
  let server: { pid: number | null; stop: () => Promise<void> } | null = null;
  if (!initialReady) {
    server = startDevServer(devCmd);
    await log?.({
      level: "info",
      event: "ui.verify.server.start",
      message: "Started UI dev server for verification",
      extra: { devCmd, pid: server.pid },
    });
    const ready = await waitForUrlReady(url, effectiveWait);
    if (!ready) {
      await log?.({
        level: "error",
        event: "ui.verify.server.timeout",
        message: "UI dev server did not become ready before timeout",
        reasonCode: "UI_VERIFY_SERVER_TIMEOUT",
        extra: { devCmd, url, waitMs: effectiveWait, pid: server.pid },
      });
      await server.stop();
      return { ok: false, note: `UI dev server did not become ready within ${effectiveWait}ms for ${url}.` };
    }
  }

  try {
    for (const step of steps) {
      if (step.name === "screenshot") {
        try {
          await mkdir(evidenceDirAbs, { recursive: true });
        } catch {
          // Best-effort only.
        }
      }
      const result = await runShellLogged(ctx, step.command, log, {
        eventPrefix: `ui.verify.${step.name}`,
        reasonCode: "UI_VERIFY_STEP_FAILED",
      });
      if (result.exitCode !== 0) {
        if (step.optional) {
          await log?.({
            level: "warn",
            event: `ui.verify.${step.name}.optional-failed`,
            message: "Optional UI verification step failed",
            extra: {
              step: step.name,
              exitCode: result.exitCode,
              stderr: summarize(result.stderr),
              stdout: summarize(result.stdout),
            },
          });
          continue;
        }
        const stderr = summarize(result.stderr);
        const stdout = summarize(result.stdout);
        const details = [
          `agent-browser ${step.name} failed (exit ${result.exitCode}).`,
          stderr ? `stderr: ${stderr}` : "",
          stdout ? `stdout: ${stdout}` : "",
        ]
          .filter((x) => x)
          .join(" ");
        await log?.({
          level: "error",
          event: `ui.verify.${step.name}.failed-note`,
          message: "UI verification step failed with actionable output",
          reasonCode: "UI_VERIFY_STEP_FAILED",
          extra: {
            step: step.name,
            exitCode: result.exitCode,
            stderr: result.stderr,
            stdout: result.stdout,
          },
        });
        return { ok: false, note: details };
      }

      if (step.name === "screenshot" && result.exitCode === 0) {
        try {
          const s = await stat(screenshotAbs);
          if (s.isFile() && s.size > 0) {
            evidence.screenshot = screenshotRel;
            continue;
          }
        } catch {
          // fall back to parsing stdout/stderr
        }
      }

      const out = await relocateTmpEvidence(result.stdout || result.stderr, step.name);
      if (step.name === "snapshot" && out) evidence.snapshot = out;
      if (step.name === "snapshot-interactive" && out) evidence.snapshotInteractive = out;
      if (step.name === "screenshot" && out) evidence.screenshot = out;
      if (step.name === "console" && out) evidence.console = out;
      if (step.name === "errors" && out) evidence.errors = out;
    }
    await log?.({
      level: "info",
      event: "ui.verify.success",
      message: "UI verification passed",
    });
    return {
      ok: true,
      ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
    };
  } finally {
    await runShellLogged(ctx, "agent-browser close", log, {
      eventPrefix: "ui.verify.close",
      reasonCode: "UI_VERIFY_CLOSE_FAILED",
    });
    if (server) {
      await server.stop();
      await log?.({
        level: "info",
        event: "ui.verify.server.stop",
        message: "Stopped UI dev server for verification",
        extra: { pid: server.pid },
      });
    }
  }
};
