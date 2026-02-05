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
    "Interactive PRD interview (writes .mario/prd.json)",
    "Call tool mario_devx_new with idea=\"$ARGUMENTS\". Return only the interview question or completion result.",
  ),
  command(
    "run",
    "Run next tasks (build + verify)",
    "Call tool mario_devx_run with max_items=$ARGUMENTS. Return the tool result.",
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
];
