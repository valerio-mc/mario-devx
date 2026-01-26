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
    "Call tool mario_devx_plan with no arguments. Return a brief summary of where the plan was written.",
  ),
  command(
    "build",
    "Draft next iteration plan (HITL)",
    "Call tool mario_devx_build with idea=\"$ARGUMENTS\". Do not execute the build. Ask the user to review the pending plan and run /mario-devx:approve.",
  ),
  command(
    "approve",
    "Approve and execute pending build",
    "Call tool mario_devx_approve with no arguments. Return the verification result and next action.",
  ),
  command(
    "cancel",
    "Cancel pending build",
    "Call tool mario_devx_cancel with no arguments.",
  ),
  command(
    "verify",
    "Run deterministic + LLM verification",
    "Call tool mario_devx_verify with no arguments.",
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
