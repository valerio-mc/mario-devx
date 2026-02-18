import { tool } from "@opencode-ai/plugin";

import type { ToolContext } from "./tool-common";

export const createRunTool = (opts: {
  executeRun: (args: { max_items?: string }, context: ToolContext) => Promise<string>;
}) => {
  const { executeRun } = opts;

  return {
    mario_devx_run: tool({
      description: "Run next tasks (build + verify, stops on failure)",
      args: {
        max_items: tool.schema.string().optional().describe("Maximum number of tasks to attempt (default: 1)"),
      },
      async execute(args, context: ToolContext) {
        return executeRun(args, context);
      },
    }),
  };
};
