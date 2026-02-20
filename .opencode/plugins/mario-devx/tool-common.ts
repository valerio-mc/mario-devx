import type { Plugin } from "@opencode-ai/plugin";

export type ToolContext = {
  sessionID?: string;
  agent?: string;
  abort?: AbortSignal;
};

export type PluginContext = Parameters<Plugin>[0];

export type ToolEventLogger = (
  ctx: PluginContext,
  repoRoot: string,
  level: "info" | "warn" | "error",
  event: string,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>;
