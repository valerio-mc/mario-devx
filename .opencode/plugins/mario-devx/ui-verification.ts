import path from "path";
import { spawn, spawnSync } from "child_process";
import { closeSync, openSync } from "fs";
import { copyFile, mkdir, readFile, stat } from "fs/promises";
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

const buildUrlCandidates = (url: string): string[] => {
  const candidates: string[] = [];
  const push = (value: string) => {
    if (!candidates.includes(value)) {
      candidates.push(value);
    }
  };
  push(url);
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost") {
      const ipv4 = new URL(url);
      ipv4.hostname = "127.0.0.1";
      push(ipv4.toString());
    } else if (parsed.hostname === "127.0.0.1") {
      const local = new URL(url);
      local.hostname = "localhost";
      push(local.toString());
    }
  } catch {
    // Ignore invalid URLs and keep the original value.
  }
  return candidates;
};

const waitForAnyUrlReady = async (urls: string[], timeoutMs: number): Promise<string | null> => {
  for (const candidate of urls) {
    if (await waitForUrlReady(candidate, timeoutMs)) {
      return candidate;
    }
  }
  return null;
};

const isConnectionRefusedOutput = (stderr: string, stdout: string): boolean => {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  return text.includes("err_connection_refused") || text.includes("connection refused");
};

const parseNextDevLockPath = (text: string): string | null => {
  const patterns = [
    /Unable to acquire lock at\s+([^\s,]+)/i,
    /lock at\s+([^\s,]+)\s*,\s*is another instance of next dev running/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    return match[1].trim();
  }
  return null;
};

const parseAddressInUsePort = (text: string): number | null => {
  const patterns = [
    /EADDRINUSE[\s\S]*?:(\d{2,5})/i,
    /address already in use[^\n]*:(\d{2,5})/i,
    /port:\s*(\d{2,5})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const port = Number.parseInt(match[1], 10);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  }
  return null;
};

const toRepoRelativePath = (repoRoot: string, absOrRelPath: string): string => {
  try {
    const normalized = path.resolve(absOrRelPath);
    const rel = path.relative(repoRoot, normalized).replace(/\\/g, "/");
    if (!rel.startsWith("..")) {
      return rel;
    }
  } catch {
    // Ignore and fall through.
  }
  return absOrRelPath.replace(/\\/g, "/");
};

const findLockHolderPid = (lockPath: string): number | null => {
  if (!lockPath || process.platform === "win32") {
    return null;
  }
  try {
    const result = spawnSync("lsof", ["-nP", lockPath, "-Fp"], {
      encoding: "utf8",
    });
    const output = `${result.stdout ?? ""}`;
    const pidLine = output.split(/\r?\n/).find((line) => /^p\d+$/.test(line.trim()));
    if (!pidLine) return null;
    const pid = Number.parseInt(pidLine.trim().slice(1), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const readPidCommand = (pid: number): string | null => {
  if (!Number.isFinite(pid) || pid <= 0 || process.platform === "win32") {
    return null;
  }
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    const text = `${result.stdout ?? ""}`.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
};

const findListeningPidForPort = (port: number): number | null => {
  if (!Number.isFinite(port) || port <= 0 || process.platform === "win32") {
    return null;
  }
  try {
    const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
      encoding: "utf8",
    });
    const output = `${result.stdout ?? ""}`;
    const pidLine = output.split(/\r?\n/).find((line) => /^p\d+$/.test(line.trim()));
    if (!pidLine) return null;
    const pid = Number.parseInt(pidLine.trim().slice(1), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

type DevServerFailureAnalysis = {
  note: string;
  knownIssue: boolean;
  kind: "next-dev-lock" | "port-in-use" | "generic";
  lockPathRel?: string;
  lockPid?: number;
  lockCommand?: string;
  portInUse?: number;
};

const analyzeDevServerFailure = async (opts: {
  repoRoot: string;
  logPathAbs: string;
  logPathRel: string;
  fallback: string;
}): Promise<DevServerFailureAnalysis> => {
  const { repoRoot, logPathAbs, logPathRel, fallback } = opts;
  try {
    const text = await readFile(logPathAbs, "utf8");
    const lockPath = parseNextDevLockPath(text);
    if (lockPath) {
      const lockPathRel = toRepoRelativePath(repoRoot, lockPath);
      const lockPid = findLockHolderPid(lockPath);
      const lockCommand = typeof lockPid === "number" ? readPidCommand(lockPid) : null;
      const note = lockPid
        ? `UI dev server failed to start: Next dev lock is held at ${lockPathRel} by pid ${lockPid}${lockCommand ? ` (${lockCommand})` : ""}. See ${logPathRel}.`
        : `UI dev server failed to start: Next dev lock is held at ${lockPathRel}. See ${logPathRel}.`;
      return {
        note,
        knownIssue: true,
        kind: "next-dev-lock",
        lockPathRel,
        ...(typeof lockPid === "number" ? { lockPid } : {}),
        ...(lockCommand ? { lockCommand } : {}),
      };
    }

    const port = parseAddressInUsePort(text);
    if (port) {
      const pid = findListeningPidForPort(port);
      return {
        note: pid
          ? `UI dev server failed to start: port ${port} is already in use by pid ${pid}. See ${logPathRel}.`
          : `UI dev server failed to start: port ${port} is already in use. See ${logPathRel}.`,
        knownIssue: true,
        kind: "port-in-use",
        portInUse: port,
      };
    }

    return {
      note: `${fallback} See ${logPathRel}.`,
      knownIssue: false,
      kind: "generic",
    };
  } catch {
    return {
      note: `${fallback} See ${logPathRel}.`,
      knownIssue: false,
      kind: "generic",
    };
  }
};

const logKnownServerFailure = async (log: UiLog | undefined, analysis: DevServerFailureAnalysis): Promise<void> => {
  if (!log || !analysis.knownIssue) {
    return;
  }
  if (analysis.kind === "next-dev-lock") {
    await log({
      level: "error",
      event: "ui.verify.server.locked",
      message: "Next dev lock contention detected during UI verification",
      reasonCode: "UI_VERIFY_STEP_FAILED",
      extra: {
        ...(analysis.lockPathRel ? { lockPath: analysis.lockPathRel } : {}),
        ...(typeof analysis.lockPid === "number" ? { lockPid: analysis.lockPid } : {}),
        ...(analysis.lockCommand ? { lockCommand: analysis.lockCommand } : {}),
      },
    });
    return;
  }
  if (analysis.kind === "port-in-use") {
    await log({
      level: "error",
      event: "ui.verify.server.port-in-use",
      message: "Dev server startup failed because listening port is already in use",
      reasonCode: "UI_VERIFY_STEP_FAILED",
      extra: {
        ...(typeof analysis.portInUse === "number" ? { port: analysis.portInUse } : {}),
      },
    });
  }
};

const startDevServer = (opts: {
  command: string;
  cwd: string;
  logPath: string;
}): {
  pid: number | null;
  stop: () => Promise<void>;
  waitForEarlyExit: (timeoutMs: number) => Promise<{ exited: boolean; exitCode: number | null; signal: string | null }>;
} => {
  const { command, cwd, logPath } = opts;
  const isWindows = process.platform === "win32";
  const logFd = openSync(logPath, "a");
  const child = spawn("sh", ["-c", command], {
    cwd,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, CI: "1", npm_config_yes: "true" },
    detached: !isWindows,
  });
  closeSync(logFd);
  if (!isWindows) {
    child.unref();
  }
  const pid = child.pid ?? null;

  const waitForEarlyExit = async (timeoutMs: number): Promise<{ exited: boolean; exitCode: number | null; signal: string | null }> => {
    if (child.exitCode !== null) {
      return {
        exited: true,
        exitCode: child.exitCode,
        signal: child.signalCode ?? null,
      };
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { exited: boolean; exitCode: number | null; signal: string | null }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(result);
      };
      const onExit = (code: number | null, signal: string | null) => {
        finish({
          exited: true,
          exitCode: typeof code === "number" ? code : null,
          signal: signal ?? null,
        });
      };
      const timer = setTimeout(() => {
        finish({ exited: false, exitCode: null, signal: null });
      }, Math.max(0, timeoutMs));
      child.once("exit", onExit);
    });
  };

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
  return { pid, stop, waitForEarlyExit };
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
  const urlCandidates = buildUrlCandidates(url);
  await log?.({
    level: "info",
    event: "ui.verify.start",
    message: "UI verification started",
    extra: { devCmd, url, waitMs: effectiveWait, urlCandidates },
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
  const devServerLogAbs = path.join(evidenceDirAbs, "dev-server.log");
  const devServerLogRel = path.relative(repoRoot, devServerLogAbs).replace(/\\/g, "/");

  const steps: Array<{ name: "snapshot" | "snapshot-interactive" | "screenshot" | "console" | "errors"; command: string; optional?: boolean }> = [
    { name: "snapshot", command: "agent-browser snapshot" },
    { name: "snapshot-interactive", command: "agent-browser snapshot -i", optional: true },
    { name: "screenshot", command: `agent-browser screenshot ${JSON.stringify(screenshotAbs)}`, optional: true },
    { name: "console", command: "agent-browser console --limit=50" },
    { name: "errors", command: "agent-browser errors" },
  ];

  const evidence: UiVerificationEvidence = {};

  const initialReady = await waitForAnyUrlReady(urlCandidates, 1500);
  let server: {
    pid: number | null;
    stop: () => Promise<void>;
    waitForEarlyExit: (timeoutMs: number) => Promise<{ exited: boolean; exitCode: number | null; signal: string | null }>;
  } | null = null;
  let readyUrl: string | null = initialReady;
  if (!initialReady) {
    await mkdir(evidenceDirAbs, { recursive: true });
    server = startDevServer({ command: devCmd, cwd: repoRoot, logPath: devServerLogAbs });
    await log?.({
      level: "info",
      event: "ui.verify.server.start",
      message: "Started UI dev server for verification",
      extra: { devCmd, cwd: repoRoot, pid: server.pid, logPath: devServerLogRel },
    });

    const earlyExit = await server.waitForEarlyExit(1200);
    if (earlyExit.exited) {
      const analysis = await analyzeDevServerFailure({
        repoRoot,
        logPathAbs: devServerLogAbs,
        logPathRel: devServerLogRel,
        fallback: `UI dev server exited early (exit ${earlyExit.exitCode ?? "unknown"}).`,
      });
      await logKnownServerFailure(log, analysis);
      await log?.({
        level: "error",
        event: "ui.verify.server.exit-early",
        message: "UI dev server exited before readiness checks completed",
        reasonCode: "UI_VERIFY_SERVER_START_FAILED",
        extra: {
          devCmd,
          cwd: repoRoot,
          pid: server.pid,
          exitCode: earlyExit.exitCode,
          signal: earlyExit.signal,
          logPath: devServerLogRel,
          note: analysis.note,
        },
      });
      return { ok: false, note: analysis.note };
    }

    readyUrl = await waitForAnyUrlReady(urlCandidates, effectiveWait);
    if (!readyUrl) {
      const analysis = await analyzeDevServerFailure({
        repoRoot,
        logPathAbs: devServerLogAbs,
        logPathRel: devServerLogRel,
        fallback: `UI dev server did not become ready within ${effectiveWait}ms for ${url}.`,
      });
      await logKnownServerFailure(log, analysis);
      await log?.({
        level: "error",
        event: "ui.verify.server.timeout",
        message: "UI dev server did not become ready before timeout",
        reasonCode: "UI_VERIFY_SERVER_TIMEOUT",
        extra: { devCmd, cwd: repoRoot, url, urlCandidates, waitMs: effectiveWait, pid: server.pid, logPath: devServerLogRel, note: analysis.note },
      });
      await server.stop();
      return { ok: false, note: analysis.note };
    }
  }

  try {
    const openCandidates = [readyUrl ?? urlCandidates[0], ...urlCandidates].filter((candidate, index, all) => {
      return Boolean(candidate) && all.indexOf(candidate) === index;
    });
    let opened = false;
    let lastOpenResult: { exitCode: number; stdout: string; stderr: string } | null = null;
    let knownServerIssue: DevServerFailureAnalysis | null = null;
    for (const openUrl of openCandidates) {
      const openResult = await runShellLogged(ctx, `agent-browser open ${JSON.stringify(openUrl)}`, log, {
        eventPrefix: "ui.verify.open",
        reasonCode: "UI_VERIFY_STEP_FAILED",
      });
      if (openResult.exitCode === 0) {
        opened = true;
        break;
      }
      lastOpenResult = openResult;

      if (server) {
        const analysis = await analyzeDevServerFailure({
          repoRoot,
          logPathAbs: devServerLogAbs,
          logPathRel: devServerLogRel,
          fallback: `agent-browser open failed (exit ${openResult.exitCode}).`,
        });
        if (analysis.knownIssue) {
          knownServerIssue = analysis;
          await logKnownServerFailure(log, analysis);
          break;
        }
      }

      if (!isConnectionRefusedOutput(openResult.stderr, openResult.stdout)) {
        break;
      }
      await log?.({
        level: "warn",
        event: "ui.verify.open.retry",
        message: "UI verify open failed with connection refused; trying next URL candidate",
        extra: {
          attemptedUrl: openUrl,
          exitCode: openResult.exitCode,
          stderr: summarize(openResult.stderr),
          stdout: summarize(openResult.stdout),
        },
      });
    }
    if (!opened) {
      const openFailure = lastOpenResult ?? { exitCode: 1, stdout: "", stderr: "Unknown open failure" };
      const details = knownServerIssue
        ? knownServerIssue.note
        : server
          ? (await analyzeDevServerFailure({
              repoRoot,
              logPathAbs: devServerLogAbs,
              logPathRel: devServerLogRel,
              fallback: `agent-browser open failed (exit ${openFailure.exitCode}).`,
            })).note
        : [
            `agent-browser open failed (exit ${openFailure.exitCode}).`,
            openFailure.stderr.trim() ? `stderr: ${summarize(openFailure.stderr)}` : "",
            openFailure.stdout.trim() ? `stdout: ${summarize(openFailure.stdout)}` : "",
          ]
            .filter((x) => x)
            .join(" ");
      await log?.({
        level: "error",
        event: "ui.verify.open.failed-note",
        message: "UI verification step failed with actionable output",
        reasonCode: "UI_VERIFY_STEP_FAILED",
        extra: {
          step: "open",
          exitCode: openFailure.exitCode,
          stderr: openFailure.stderr,
          stdout: openFailure.stdout,
          urlCandidates: openCandidates,
          note: details,
        },
      });
      return { ok: false, note: details };
    }

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
