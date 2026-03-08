import path from "path";
import { readTextIfExists } from "./fs";
import { runShellLogged } from "./ui-shell";
import { getGlobalSkillPaths } from "./ui-prereq-plan";

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
