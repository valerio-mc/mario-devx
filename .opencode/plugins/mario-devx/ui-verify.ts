import path from "path";
import { spawn } from "child_process";
import { readTextIfExists, writeText } from "./fs";
import { redactForLog } from "./logging";
import { runShellCommand } from "./shell";
import { readUiVerifyState, writeUiVerifyState } from "./state";

export type LoggedShellResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
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

const runPrereqStep = async (
  ctx: any,
  command: string,
  log: UiLog | undefined,
  step: string,
  reasonCode: string,
): Promise<LoggedShellResult> => {
  await log?.({
    level: "info",
    event: `ui.prereq.${step}.start`,
    message: `Starting prerequisite step: ${command}`,
    extra: { command },
  });
  const result = await runShellLogged(ctx, command, log, {
    eventPrefix: `ui.prereq.${step}`,
    reasonCode,
  });
  await log?.({
    level: result.exitCode === 0 ? "info" : "error",
    event: `ui.prereq.${step}.done`,
    message: `Finished prerequisite step: ${command}`,
    ...(result.exitCode !== 0 ? { reasonCode } : {}),
    extra: {
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    },
  });
  return result;
};

const looksInteractivePrompt = (output: string): boolean => {
  const text = output.toLowerCase();
  return (
    text.includes("ok to proceed")
    || text.includes("need to install the following packages")
    || /\(y\/n\)|\by\/n\b/.test(text)
  );
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
  const child = spawn("sh", ["-c", command], {
    stdio: "ignore",
    env: { ...process.env, CI: "1", npm_config_yes: "true" },
  });
  const pid = child.pid ?? null;
  const stop = async (): Promise<void> => {
    if (!pid) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      process.kill(pid, "SIGKILL");
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
  const r = await ctx.$`sh -c "command -v agent-browser"`.nothrow();
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

export const ensureAgentBrowserPrereqs = async (
  ctx: any,
  repoRoot: string,
  log?: UiLog,
): Promise<{ cliOk: boolean; skillOk: boolean; browserOk: boolean; attempted: string[] }> => {
  const attempted: string[] = [];
  let browserInstallExitCode = 0;
  let browserInstallReasonCode = "";
  let browserInstallCommand = "";
  let browserInstallNote = "";
  const getAgentBrowserVersion = async (): Promise<string | null> => {
    if (!ctx.$) return null;
    const version = await runShellLogged(ctx, "agent-browser --version", log, {
      eventPrefix: "ui.prereq.version",
      reasonCode: "UI_PREREQ_VERSION_CHECK_FAILED",
    });
    if (version.exitCode !== 0) return null;
    const value = (version.stdout || version.stderr || "").trim();
    return value.length > 0 ? value : null;
  };

  if (ctx.$) {
    const cli = await hasAgentBrowserCli(ctx);
    if (!cli) {
      attempted.push("npm install -g agent-browser");
      await runPrereqStep(
        ctx,
        "npm install -g agent-browser",
        log,
        "cli-install",
        "UI_PREREQ_CLI_INSTALL_FAILED",
      );
    }

    const version = await getAgentBrowserVersion();
    const cached = await readUiVerifyState(repoRoot);
    const runtimeBefore = await hasAgentBrowserRuntime(ctx);
    const shouldInstallBrowser = !cached.browserInstallOkAt
      || !version
      || cached.agentBrowserVersion !== version
      || !runtimeBefore.ok;
    if (shouldInstallBrowser) {
      const browserInstallCommands = [
        "CI=1 npm_config_yes=true npx --yes playwright install chromium",
        "CI=1 npm_config_yes=true npx --yes playwright install",
        "CI=1 npm_config_yes=true agent-browser install",
      ];
      let installResult: LoggedShellResult | null = null;
      for (const command of browserInstallCommands) {
        attempted.push(command);
        browserInstallCommand = command;
        const result = await runPrereqStep(
          ctx,
          command,
          log,
          "browser-install",
          "UI_PREREQ_BROWSER_INSTALL_FAILED",
        );
        installResult = result;
        if (result.exitCode !== 0) {
          const combinedOutput = `${result.stdout}\n${result.stderr}`;
          if (looksInteractivePrompt(combinedOutput)) {
            browserInstallReasonCode = "INTERACTIVE_PROMPT_BLOCKED";
            browserInstallNote = "Interactive installer prompt detected while bootstrapping browser runtime.";
            await log?.({
              level: "warn",
              event: "ui.prereq.browser-install.interactive-prompt",
              message: "Interactive prompt detected during browser install; continuing with non-interactive fallback",
              reasonCode: "INTERACTIVE_PROMPT_BLOCKED",
              extra: {
                command,
                exitCode: result.exitCode,
              },
            });
          }
        }
        if (result.exitCode === 0) {
          break;
        }
      }
      const finalInstallResult = installResult ?? {
        command: "",
        exitCode: 1,
        stdout: "",
        stderr: "No browser install command was executed.",
        durationMs: 0,
      };
      browserInstallExitCode = finalInstallResult.exitCode;
      if (browserInstallExitCode !== 0 && !browserInstallReasonCode) {
        browserInstallReasonCode = "UI_PREREQ_BROWSER_INSTALL_FAILED";
      }
      const runtimeAfter = await hasAgentBrowserRuntime(ctx);
      if (!runtimeAfter.ok) {
        browserInstallExitCode = browserInstallExitCode === 0 ? 1 : browserInstallExitCode;
        if (!browserInstallReasonCode) {
          browserInstallReasonCode = "UI_PREREQ_RUNTIME_CHECK_FAILED";
        }
        browserInstallNote = runtimeAfter.note ?? browserInstallNote;
      }
      await writeUiVerifyState(repoRoot, {
        ...(version ? { agentBrowserVersion: version } : {}),
        lastInstallAttemptAt: new Date().toISOString(),
        lastInstallExitCode: browserInstallExitCode,
        ...(browserInstallReasonCode ? { lastInstallReasonCode: browserInstallReasonCode } : {}),
        ...(browserInstallCommand ? { lastInstallCommand: browserInstallCommand } : {}),
        ...(browserInstallNote ? { lastInstallNote: browserInstallNote } : {}),
        ...(browserInstallExitCode === 0 ? { browserInstallOkAt: new Date().toISOString() } : {}),
      });
    } else {
      browserInstallExitCode = 0;
      await writeUiVerifyState(repoRoot, {
        ...(version ? { agentBrowserVersion: version } : {}),
        lastInstallExitCode: 0,
        lastInstallReasonCode: "",
        lastInstallCommand: "",
        lastInstallNote: "",
      });
      await log?.({
        level: "info",
        event: "ui.prereq.browser-install.cached",
        message: "Skipped browser install (cached successful install for same agent-browser version)",
        extra: {
          agentBrowserVersion: version,
          browserInstallOkAt: cached.browserInstallOkAt,
        },
      });
    }

    const skill = await hasAgentBrowserSkill(repoRoot);
    if (!skill) {
      attempted.push("npx skills add vercel-labs/agent-browser");
      await runPrereqStep(
        ctx,
        "npx skills add vercel-labs/agent-browser",
        log,
        "skill-install",
        "UI_PREREQ_SKILL_INSTALL_FAILED",
      );
    }
  }
  return {
    cliOk: await hasAgentBrowserCli(ctx),
    skillOk: await hasAgentBrowserSkill(repoRoot),
    browserOk: !!ctx.$ && browserInstallExitCode === 0,
    attempted,
  };
};

export const runUiVerification = async (opts: {
  ctx: any;
  devCmd: string;
  url: string;
  log?: UiLog;
  waitMs?: number;
}): Promise<{ ok: boolean; note?: string }> => {
  const { ctx, devCmd, url, log, waitMs } = opts;
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

  const steps = [
    { name: "open", command: `agent-browser open ${JSON.stringify(url)}` },
    { name: "snapshot", command: "agent-browser snapshot" },
    { name: "console", command: "agent-browser console --limit=50" },
    { name: "errors", command: "agent-browser errors" },
  ];

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
      const result = await runShellLogged(ctx, step.command, log, {
        eventPrefix: `ui.verify.${step.name}`,
        reasonCode: "UI_VERIFY_STEP_FAILED",
      });
      if (result.exitCode !== 0) {
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
    }
    await log?.({
      level: "info",
      event: "ui.verify.success",
      message: "UI verification passed",
    });
    return { ok: true };
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

export const ensureAgentsFile = async (repoRoot: string, templateContent: string): Promise<void> => {
  const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
  const existing = await readTextIfExists(agentsPath);
  if (!existing) {
    await writeText(agentsPath, templateContent);
  }
};
