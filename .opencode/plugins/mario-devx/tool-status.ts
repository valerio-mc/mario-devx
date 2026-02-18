import { tool } from "@opencode-ai/plugin";

import { ensureMario, readRunState } from "./state";
import { ensureWorkSession } from "./runner";
import type { PrdJson } from "./prd";
import { getNextPrdTask } from "./planner";
import type { PluginContext, ToolContext, ToolEventLogger } from "./tool-common";

export const createStatusTool = (opts: {
  ctx: PluginContext;
  repoRoot: string;
  ensurePrd: (repoRoot: string) => Promise<PrdJson>;
  logToolEvent: ToolEventLogger;
  notifyControlSession: (ctx: PluginContext, controlSessionId: string | undefined, message: string) => Promise<void>;
}) => {
  const { ctx, repoRoot, ensurePrd, logToolEvent, notifyControlSession } = opts;

  return {
    mario_devx_status: tool({
      description: "Show mario-devx status",
      args: {},
      async execute(_args, context: ToolContext) {
        await ensureMario(repoRoot, false);
        await logToolEvent(ctx, repoRoot, "info", "status.start", "Status requested");
        const ws = await ensureWorkSession(ctx, repoRoot, context.agent);
        const run = await readRunState(repoRoot);
        const prd = await ensurePrd(repoRoot);
        const nextTask = getNextPrdTask(prd);
        const currentTask = run.currentPI ? (prd.tasks ?? []).find((t) => t.id === run.currentPI) : null;
        const focusTask = currentTask ?? nextTask;

        const next =
          run.status === "DOING"
            ? "A run is in progress. Wait for it to finish, then rerun /mario-devx:status."
            : run.status === "BLOCKED"
              ? focusTask?.lastAttempt?.judge
                ? "Fix the listed next actions, then run /mario-devx:run 1."
                : "A task is blocked but has no lastAttempt. Rerun /mario-devx:run 1 to regenerate evidence."
              : prd.wizard.status !== "completed"
                ? "Run /mario-devx:new to finish the PRD wizard."
                : nextTask
                  ? `Run /mario-devx:run 1 to execute ${nextTask.id}.`
                  : "No remaining open tasks.";

        await notifyControlSession(
          ctx,
          context.sessionID,
          `mario-devx status: work session ${ws.sessionId}.`,
        );
        await logToolEvent(ctx, repoRoot, "info", "status.complete", "Status computed", {
          runStatus: run.status,
          currentPI: run.currentPI ?? null,
          focusTaskId: focusTask?.id ?? null,
        });

        return [
          `Iteration: ${run.iteration}`,
          `Work session: ${ws.sessionId}`,
          `Run state: ${run.status} (${run.phase})${run.currentPI ? ` ${run.currentPI}` : ""}`,
          `PRD wizard: ${prd.wizard.status}${prd.wizard.status !== "completed" ? ` (${prd.wizard.step}/${prd.wizard.totalSteps})` : ""}`,
          `Backlog open: ${prd.backlog.featureRequests.filter((f) => f.status === "open").length}`,
          focusTask
            ? `Focus task: ${focusTask.id} (${focusTask.status}) - ${focusTask.title}`
            : "Focus task: (none)",
          focusTask?.lastAttempt?.judge
            ? `Last verdict: ${focusTask.lastAttempt.judge.status} (exit=${focusTask.lastAttempt.judge.exitSignal})`
            : "Last verdict: (none)",
          "",
          `Next: ${next}`,
        ].join("\n");
      },
    }),
  };
};
