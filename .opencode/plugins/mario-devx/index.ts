import type { Plugin } from "@opencode-ai/plugin";
import { createCommands } from "./commands";
import { createTools } from "./tools";
import { readRunState, readWorkSessionState, writeRunState } from "./state";
import { buildPrompt } from "./prompt";
import { readTextIfExists, writeText } from "./fs";
import path from "path";
import { isFrontendProject, isPrdReadyForPlan } from "./bootstrap";

const planLooksReady = (plan: string): boolean => {
  if (!plan || plan.trim().length === 0) {
    return false;
  }
  if (plan.toLowerCase().includes("<title>")) {
    return false;
  }
  // At least one non-placeholder plan item header.
  const okHeader = /^###\s+PI-\d+\s+-\s+TODO\s+-\s+(?!<title>).+$/im;
  return okHeader.test(plan);
};

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

      // Mark planning complete when the work session goes idle.
      if (run.phase === "plan" && run.status === "DOING") {
        const planPath = path.join(repoRoot, ".mario", "IMPLEMENTATION_PLAN.md");
        const plan = await readTextIfExists(planPath);
        if (plan && planLooksReady(plan)) {
          await writeRunState(repoRoot, {
            ...run,
            status: "DONE" as const,
            updatedAt: nowIso(),
          });
          await ctx.client.session.prompt({
            path: { id: run.controlSessionId },
            body: {
              noReply: true,
              parts: [{ type: "text", text: "mario-devx: planning complete. Next: /mario-devx:run 1" }],
            },
          });
        }
        return;
      }

      // Bootstrap flow: when PRD is complete, automatically start plan.
      if (run.flow === "new" && run.flowNext === "plan" && run.phase === "prd") {
        const prdPath = path.join(repoRoot, ".mario", "PRD.md");
        const prd = await readTextIfExists(prdPath);
        if (!prd || !isPrdReadyForPlan(prd)) {
          return;
        }

        // If the PRD implies a frontend, enable UI verification (best-effort).
        if (isFrontendProject(prd)) {
          const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
          const raw = (await readTextIfExists(agentsPath)) ?? "";
          const lines = raw.split(/\r?\n/);
          const upsert = (key: string, value: string): void => {
            const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
            if (idx === -1) {
              lines.push(`${key}=${value}`);
            } else {
              lines[idx] = `${key}=${value}`;
            }
          };
          upsert("UI_VERIFY", "1");
          upsert("UI_VERIFY_REQUIRED", "0");
          if (!raw.includes("UI_VERIFY_CMD=")) upsert("UI_VERIFY_CMD", "'npm run dev'");
          if (!raw.includes("UI_VERIFY_URL=")) upsert("UI_VERIFY_URL", "'http://localhost:3000'");
          if (!raw.includes("AGENT_BROWSER_REPO=")) upsert("AGENT_BROWSER_REPO", "'https://github.com/vercel-labs/agent-browser'");
          await writeText(agentsPath, lines.join("\n").trimEnd() + "\n");
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
