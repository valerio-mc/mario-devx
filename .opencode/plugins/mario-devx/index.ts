import type { Plugin } from "@opencode-ai/plugin";
import { createCommands } from "./commands";
import { createTools } from "./tools";
import { readRunState, readWorkSessionState } from "./state";
import { getRepoRoot } from "./paths";

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

const marioDevxPlugin: Plugin = async (ctx) => {
  const tools = createTools(ctx);
  const repoRoot = getRepoRoot(ctx);

  return {
    tool: tools,
    event: async ({ event }) => {
      // Notify control session when the work session becomes idle.
      const sessionID = getIdleSessionId(event);
      if (!sessionID) {
        return;
      }

      const ws = await readWorkSessionState(repoRoot);
      if (!ws?.sessionId || ws.sessionId !== sessionID) {
        return;
      }

      const run = await readRunState(repoRoot);
      if (!run.controlSessionId) {
        return;
      }

      if (run.status !== "DOING") {
        return;
      }

      const summary = `mario-devx: work session is idle (${run.phase}${run.currentPI ? ` ${run.currentPI}` : ""}).`;

      await ctx.client.session.prompt({
        path: { id: run.controlSessionId },
        body: {
          noReply: true,
          parts: [{ type: "text", text: summary }],
        },
      });
    },
    config: async (config) => {
      config.command = config.command ?? {};
      for (const command of createCommands()) {
        config.command[command.name] = command.definition;
      }
      return config;
    },
  };
};

export default marioDevxPlugin;
