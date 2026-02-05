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
    "Call tool mario_devx_new with idea=\"$ARGUMENTS\". If the result starts with 'PRD interview (', extract the interview question text and generate 3 concise suggested answers that are plausible and specific for this project context. Then ask the question tool (header: 'PRD Interview') with exactly these options in order: (1) suggestion 1 (recommended), (2) suggestion 2, (3) suggestion 3, (4) Show current status, (5) Stop for now. Keep custom input enabled so the user can freely type their own answer. If user chooses 'Show current status', call mario_devx_status and return its output. If user chooses 'Stop for now', return 'PRD interview paused.'. Otherwise, if user typed custom text use that; if user selected one of the 3 suggestions use that selected suggestion text. Call mario_devx_new again with idea=<chosen answer>. Return only the final question/completion text.",
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
