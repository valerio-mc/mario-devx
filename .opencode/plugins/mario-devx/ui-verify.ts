import path from "path";
import { readTextIfExists, writeText } from "./fs";

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

export const ensureAgentBrowserPrereqs = async (
  ctx: any,
  repoRoot: string,
): Promise<{ cliOk: boolean; skillOk: boolean; attempted: string[] }> => {
  const attempted: string[] = [];
  if (ctx.$) {
    const cli = await hasAgentBrowserCli(ctx);
    if (!cli) {
      attempted.push("npm install -g agent-browser");
      await ctx.$`sh -c "npm install -g agent-browser"`.nothrow();
      attempted.push("agent-browser install");
      await ctx.$`sh -c "agent-browser install"`.nothrow();
    }
    const skill = await hasAgentBrowserSkill(repoRoot);
    if (!skill) {
      attempted.push("npx skills add vercel-labs/agent-browser");
      await ctx.$`sh -c "npx skills add vercel-labs/agent-browser"`.nothrow();
    }
  }
  return {
    cliOk: await hasAgentBrowserCli(ctx),
    skillOk: await hasAgentBrowserSkill(repoRoot),
    attempted,
  };
};

export const runUiVerification = async (opts: {
  ctx: any;
  devCmd: string;
  url: string;
}): Promise<{ ok: boolean; note?: string }> => {
  const { ctx, devCmd, url } = opts;
  if (!ctx.$) {
    return { ok: false, note: "No shell available for UI verification." };
  }

  const cmd = [
    `agent-browser open --cmd=${JSON.stringify(devCmd)} --url=${JSON.stringify(url)} --wait=15000`,
    "agent-browser snapshot",
    "agent-browser console --limit=50",
    "agent-browser errors",
    "agent-browser close",
  ].join(" && ");

  const result = await ctx.$`sh -c ${cmd}`.nothrow();
  if (result.exitCode !== 0) {
    return { ok: false, note: "agent-browser verification failed." };
  }
  return { ok: true };
};

export const ensureAgentsFile = async (repoRoot: string, templateContent: string): Promise<void> => {
  const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
  const existing = await readTextIfExists(agentsPath);
  if (!existing) {
    await writeText(agentsPath, templateContent);
  }
};
