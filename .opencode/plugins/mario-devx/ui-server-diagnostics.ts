import path from "path";
import { spawnSync } from "child_process";
import { readFile } from "fs/promises";
import type { UiLog } from "./ui-types";

export type DevServerFailureAnalysis = {
  note: string;
  knownIssue: boolean;
  kind: "next-dev-lock" | "port-in-use" | "generic";
  subtype?: "NEXT_DEV_LOCK_HELD" | "EADDRINUSE";
  lockPathRel?: string;
  lockPid?: number;
  lockCommand?: string;
  portInUse?: number;
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

const stripAnsi = (text: string): string => {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b[@-_]/g, "");
};

const buildLogTailSnippet = (text: string): string => {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const tailLines = lines.slice(-24);
  const tail = tailLines.join(" | ");
  return tail.length > 1000 ? `${tail.slice(0, 1000)}...` : tail;
};

const appendLogTail = (note: string, logTail: string): string => {
  if (!logTail) return note;
  return `${note} Log tail: ${logTail}`;
};

export const analyzeDevServerFailure = async (opts: {
  repoRoot: string;
  logPathAbs: string;
  logPathRel: string;
  fallback: string;
}): Promise<DevServerFailureAnalysis> => {
  const { repoRoot, logPathAbs, logPathRel, fallback } = opts;
  try {
    const text = await readFile(logPathAbs, "utf8");
    const logTail = buildLogTailSnippet(text);
    const lockPath = parseNextDevLockPath(text);
    if (lockPath) {
      const lockPathRel = toRepoRelativePath(repoRoot, lockPath);
      const lockPid = findLockHolderPid(lockPath);
      const lockCommand = typeof lockPid === "number" ? readPidCommand(lockPid) : null;
      const baseNote = lockPid
        ? `UI dev server failed to start: Next dev lock is held at ${lockPathRel} by pid ${lockPid}${lockCommand ? ` (${lockCommand})` : ""}. See ${logPathRel}.`
        : `UI dev server failed to start: Next dev lock is held at ${lockPathRel}. See ${logPathRel}.`;
      const note = appendLogTail(baseNote, logTail);
      return {
        note,
        knownIssue: true,
        kind: "next-dev-lock",
        subtype: "NEXT_DEV_LOCK_HELD",
        lockPathRel,
        ...(typeof lockPid === "number" ? { lockPid } : {}),
        ...(lockCommand ? { lockCommand } : {}),
      };
    }

    const port = parseAddressInUsePort(text);
    if (port) {
      const pid = findListeningPidForPort(port);
      const baseNote = pid
        ? `UI dev server failed to start: port ${port} is already in use by pid ${pid}. See ${logPathRel}.`
        : `UI dev server failed to start: port ${port} is already in use. See ${logPathRel}.`;
      return {
        note: appendLogTail(baseNote, logTail),
        knownIssue: true,
        kind: "port-in-use",
        subtype: "EADDRINUSE",
        portInUse: port,
      };
    }

    return {
      note: appendLogTail(`${fallback} See ${logPathRel}.`, logTail),
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

export const logKnownServerFailure = async (log: UiLog | undefined, analysis: DevServerFailureAnalysis): Promise<void> => {
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
