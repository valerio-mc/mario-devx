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
    "init",
    "Initialize mario-devx state",
    "Call tool mario_devx_init with no arguments. Return a short confirmation.",
  ),
  command(
    "prd",
    "Start PRD interview",
    "Call tool mario_devx_prd with idea=\"$ARGUMENTS\". Then wait for the user to answer questions.",
  ),
  command(
    "plan",
    "Generate/update implementation plan",
    "Call tool mario_devx_plan with no arguments. Then follow the instructions in the tool output.",
  ),
  command(
    "build",
    "Draft next iteration plan (HITL)",
    "Call tool mario_devx_build with idea=\"$ARGUMENTS\". Do not execute the build. Ask the user to review the pending plan and run /mario-devx:approve.",
  ),
  command(
    "approve",
    "Approve and execute pending build",
    "Call tool mario_devx_approve with no arguments. Then follow the instructions in the tool output.",
  ),
  command(
    "cancel",
    "Cancel pending build",
    "Call tool mario_devx_cancel with no arguments.",
  ),
  command(
    "verify",
    "Run deterministic + LLM verification",
    "Call tool mario_devx_verify with no arguments. Then follow the verifier instructions in the tool output.",
  ),
  command(
    "auto",
    "Run up to N plan items automatically",
    "Call tool mario_devx_auto with max_items=$ARGUMENTS. Return the tool result.",
  ),
  command(
    "status",
    "Show mario-devx status",
    "Call tool mario_devx_status with no arguments.",
  ),
  command(
    "help",
    "Show mario-devx help",
    "Call tool mario_devx_help with no arguments.",
  ),
];
