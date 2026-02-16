import { runShellCommand } from "./shell";

export type AgentBrowserCapabilities = {
  available: boolean;
  version: string | null;
  commands: string[];
  openUsage: string | null;
  notes: string[];
};

const parseCommandsFromHelp = (help: string): string[] => {
  const lines = help.split(/\r?\n/);
  const commands = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("agent-browser ")) continue;
    const cmd = trimmed.replace(/^agent-browser\s+/, "").split(/\s+/)[0]?.trim();
    if (!cmd || cmd.startsWith("--")) continue;
    commands.add(cmd);
  }
  return Array.from(commands).sort();
};

export const discoverAgentBrowserCapabilities = async (ctx: any): Promise<AgentBrowserCapabilities> => {
  if (!ctx.$) {
    return {
      available: false,
      version: null,
      commands: [],
      openUsage: null,
      notes: ["No shell available to probe agent-browser capabilities."],
    };
  }

  const which = await runShellCommand(ctx.$, "command -v agent-browser");
  if (which.exitCode !== 0) {
    return {
      available: false,
      version: null,
      commands: [],
      openUsage: null,
      notes: ["agent-browser CLI not found in PATH."],
    };
  }

  const versionCmd = await runShellCommand(ctx.$, "agent-browser --version");
  const helpCmd = await runShellCommand(ctx.$, "agent-browser --help");
  const openHelpCmd = await runShellCommand(ctx.$, "agent-browser open --help");

  const version = (versionCmd.stdout || versionCmd.stderr || "").trim() || null;
  const commands = parseCommandsFromHelp(helpCmd.stdout || helpCmd.stderr || "");
  const openUsageLine = (openHelpCmd.stdout || openHelpCmd.stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith("usage:")) ?? null;

  const notes: string[] = [];
  if (openUsageLine && !openUsageLine.includes("open <url>")) {
    notes.push(`open usage differs from expected signature: ${openUsageLine}`);
  }

  return {
    available: true,
    version,
    commands,
    openUsage: openUsageLine,
    notes,
  };
};
