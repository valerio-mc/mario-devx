import path from "path";

export const AGENT_BROWSER_RUNTIME_COMMANDS = [
  "CI=1 npm_config_yes=true npx --yes playwright install chromium",
  "CI=1 npm_config_yes=true npx --yes playwright install",
  "CI=1 npm_config_yes=true agent-browser install",
] as const;

const getXdgConfigHome = (): string => process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config");

export const getGlobalSkillPaths = (skillName: string): string[] => {
  const base = path.join(getXdgConfigHome(), "opencode");
  return [path.join(base, "skills", skillName, "SKILL.md")];
};

export const buildAgentBrowserInstallPlan = (opts: {
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
