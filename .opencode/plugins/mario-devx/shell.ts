import { coerceShellOutput, redactForLog } from "./logging";

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
