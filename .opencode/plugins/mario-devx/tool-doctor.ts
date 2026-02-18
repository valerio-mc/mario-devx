import { tool } from "@opencode-ai/plugin";

import { ensureMario } from "./state";
import { runDoctor } from "./doctor";
import type { PluginContext, ToolEventLogger } from "./tool-common";

export const createDoctorTool = (opts: {
  ctx: PluginContext;
  repoRoot: string;
  logToolEvent: ToolEventLogger;
  redactForLog: (value: string) => string;
}) => {
  const { ctx, repoRoot, logToolEvent, redactForLog } = opts;

  return {
    mario_devx_doctor: tool({
      description: "Check mario-devx health",
      args: {},
      async execute() {
        await ensureMario(repoRoot, false);
        await logToolEvent(ctx, repoRoot, "info", "doctor.start", "Doctor check started");
        const result = await runDoctor(ctx, repoRoot);
        await logToolEvent(ctx, repoRoot, "info", "doctor.complete", "Doctor check completed", {
          resultPreview: redactForLog(result),
        });
        return result;
      },
    }),
  };
};
