import path from "path";
import { spawn } from "child_process";
import { copyFile, mkdir, stat } from "fs/promises";
import { runShellLogged } from "./ui-shell";
import type { UiLog, UiVerificationEvidence, UiVerificationResult } from "./ui-types";

const waitForUrlReady = async (url: string, timeoutMs: number): Promise<boolean> => {
  const started = Date.now();
  const attempt = async (): Promise<boolean> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url, { method: "GET", signal: ctrl.signal });
      clearTimeout(timer);
      return res.status < 500;
    } catch {
      return false;
    }
  };

  while (Date.now() - started < timeoutMs) {
    if (await attempt()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
};

const startDevServer = (command: string): { pid: number | null; stop: () => Promise<void> } => {
  const isWindows = process.platform === "win32";
  const child = spawn("sh", ["-c", command], {
    stdio: "ignore",
    env: { ...process.env, CI: "1", npm_config_yes: "true" },
    detached: !isWindows,
  });
  if (!isWindows) {
    child.unref();
  }
  const pid = child.pid ?? null;
  const stop = async (): Promise<void> => {
    if (!pid) return;
    const targetPid = isWindows ? pid : -pid;
    try {
      process.kill(targetPid, "SIGTERM");
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      process.kill(targetPid, "SIGKILL");
    } catch {
      // already closed
    }
  };
  return { pid, stop };
};

export const runUiVerification = async (opts: {
  ctx: any;
  repoRoot: string;
  taskId: string;
  devCmd: string;
  url: string;
  log?: UiLog;
  waitMs?: number;
}): Promise<UiVerificationResult> => {
  const { ctx, repoRoot, taskId, devCmd, url, log, waitMs } = opts;
  if (!ctx.$) {
    return { ok: false, note: "No shell available for UI verification." };
  }

  const effectiveWait = Number.isFinite(waitMs) ? Math.max(5000, Number(waitMs)) : 60000;
  await log?.({
    level: "info",
    event: "ui.verify.start",
    message: "UI verification started",
    extra: { devCmd, url, waitMs: effectiveWait },
  });

  const summarize = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return trimmed.length > 1200 ? `${trimmed.slice(-1200)}` : trimmed;
  };

  const extractTmpFilePath = (value: string): string | null => {
    const match = value.match(/\/tmp\/[^\s"']+/);
    return match ? match[0] : null;
  };

  const relocateTmpEvidence = async (rawOutput: string, stepName: string): Promise<string> => {
    const tmpPath = extractTmpFilePath(rawOutput);
    if (!tmpPath) return summarize(rawOutput);
    try {
      const fileStat = await stat(tmpPath);
      if (!fileStat.isFile()) return summarize(rawOutput);
      const ext = path.extname(tmpPath) || ".txt";
      const evidenceDir = path.join(repoRoot, ".mario", "state", "ui-evidence", taskId);
      await mkdir(evidenceDir, { recursive: true });
      const targetName = `${stepName}${ext}`;
      const targetAbs = path.join(evidenceDir, targetName);
      await copyFile(tmpPath, targetAbs);
      const rel = path.relative(repoRoot, targetAbs).replace(/\\/g, "/");
      return rel;
    } catch {
      return summarize(rawOutput);
    }
  };

  const evidenceDirAbs = path.join(repoRoot, ".mario", "state", "ui-evidence", taskId);
  const screenshotAbs = path.join(evidenceDirAbs, "screenshot.png");
  const screenshotRel = path.relative(repoRoot, screenshotAbs).replace(/\\/g, "/");

  const steps: Array<{ name: "open" | "snapshot" | "snapshot-interactive" | "screenshot" | "console" | "errors"; command: string; optional?: boolean }> = [
    { name: "open", command: `agent-browser open ${JSON.stringify(url)}` },
    { name: "snapshot", command: "agent-browser snapshot" },
    { name: "snapshot-interactive", command: "agent-browser snapshot -i", optional: true },
    { name: "screenshot", command: `agent-browser screenshot ${JSON.stringify(screenshotAbs)}`, optional: true },
    { name: "console", command: "agent-browser console --limit=50" },
    { name: "errors", command: "agent-browser errors" },
  ];

  const evidence: UiVerificationEvidence = {};

  const initialReady = await waitForUrlReady(url, 1500);
  let server: { pid: number | null; stop: () => Promise<void> } | null = null;
  if (!initialReady) {
    server = startDevServer(devCmd);
    await log?.({
      level: "info",
      event: "ui.verify.server.start",
      message: "Started UI dev server for verification",
      extra: { devCmd, pid: server.pid },
    });
    const ready = await waitForUrlReady(url, effectiveWait);
    if (!ready) {
      await log?.({
        level: "error",
        event: "ui.verify.server.timeout",
        message: "UI dev server did not become ready before timeout",
        reasonCode: "UI_VERIFY_SERVER_TIMEOUT",
        extra: { devCmd, url, waitMs: effectiveWait, pid: server.pid },
      });
      await server.stop();
      return { ok: false, note: `UI dev server did not become ready within ${effectiveWait}ms for ${url}.` };
    }
  }

  try {
    for (const step of steps) {
      if (step.name === "screenshot") {
        try {
          await mkdir(evidenceDirAbs, { recursive: true });
        } catch {
          // Best-effort only.
        }
      }
      const result = await runShellLogged(ctx, step.command, log, {
        eventPrefix: `ui.verify.${step.name}`,
        reasonCode: "UI_VERIFY_STEP_FAILED",
      });
      if (result.exitCode !== 0) {
        if (step.optional) {
          await log?.({
            level: "warn",
            event: `ui.verify.${step.name}.optional-failed`,
            message: "Optional UI verification step failed",
            extra: {
              step: step.name,
              exitCode: result.exitCode,
              stderr: summarize(result.stderr),
              stdout: summarize(result.stdout),
            },
          });
          continue;
        }
        const stderr = summarize(result.stderr);
        const stdout = summarize(result.stdout);
        const details = [
          `agent-browser ${step.name} failed (exit ${result.exitCode}).`,
          stderr ? `stderr: ${stderr}` : "",
          stdout ? `stdout: ${stdout}` : "",
        ]
          .filter((x) => x)
          .join(" ");
        await log?.({
          level: "error",
          event: `ui.verify.${step.name}.failed-note`,
          message: "UI verification step failed with actionable output",
          reasonCode: "UI_VERIFY_STEP_FAILED",
          extra: {
            step: step.name,
            exitCode: result.exitCode,
            stderr: result.stderr,
            stdout: result.stdout,
          },
        });
        return { ok: false, note: details };
      }

      if (step.name === "screenshot" && result.exitCode === 0) {
        try {
          const s = await stat(screenshotAbs);
          if (s.isFile() && s.size > 0) {
            evidence.screenshot = screenshotRel;
            continue;
          }
        } catch {
          // fall back to parsing stdout/stderr
        }
      }

      const out = await relocateTmpEvidence(result.stdout || result.stderr, step.name);
      if (step.name === "snapshot" && out) evidence.snapshot = out;
      if (step.name === "snapshot-interactive" && out) evidence.snapshotInteractive = out;
      if (step.name === "screenshot" && out) evidence.screenshot = out;
      if (step.name === "console" && out) evidence.console = out;
      if (step.name === "errors" && out) evidence.errors = out;
    }
    await log?.({
      level: "info",
      event: "ui.verify.success",
      message: "UI verification passed",
    });
    return {
      ok: true,
      ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
    };
  } finally {
    await runShellLogged(ctx, "agent-browser close", log, {
      eventPrefix: "ui.verify.close",
      reasonCode: "UI_VERIFY_CLOSE_FAILED",
    });
    if (server) {
      await server.stop();
      await log?.({
        level: "info",
        event: "ui.verify.server.stop",
        message: "Stopped UI dev server for verification",
        extra: { pid: server.pid },
      });
    }
  }
};
