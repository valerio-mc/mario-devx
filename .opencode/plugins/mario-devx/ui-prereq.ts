import path from "path";
import { spawn } from "child_process";
import { closeSync, openSync } from "fs";
import { ensureDir, readTextIfExists, writeTextAtomic } from "./fs";
import { marioStateDir } from "./paths";
import { runShellLogged } from "./ui-shell";
import type { AgentBrowserPrereqStatus, UiLog } from "./ui-types";

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

const getXdgConfigHome = (): string => process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config");

const getGlobalSkillPaths = (skillName: string): string[] => {
  const base = path.join(getXdgConfigHome(), "opencode");
  return [path.join(base, "skills", skillName, "SKILL.md")];
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
  const localSkillPaths = [
    path.join(repoRoot, ".opencode", "skills", "agent-browser", "SKILL.md"),
  ];
  for (const skillPath of localSkillPaths) {
    const localSkill = await readTextIfExists(skillPath);
    if (localSkill) return true;
  }
  const globalPaths = getGlobalSkillPaths("agent-browser");
  for (const skillPath of globalPaths) {
    const globalSkill = await readTextIfExists(skillPath);
    if (globalSkill) return true;
  }
  return false;
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
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const statePath = process.env.MARIO_UI_PREREQ_STATE_PATH;
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
    let installed = false;
    for (const command of browserInstallCommands) {
      const code = await runCommand(command);
      if (code === 0) {
        installed = true;
        break;
      }
    }
    if (!installed) {
      fail("browser runtime install failed");
      return;
    }
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
  const runtime = cliOk
    ? await hasAgentBrowserRuntime(ctx)
    : { ok: false as const, note: "agent-browser CLI is not installed." };
  const browserOk = runtime.ok;

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

  if (priorJob?.status === "ok" && !browserOk) {
    await writeAgentBrowserPrereqJob(repoRoot, {
      ...priorJob,
      status: "failed",
      pid: null,
      updatedAt: new Date().toISOString(),
      lastErrorSummary: runtime.note || "Browser runtime probe failed after install completed.",
    });
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

  try {
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
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await log?.({
      level: "error",
      event: "ui.prereq.install-job.failed-start",
      message: "Failed to start background installer for agent-browser prerequisites",
      reasonCode: "UI_PREREQ_INSTALL_START_FAILED",
      extra: {
        detail,
        commands: planCommands,
      },
    });
    return {
      cliOk,
      skillOk,
      browserOk,
      attempted,
      installing: false,
      note: runtime.note
        ? `Failed to start background installer: ${detail}. Runtime detail: ${runtime.note}`
        : `Failed to start background installer: ${detail}`,
    };
  }
};
