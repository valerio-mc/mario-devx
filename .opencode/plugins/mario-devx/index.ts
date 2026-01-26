import type { Plugin } from "@opencode-ai/plugin";
import { createCommands } from "./commands";
import { createTools } from "./tools";

const marioDevxPlugin: Plugin = async (ctx) => {
  const tools = createTools(ctx);

  return {
    tool: tools,
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
