import { runShellCommand } from "./shell";
import type { LoggedShellResult, UiLog } from "./ui-types";

export const runShellLogged = async (
  ctx: any,
  command: string,
  log?: UiLog,
  options?: { eventPrefix?: string; reasonCode?: string },
): Promise<LoggedShellResult> => {
  const payload = await runShellCommand(ctx.$, command);
  if (log && payload.exitCode !== 0) {
    await log({
      level: "error",
      event: `${options?.eventPrefix ?? "shell.command"}.failed`,
      message: `Command failed: ${command}`,
      reasonCode: options?.reasonCode,
      extra: payload,
    });
  }
  return payload;
};
