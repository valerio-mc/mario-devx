import type { Plugin } from "@opencode-ai/plugin";

export type ToolContext = {
  sessionID?: string;
  agent?: string;
  abort?: AbortSignal;
  metadata?: (input: {
    title?: string;
    metadata?: Record<string, unknown>;
  }) => void;
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
