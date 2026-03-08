import { coerceShellOutput, redactForLog } from "./logging";
import type { LoggedShellResult, UiLog } from "./ui-types";

export type ShellCommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export const runShellCommand = async (
  $: any,
  command: string,
): Promise<ShellCommandResult> => {
  const started = Date.now();
  const result = await $`sh -c ${command}`.quiet().nothrow();
  return {
    command,
    exitCode: result.exitCode,
    stdout: redactForLog(coerceShellOutput(result.stdout)),
    stderr: redactForLog(coerceShellOutput(result.stderr)),
    durationMs: Date.now() - started,
  };
};

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
