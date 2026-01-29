import path from "path";
import { readTextIfExists, writeText } from "./fs";
import { GateCommand } from "./types";

type PackageManager = "pnpm" | "bun" | "yarn" | "npm";

const normalizeCommand = (value: string): string => {
  return value.replace(/^`|`$/g, "").trim();
};

const extractBackticked = (line: string): string | null => {
  const match = line.match(/`([^`]+)`/);
  if (!match) {
    return null;
  }
  const cmd = normalizeCommand(match[1] ?? "");
  return cmd.length > 0 ? cmd : null;
};

const extractQualityGates = (prd: string): string[] => {
  const lines = prd.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Quality Gates");
  if (start === -1) {
    return [];
  }
  const commands: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().startsWith("## ")) {
      break;
    }
    if (!line.trim().startsWith("-")) {
      continue;
    }

    // Only accept backticked commands to avoid prose breaking gates.
    // Example: - `npm run lint && npm run build`
    const candidate = extractBackticked(line);
    if (!candidate || candidate.toLowerCase().includes("todo")) {
      continue;
    }
    commands.push(candidate);
  }
  return commands;
};

const parseAgentsCommands = (agents: string): Record<string, string> => {
  const commands: Record<string, string> = {};
  for (const line of agents.split(/\r?\n/)) {
    if (!line.startsWith("CMD_")) {
      continue;
    }
    const [key, value] = line.split("=");
    if (!key || value === undefined) {
      continue;
    }
    const trimmed = normalizeCommand(value);
    if (trimmed) {
      commands[key.trim()] = trimmed;
    }
  }
  return commands;
};

const detectPackageManager = async (repoRoot: string): Promise<PackageManager> => {
  const checks: { file: string; manager: PackageManager }[] = [
    { file: "pnpm-lock.yaml", manager: "pnpm" },
    { file: "bun.lockb", manager: "bun" },
    { file: "bun.lock", manager: "bun" },
    { file: "yarn.lock", manager: "yarn" },
    { file: "package-lock.json", manager: "npm" },
  ];
  for (const check of checks) {
    const exists = await readTextIfExists(path.join(repoRoot, check.file));
    if (exists !== null) {
      return check.manager;
    }
  }
  return "npm";
};

const buildScriptCommand = (manager: PackageManager, script: string): string => {
  if (manager === "npm") {
    return `npm run ${script}`;
  }
  if (manager === "bun") {
    return `bun run ${script}`;
  }
  if (manager === "yarn") {
    return `yarn ${script}`;
  }
  return `pnpm ${script}`;
};

const detectFromPackageJson = async (repoRoot: string): Promise<GateCommand[]> => {
  const pkgRaw = await readTextIfExists(path.join(repoRoot, "package.json"));
  if (!pkgRaw) {
    return [];
  }
  const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const manager = await detectPackageManager(repoRoot);
  const result: GateCommand[] = [];

  if (scripts.lint) {
    result.push({
      name: "lint",
      command: buildScriptCommand(manager, "lint"),
      source: "auto",
    });
  }
  if (scripts.typecheck) {
    result.push({
      name: "typecheck",
      command: buildScriptCommand(manager, "typecheck"),
      source: "auto",
    });
  }
  if (scripts.test) {
    result.push({
      name: "test",
      command: buildScriptCommand(manager, "test"),
      source: "auto",
    });
  }
  if (scripts.build) {
    result.push({
      name: "build",
      command: buildScriptCommand(manager, "build"),
      source: "auto",
    });
  }

  return result;
};

const detectFallback = async (repoRoot: string): Promise<GateCommand[]> => {
  const checks: { file: string; command: GateCommand }[] = [
    { file: "go.mod", command: { name: "test", command: "go test ./...", source: "auto" } },
    { file: "Cargo.toml", command: { name: "test", command: "cargo test", source: "auto" } },
    { file: "pyproject.toml", command: { name: "test", command: "pytest", source: "auto" } },
    { file: "requirements.txt", command: { name: "test", command: "pytest", source: "auto" } },
  ];

  for (const check of checks) {
    if ((await readTextIfExists(path.join(repoRoot, check.file))) !== null) {
      return [check.command];
    }
  }

  return [];
};

export const resolveGateCommands = async (
  repoRoot: string,
  prdPath: string,
  agentsPath: string,
): Promise<GateCommand[]> => {
  const prd = await readTextIfExists(prdPath);
  if (prd) {
    const commands = extractQualityGates(prd).map((command, index) => ({
      name: `gate-${index + 1}`,
      command,
      source: "prd",
    }));
    if (commands.length > 0) {
      return commands;
    }
  }

  const agents = await readTextIfExists(agentsPath);
  if (agents) {
    const parsed = parseAgentsCommands(agents);
    const commands = Object.entries(parsed).map(([key, command]) => ({
      name: key.toLowerCase().replace("cmd_", ""),
      command,
      source: "agents",
    }));
    if (commands.length > 0) {
      return commands;
    }
  }

  const packageCommands = await detectFromPackageJson(repoRoot);
  if (packageCommands.length > 0) {
    return packageCommands;
  }

  return detectFallback(repoRoot);
};

export const persistGateCommands = async (
  agentsPath: string,
  commands: GateCommand[],
): Promise<void> => {
  if (commands.length === 0) {
    return;
  }
  const existing = await readTextIfExists(agentsPath);
  if (!existing) {
    return;
  }

  const replacements: Record<string, string> = {
    CMD_LINT: "",
    CMD_TYPECHECK: "",
    CMD_TEST: "",
    CMD_BUILD: "",
  };

  for (const command of commands) {
    if (command.name.includes("lint")) {
      replacements.CMD_LINT = command.command;
    } else if (command.name.includes("typecheck")) {
      replacements.CMD_TYPECHECK = command.command;
    } else if (command.name.includes("test")) {
      replacements.CMD_TEST = command.command;
    } else if (command.name.includes("build")) {
      replacements.CMD_BUILD = command.command;
    }
  }

  const nextLines = existing.split(/\r?\n/).map((line) => {
    if (!line.startsWith("CMD_")) {
      return line;
    }
    const [key] = line.split("=");
    if (!key) {
      return line;
    }
    const value = replacements[key.trim() as keyof typeof replacements];
    if (value === undefined || value === "") {
      return line;
    }
    return `${key}=${value}`;
  });

  await writeText(agentsPath, nextLines.join("\n"));
};
