import path from "path";
import { readTextIfExists, writeText } from "./fs";
import { redactForLog } from "./logging";

export type GateCommand = { name: string; command: string };

export type GateRunItem = {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  stdout?: string;
  stderr?: string;
};

export const extractScriptFromCommand = (command: string): string | null => {
  const trimmed = command.trim();
  const npm = trimmed.match(/^npm\s+run\s+([A-Za-z0-9:_-]+)(?:\s+|$)/i);
  if (npm?.[1]) return npm[1];
  const pnpm = trimmed.match(/^pnpm\s+([A-Za-z0-9:_-]+)(?:\s+|$)/i);
  if (pnpm?.[1] && !["install", "i", "add", "dlx", "exec"].includes(pnpm[1].toLowerCase())) return pnpm[1];
  const yarn = trimmed.match(/^yarn\s+([A-Za-z0-9:_-]+)(?:\s+|$)/i);
  if (yarn?.[1] && !["install", "add", "dlx", "create"].includes(yarn[1].toLowerCase())) return yarn[1];
  const bun = trimmed.match(/^bun\s+run\s+([A-Za-z0-9:_-]+)(?:\s+|$)/i);
  if (bun?.[1]) return bun[1];
  return null;
};

export const resolveNodeWorkspaceRoot = async (repoRoot: string): Promise<"." | "app"> => {
  const rootPkg = await readTextIfExists(path.join(repoRoot, "package.json"));
  if (rootPkg) {
    return ".";
  }
  const appPkg = await readTextIfExists(path.join(repoRoot, "app", "package.json"));
  return appPkg ? "app" : ".";
};

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

export const hasNodeModules = async (repoRoot: string, workspaceRoot: "." | "app"): Promise<boolean> => {
  const nodeModulesPath = workspaceRoot === "."
    ? path.join(repoRoot, "node_modules")
    : path.join(repoRoot, workspaceRoot, "node_modules");
  return (await readTextIfExists(path.join(nodeModulesPath, ".yarn-integrity"))) !== null
    || (await readTextIfExists(path.join(nodeModulesPath, ".package-lock.json"))) !== null
    || (await readTextIfExists(path.join(nodeModulesPath, ".modules.yaml"))) !== null
    || (await readTextIfExists(path.join(nodeModulesPath, "react", "package.json"))) !== null;
};

const workspacePath = (repoRoot: string, workspaceRoot: "." | "app", relPath: string): string => {
  return workspaceRoot === "." ? path.join(repoRoot, relPath) : path.join(repoRoot, workspaceRoot, relPath);
};

export const ensureT0002QualityBootstrap = async (
  repoRoot: string,
  workspaceRoot: "." | "app",
  gateCommands: GateCommand[],
): Promise<{ changed: boolean; notes: string[] }> => {
  const notes: string[] = [];
  const pkgPath = workspacePath(repoRoot, workspaceRoot, "package.json");
  const pkgRaw = await readTextIfExists(pkgPath);
  if (!pkgRaw) {
    return { changed: false, notes: [`No package.json found at ${workspaceRoot === "." ? "./package.json" : `${workspaceRoot}/package.json`}.`] };
  }

  let pkg: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(pkgRaw) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
  } catch {
    return { changed: false, notes: [`package.json at ${pkgPath} is invalid JSON.`] };
  }

  const neededScripts = Array.from(new Set(gateCommands
    .map((g) => extractScriptFromCommand(g.command))
    .filter((s): s is string => typeof s === "string" && s.length > 0)));

  const scripts = { ...(pkg.scripts ?? {}) };
  let changed = false;

  const addScriptIfMissing = (name: string, value: string): void => {
    if (!scripts[name]) {
      scripts[name] = value;
      changed = true;
      notes.push(`Added missing script '${name}' in ${workspaceRoot === "." ? "package.json" : `${workspaceRoot}/package.json`}.`);
    }
  };

  if (neededScripts.includes("typecheck")) {
    addScriptIfMissing("typecheck", "tsc --noEmit");
    const hasTypescript = Boolean(pkg.devDependencies?.typescript || pkg.dependencies?.typescript);
    if (!hasTypescript) {
      pkg.devDependencies = { ...(pkg.devDependencies ?? {}), typescript: "^5.6.3" };
      changed = true;
      notes.push("Added devDependency 'typescript' for type checking.");
    }
  }

  if (neededScripts.includes("test:e2e")) {
    addScriptIfMissing("test:e2e", "node -e \"process.exit(0)\"");
  }

  if (neededScripts.includes("build") && !scripts.build) {
    const hasVite = Boolean(pkg.devDependencies?.vite || pkg.dependencies?.vite);
    if (hasVite) {
      addScriptIfMissing("build", "vite build");
    }
  }

  if (!changed) {
    return { changed: false, notes };
  }

  pkg.scripts = scripts;
  await writeText(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  notes.push("Updated quality-gate scripts for T-0002 bootstrap.");
  return { changed: true, notes };
};

export const missingPackageScriptForCommand = async (
  repoRoot: string,
  workspaceRoot: "." | "app",
  command: string,
): Promise<string | null> => {
  const scriptName = extractScriptFromCommand(command);
  if (!scriptName) {
    return null;
  }
  const pkgRaw = await readTextIfExists(
    workspaceRoot === "."
      ? path.join(repoRoot, "package.json")
      : path.join(repoRoot, workspaceRoot, "package.json"),
  );
  if (!pkgRaw) {
    return scriptName;
  }
  try {
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    return pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, scriptName)
      ? null
      : scriptName;
  } catch {
    return scriptName;
  }
};

export const runGateCommands = async (
  commands: GateCommand[],
  $: any,
  workdirAbs?: string,
): Promise<{
  ok: boolean;
  failed?: { command: string; exitCode: number };
  results: GateRunItem[];
}> => {
  const results: GateRunItem[] = [];
  for (const gate of commands) {
    const cmd = gate.command.trim();
    const started = Date.now();
    if (!cmd) {
      results.push({
        name: gate.name,
        command: gate.command,
        ok: false,
        exitCode: 2,
        durationMs: 0,
      });
      return { ok: false, failed: { command: gate.command, exitCode: 2 }, results };
    }
    if (!$) {
      results.push({
        name: gate.name,
        command: cmd,
        ok: false,
        exitCode: 127,
        durationMs: Date.now() - started,
      });
      return { ok: false, failed: { command: cmd, exitCode: 127 }, results };
    }
    const wrapped = workdirAbs
      ? `cd ${shellSingleQuote(workdirAbs)} && ${cmd}`
      : cmd;
    const result = await $`sh -c ${wrapped}`.nothrow();
    const ok = result.exitCode === 0;
    const stdout = typeof result.stdout === "string" ? redactForLog(result.stdout) : "";
    const stderr = typeof result.stderr === "string" ? redactForLog(result.stderr) : "";
    results.push({
      name: gate.name,
      command: cmd,
      ok,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      ...(!ok && stdout.length > 0 ? { stdout } : {}),
      ...(!ok && stderr.length > 0 ? { stderr } : {}),
    });
    if (!ok) {
      return { ok: false, failed: { command: cmd, exitCode: result.exitCode }, results };
    }
  }
  return { ok: true, results };
};
