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
    "Call tool mario_devx_new with idea=\"$ARGUMENTS\". If the result starts with 'PRD interview (', ask the question using the question tool (header: 'PRD Interview') with these options: 'Answer in my own words' (recommended), 'Show current status', 'Stop for now'. Keep custom input enabled. If user chooses 'Show current status', call mario_devx_status and return its output. If user chooses 'Stop for now', return 'PRD interview paused.'. Otherwise, treat the user's custom answer (or selected label text) as the next answer and call mario_devx_new again with idea=<that answer>. Return only the final question/completion text.",
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
