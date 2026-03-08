import path from "path";
import { readTextIfExists } from "./fs";
import { runShellLogged } from "./shell";
import type { AgentBrowserPrereqStatus, UiLog } from "./ui-types";

const AGENT_BROWSER_RUNTIME_COMMANDS = [
  "CI=1 npm_config_yes=true npx --yes playwright install chromium",
  "CI=1 npm_config_yes=true npx --yes playwright install",
  "CI=1 npm_config_yes=true agent-browser install",
] as const;

const getXdgConfigHome = (): string => process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config");

const getGlobalSkillPaths = (skillName: string): string[] => {
  const base = path.join(getXdgConfigHome(), "opencode");
  return [path.join(base, "skills", skillName, "SKILL.md")];
};

const buildAgentBrowserInstallPlan = (opts: {
  needsCli: boolean;
  needsBrowserRuntime: boolean;
  needsSkill: boolean;
}): string[] => {
  const { needsCli, needsBrowserRuntime, needsSkill } = opts;
  const commands: string[] = [];
  if (needsCli) commands.push("npm install -g agent-browser");
  if (needsBrowserRuntime) commands.push(...AGENT_BROWSER_RUNTIME_COMMANDS);
  if (needsSkill) commands.push("npx skills add vercel-labs/agent-browser");
  return commands;
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
  const localSkill = await readTextIfExists(path.join(repoRoot, ".opencode", "skills", "agent-browser", "SKILL.md"));
  if (localSkill) return true;
  for (const skillPath of getGlobalSkillPaths("agent-browser")) {
    const globalSkill = await readTextIfExists(skillPath);
    if (globalSkill) return true;
  }
  return false;
};

export const hasAgentBrowserCli = async (ctx: any): Promise<boolean> => {
  if (!ctx.$) return false;
  const result = await ctx.$`sh -c "command -v agent-browser"`.quiet().nothrow();
  return result.exitCode === 0;
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
): Promise<AgentBrowserPrereqStatus> => {
  const skillOk = await hasAgentBrowserSkill(repoRoot);
  if (!ctx.$) {
    return {
      cliOk: false,
      skillOk,
      browserOk: false,
      attempted: buildAgentBrowserInstallPlan({
        needsCli: true,
        needsBrowserRuntime: true,
        needsSkill: !skillOk,
      }),
      note: "No shell available. Install agent-browser prerequisites manually and rerun.",
    };
  }

  const cliOk = await hasAgentBrowserCli(ctx);
  const runtime = cliOk
    ? await hasAgentBrowserRuntime(ctx)
    : { ok: false as const, note: "agent-browser CLI is not installed." };
  const browserOk = runtime.ok;
  const attempted = buildAgentBrowserInstallPlan({
    needsCli: !cliOk,
    needsBrowserRuntime: !browserOk,
    needsSkill: !skillOk,
  });

  if (cliOk && skillOk && browserOk) {
    return {
      cliOk,
      skillOk,
      browserOk,
      attempted: [],
    };
  }

  await log?.({
    level: "warn",
    event: "ui.prereq.missing",
    message: "Agent-browser prerequisites missing",
    reasonCode: "UI_PREREQ_MISSING",
    extra: {
      cliOk,
      skillOk,
      browserOk,
      commands: attempted,
      runtimeNote: runtime.note ?? null,
    },
  });

  const noteParts = [
    runtime.note ?? "Agent-browser prerequisites are missing.",
    attempted.length > 0 ? `Install manually: ${attempted.join(" ; ")}` : "",
  ].filter((part) => part && part.trim().length > 0);

  return {
    cliOk,
    skillOk,
    browserOk,
    attempted,
    note: noteParts.join(" "),
  };
};
