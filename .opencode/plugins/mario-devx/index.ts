import type { Plugin } from "@opencode-ai/plugin";
import { createCommands } from "./commands";
import { createTools } from "./tools";
import { readRunState } from "./state";

const getIdleSessionId = (event: unknown): string | null => {
  if (!event || typeof event !== "object") {
    return null;
  }
  const e = event as { type?: unknown; properties?: unknown };
  if (e.type !== "session.idle") {
    return null;
  }
  const props = e.properties as { sessionID?: unknown } | undefined;
  return typeof props?.sessionID === "string" && props.sessionID.length > 0 ? props.sessionID : null;
};

const safePluginLog = async (
  client: { app?: { log?: (args: { body: { service: string; level: "info"; message: string; extra?: Record<string, unknown> } }) => Promise<unknown> } },
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> => {
  try {
    if (client.app?.log) {
      await client.app.log({
        body: {
          service: "mario-devx",
          level: "info",
          message,
          extra,
        },
      });
    }
  } catch {
    // Best-effort logging only.
  }
};

export const marioDevxPlugin: Plugin = async (ctx) => {
  const { client, directory, worktree } = ctx;
  const repoRoot = worktree ?? directory;
  const tools = createTools(ctx);
  const commands = createCommands();

  await safePluginLog(client, "Plugin initialized", {
    directory,
    worktree: repoRoot,
  });

  return {
    tool: tools,
    event: async ({ event }) => {
      // Notify control session when the work session becomes idle.
      const sessionID = getIdleSessionId(event);
      if (!sessionID) {
        return;
      }

      const run = await readRunState(repoRoot);
      if (!run.workSessionId || run.workSessionId !== sessionID) {
        return;
      }
      if (!run.controlSessionId) {
        return;
      }

      if (run.status !== "DOING") {
        return;
      }

      const summary = `mario-devx: work session is idle (${run.phase}${run.currentPI ? ` ${run.currentPI}` : ""}).`;

      await client.session.prompt({
        path: { id: run.controlSessionId },
        body: {
          noReply: true,
          parts: [{ type: "text", text: summary }],
        },
      });
    },
    config: async (config) => {
      config.command = config.command ?? {};
      for (const command of commands) {
        config.command[command.name] = command.definition;
      }
      await safePluginLog(client, "Commands registered", {
        commandCount: commands.length,
      });
      return config;
    },
  };
};

export default marioDevxPlugin;
