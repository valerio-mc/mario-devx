import type { Plugin } from "@opencode-ai/plugin";
import { createCommands } from "./commands";
import { createTools } from "./tools";
import { readRunState, readWorkSessionState } from "./state";

const marioDevxPlugin: Plugin = async (ctx) => {
  const tools = createTools(ctx);
  const repoRoot = ctx.worktree ?? ctx.directory ?? process.cwd();

  return {
    tool: tools,
    event: async ({ event }) => {
      // Notify control session when the work session becomes idle.
      if ((event as any)?.type !== "session.idle") {
        return;
      }
      const sessionID = (event as any)?.properties?.sessionID as string | undefined;
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

      const summary = [
        `mario-devx: work session is idle (${run.phase}${run.currentPI ? ` ${run.currentPI}` : ""}).`,
        run.runDir ? `Run dir: ${run.runDir}` : "",
        run.status !== "NONE" ? `Run state: ${run.status}` : "",
      ]
        .filter((x) => x)
        .join("\n");

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
