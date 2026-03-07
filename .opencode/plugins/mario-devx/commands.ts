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

const buildInteractiveInterviewTemplate = (opts: {
  toolName: "mario_devx_new" | "mario_devx_add";
  toolArg: "idea" | "feature";
  resultPrefix: "PRD interview" | "Feature interview";
  header: "PRD Interview" | "Feature Add";
  includeOptionsBlockHandling: boolean;
  lowConfidenceHint?: string;
  completionLine: string;
}): string => {
  const {
    toolName,
    toolArg,
    resultPrefix,
    header,
    includeOptionsBlockHandling,
    lowConfidenceHint,
    completionLine,
  } = opts;

  const instructions = [
    `Call tool ${toolName} with ${toolArg}="$ARGUMENTS".`,
    `If the result starts with '${resultPrefix}', extract the interview question text${resultPrefix === "Feature interview" ? " (exclude the leading 'Feature interview (x/3)' line when present)" : ""}.`,
  ];

  if (includeOptionsBlockHandling) {
    instructions.push(`If the question contains an 'OPTIONS:' block with '- ' list items, use those exact listed labels (in order) as the question tool options (header: '${header}') and keep custom input enabled.`);
  }

  instructions.push(
    `If${includeOptionsBlockHandling ? " no OPTIONS block is present and" : ""} the question is boolean (for example starts with words like 'Does', 'Is', 'Should', 'Can', 'Will' or requests yes/no), ask the question tool with options exactly: 'Yes' and 'No', with custom input enabled.`,
    "Otherwise ALWAYS provide exactly 3 suggested answers.",
    "Suggestions must be direct answer candidates to THAT question only, concrete project content (not process/meta commentary), short and scannable (max 18 words each, single sentence/phrase, no bullet formatting, no semicolon chains, no long enumerations).",
    "Never include words like: question, option, recommended, hardcoded, generated, LLM, session, single-choice, multi-choice, free-text.",
    ...(lowConfidenceHint ? [lowConfidenceHint] : []),
    `Ask the question tool (header: '${header}') with options in order: suggestion 1, suggestion 2, suggestion 3; keep custom input enabled so 'Type your own answer' is available.`,
    `CRITICAL: after showing the question tool, WAIT for user interaction; do not call ${toolName} again unless you received a concrete answer from the question tool (selected suggestion label or custom text).`,
    "If the selected value is exactly 'Type your own answer', treat it as NO answer yet and reply: 'Type your answer in your own words and submit.'",
    "If there is no concrete answer yet, return the current interview question text unchanged.",
    `Otherwise call ${toolName} again with ${toolArg}=<chosen answer>.`,
    completionLine,
  );

  return instructions.join(" ");
};

export const createCommands = (): CommandDefinition[] => [
  command(
    "new",
    "Interactive PRD interview (writes .mario/prd.json)",
    buildInteractiveInterviewTemplate({
      toolName: "mario_devx_new",
      toolArg: "idea",
      resultPrefix: "PRD interview",
      header: "PRD Interview",
      includeOptionsBlockHandling: true,
      lowConfidenceHint: "If confidence is low, still provide 3 plausible defaults based on existing PRD context.",
      completionLine: "Return only the final question/completion text.",
    }),
  ),
  command(
    "run",
    "Run task iterations (build + verify)",
    "Invoke mario_devx_run exactly once with max_items=$ARGUMENTS. Do not invoke any other tool. Return only the tool output.",
  ),
  command(
    "add",
    "Add a feature request and decompose into tasks",
    buildInteractiveInterviewTemplate({
      toolName: "mario_devx_add",
      toolArg: "feature",
      resultPrefix: "Feature interview",
      header: "Feature Add",
      includeOptionsBlockHandling: false,
      completionLine: "Return only the final tool output.",
    }),
  ),
  command(
    "replan",
    "Rebuild open-task plan from backlog",
    "Call tool mario_devx_replan with no arguments exactly once. Return only the tool output.",
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
