import type { Plugin } from "@opencode-ai/plugin";
import { createCommands } from "./commands";
import { createTools } from "./tools";
import { readRunState, readWorkSessionState, writeRunState } from "./state";
import { buildPrompt } from "./prompt";
import { readTextIfExists } from "./fs";
import path from "path";
import { isPrdReadyForPlan } from "./bootstrap";

const marioDevxPlugin: Plugin = async (ctx) => {
  const tools = createTools(ctx);
  const repoRoot = ctx.worktree ?? ctx.directory ?? process.cwd();

  const nowIso = (): string => new Date().toISOString();

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

      // Bootstrap flow: when PRD is complete, automatically start plan.
      if (run.flow === "new" && run.flowNext === "plan" && run.phase === "prd") {
        const prdPath = path.join(repoRoot, ".mario", "PRD.md");
        const prd = await readTextIfExists(prdPath);
        if (!prd || !isPrdReadyForPlan(prd)) {
          return;
        }

        const ws2 = await readWorkSessionState(repoRoot);
        if (!ws2?.sessionId || !ws2.baselineMessageId) {
          return;
        }

        const nextRun = {
          ...run,
          status: "DOING" as const,
          phase: "plan" as const,
          flowNext: undefined,
          startedAt: nowIso(),
          updatedAt: nowIso(),
        };
        await writeRunState(repoRoot, nextRun);

        await ctx.client.session.revert({
          path: { id: ws2.sessionId },
          body: { messageID: ws2.baselineMessageId },
        });
        await ctx.client.session.update({
          path: { id: ws2.sessionId },
          body: { title: "mario-devx (work) - plan" },
        });
        const planPrompt = await buildPrompt(repoRoot, "plan");
        await ctx.client.session.promptAsync({
          path: { id: ws2.sessionId },
          body: {
            parts: [{ type: "text", text: planPrompt }],
          },
        });
        await ctx.client.session.prompt({
          path: { id: run.controlSessionId },
          body: {
            noReply: true,
            parts: [
              {
                type: "text",
                text: `mario-devx: PRD looks complete; started plan in work session ${ws2.sessionId}.`,
              },
            ],
          },
        });
      }
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
