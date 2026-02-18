import { runUiVerification } from "./ui-verify";
import type { GateRunItem } from "./gates";
import type { PrdGatesAttempt, PrdJson, PrdTask, PrdUiAttempt } from "./prd";
import type { RunExecutionContext, RunLogMeta, RunPhaseName } from "./run-types";
import { RUN_EVENT } from "./run-contracts";

export const resolveEffectiveDoneWhen = (prd: PrdJson, task: PrdTask): string[] => {
  const taskPolicyGates = prd.verificationPolicy?.taskGates?.[task.id] ?? [];
  return task.doneWhen.length > 0
    ? task.doneWhen
    : taskPolicyGates.length > 0
      ? taskPolicyGates
      : (prd.verificationPolicy?.globalGates?.length
        ? prd.verificationPolicy.globalGates
        : (prd.qualityGates ?? []));
};

export const toGateCommands = (doneWhen: string[]): Array<{ name: string; command: string }> => {
  return doneWhen.map((command, idx) => ({
    name: `gate-${idx + 1}`,
    command,
  }));
};

export const toGatesAttempt = (result: { ok: boolean; results: GateRunItem[] }): PrdGatesAttempt => ({
  ok: result.ok,
  commands: result.results.map((r) => ({
    command: r.command,
    ok: r.ok,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
  })),
});

export const toUiAttempt = (opts: {
  gateOk: boolean;
  uiResult: { ok: boolean; note?: string } | null;
  uiVerifyEnabled: boolean;
  isWebApp: boolean;
  cliOk: boolean;
  skillOk: boolean;
  browserOk: boolean;
}): PrdUiAttempt => {
  const { gateOk, uiResult, uiVerifyEnabled, isWebApp, cliOk, skillOk, browserOk } = opts;
  return uiResult
    ? { ran: true, ok: uiResult.ok, ...(uiResult.note ? { note: uiResult.note } : {}) }
    : {
        ran: false,
        ok: null,
        note: !gateOk
          ? "UI verification not run because deterministic gates failed."
          : uiVerifyEnabled && isWebApp && (!cliOk || !skillOk || !browserOk)
            ? "UI verification skipped (prerequisites missing)."
            : uiVerifyEnabled && isWebApp
              ? "UI verification not run."
              : "UI verification not configured.",
      };
};

export const logGateRunResults = async (opts: {
  phase: RunPhaseName;
  taskId: string;
  gateResults: GateRunItem[];
  runCtx: RunExecutionContext;
  logRunEvent: (
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    meta?: RunLogMeta,
  ) => Promise<void>;
}): Promise<void> => {
  const { phase, taskId, gateResults, runCtx, logRunEvent } = opts;
  for (const gate of gateResults) {
    await logRunEvent(
      gate.ok ? "info" : "warn",
      gate.ok ? RUN_EVENT.GATE_PASS : RUN_EVENT.GATE_FAIL,
      `${phase} gate ${gate.ok ? "PASS" : "FAIL"}: ${gate.command}`,
      {
        phase,
        taskId,
        command: gate.command,
        exitCode: gate.exitCode,
        durationMs: gate.durationMs,
        ...(gate.ok ? {} : {
          stdout: gate.stdout ?? "",
          stderr: gate.stderr ?? "",
        }),
      },
      { runId: runCtx.runId, taskId },
    );
  }
};

export const runUiVerifyForTask = async (opts: {
  shouldRunUiVerify: boolean;
  taskId: string;
  ctx: any;
  uiVerifyCmd: string;
  uiVerifyUrl: string;
  waitMs: number;
  runCtx: RunExecutionContext;
  logRunEvent: (
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    meta?: RunLogMeta,
  ) => Promise<void>;
}): Promise<{ ok: boolean; note?: string } | null> => {
  const { shouldRunUiVerify, taskId, ctx, uiVerifyCmd, uiVerifyUrl, waitMs, runCtx, logRunEvent } = opts;
  if (!shouldRunUiVerify) {
    return null;
  }
  return runUiVerification({
    ctx,
    devCmd: uiVerifyCmd,
    url: uiVerifyUrl,
    waitMs,
    log: async (entry) => {
      await logRunEvent(
        entry.level,
        entry.event,
        entry.message,
        entry.extra,
        { runId: runCtx.runId, taskId, ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) },
      );
    },
  });
};
