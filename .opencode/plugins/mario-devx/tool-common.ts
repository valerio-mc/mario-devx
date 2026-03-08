import type { PluginInput } from "@opencode-ai/plugin";

export type ToolContext = {
  sessionID?: string;
  agent?: string;
  abort?: AbortSignal;
};

export type PluginContext = PluginInput;

export type ToolEventLogger = (
  ctx: PluginContext,
  repoRoot: string,
  level: "info" | "warn" | "error",
  event: string,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>;
