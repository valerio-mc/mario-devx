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
    "Call tool mario_devx_new with idea=\"$ARGUMENTS\". If the result starts with 'PRD interview (', extract the interview question text. If the question is boolean (for example starts with words like 'Does', 'Is', 'Should', 'Can', 'Will' or requests yes/no), ask the question tool (header: 'PRD Interview') with options exactly: 'Yes' and 'No', with custom input enabled. Otherwise ALWAYS provide exactly 3 suggested answers. Suggestions must be direct answer candidates to THAT question only, concrete project content (not process/meta commentary), short and scannable (max 18 words each, single sentence/phrase, no bullet formatting, no semicolon chains, no long enumerations). Never include words like: question, option, recommended, hardcoded, generated, LLM, session, single-choice, multi-choice, free-text. If confidence is low, still provide 3 plausible defaults based on existing PRD context. Ask the question tool (header: 'PRD Interview') with options in order: suggestion 1, suggestion 2, suggestion 3; keep custom input enabled so 'Type your own answer' is available. CRITICAL: after showing the question tool, WAIT for user interaction; do not call mario_devx_new again unless you received a concrete answer from the question tool (selected suggestion label or custom text). If the selected value is exactly 'Type your own answer', treat it as NO answer yet and reply: 'Type your answer in your own words and submit.' If there is no concrete answer yet, return the current interview question text unchanged. Otherwise call mario_devx_new again with idea=<chosen answer>. Return only the final question/completion text.",
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
