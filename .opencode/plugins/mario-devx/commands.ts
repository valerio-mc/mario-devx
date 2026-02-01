type CommandDefinition = {
  name: string;
  definition: {
    template: string;
    description: string;
    agent?: string;
    model?: string;
    subtask?: boolean;
  };
};

const prefix = "mario-devx";

const command = (
  name: string,
  description: string,
  template: string,
): CommandDefinition => ({
  name: `${prefix}:${name}`,
  definition: {
    template,
    description,
  },
});

export const createCommands = (): CommandDefinition[] => [
  command(
    "new",
    "Bootstrap: init + PRD + plan",
    "Call tool mario_devx_new with idea=\"$ARGUMENTS\". Then follow the instructions in the tool output.",
  ),
  command(
    "run",
    "Run next plan items (build + verify)",
    "Call tool mario_devx_run with max_items=$ARGUMENTS. Return the tool result.",
  ),
  command(
    "ui-verify",
    "Configure UI verification (agent-browser)",
    "Call tool mario_devx_ui_verify with no arguments. Then follow the instructions in the tool output.",
  ),
  command(
    "status",
    "Show mario-devx status",
    "Call tool mario_devx_status with no arguments.",
  ),
  command(
    "doctor",
    "Check mario-devx health",
    "Call tool mario_devx_doctor with no arguments.",
  ),
  command(
    "help",
    "Show mario-devx help",
    "Call tool mario_devx_help with no arguments.",
  ),
];
