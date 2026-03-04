import { readdir, readFile, stat } from "fs/promises";
import { spawn } from "child_process";
import path from "path";
import { runUiVerification, type UiVerificationResult } from "./ui-verify";
import { buildPrdGateFailure, findFailedGateRunItem, type GateRunItem } from "./gates";
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

export const toGatesAttempt = (result: { ok: boolean; results: GateRunItem[] }): PrdGatesAttempt => {
  const failed = findFailedGateRunItem(result.results);
  const failure = !result.ok ? buildPrdGateFailure(failed) : null;
  return {
    ok: result.ok,
    commands: result.results.map((r) => ({
      command: r.command,
      ok: r.ok,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
    })),
    ...(failure ? { failure } : {}),
  };
};

export const toUiAttempt = (opts: {
  gateOk: boolean;
  uiResult: UiVerificationResult | null;
  uiVerifyEnabled: boolean;
  isWebApp: boolean;
  cliOk: boolean;
  skillOk: boolean;
  browserOk: boolean;
}): PrdUiAttempt => {
  const { gateOk, uiResult, uiVerifyEnabled, isWebApp, cliOk, skillOk, browserOk } = opts;
  return uiResult
    ? {
        ran: true,
        ok: uiResult.ok,
        ...(uiResult.note ? { note: uiResult.note } : {}),
        ...(uiResult.evidence ? { evidence: uiResult.evidence } : {}),
      }
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
  repoRoot: string;
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
}): Promise<UiVerificationResult | null> => {
  const { shouldRunUiVerify, taskId, ctx, repoRoot, uiVerifyCmd, uiVerifyUrl, waitMs, runCtx, logRunEvent } = opts;
  if (!shouldRunUiVerify) {
    return null;
  }
  return runUiVerification({
    ctx,
    repoRoot,
    taskId,
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

const SNAPSHOT_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".mario",
  ".opencode",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
]);

const SNAPSHOT_EXCLUDED_PREFIXES = [
  ".git/",
  "node_modules/",
  ".next/",
  ".mario/",
  ".opencode/",
  "dist/",
  "build/",
  "coverage/",
  ".turbo/",
  ".cache/",
];

const SNAPSHOT_BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mp3",
  ".mov",
  ".avi",
]);

const shouldTrackSnapshotPath = (relativePath: string): boolean => {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return false;
  if (normalized === "." || normalized === "..") return false;
  for (const prefix of SNAPSHOT_EXCLUDED_PREFIXES) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
      return false;
    }
  }
  const ext = path.extname(normalized).toLowerCase();
  if (SNAPSHOT_BINARY_EXTENSIONS.has(ext)) return false;
  return true;
};

export type WorkspaceSnapshot = Map<string, string>;

const runCommandCapture = async (opts: {
  cwd: string;
  command: string;
  args: string[];
  timeoutMs: number;
}): Promise<{ ok: boolean; stdout: string }> => {
  const { cwd, command, args, timeoutMs } = opts;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, stdout: "" });
    }, Math.max(1000, timeoutMs));
    child.stdout.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
};

const parseGitStatusPath = (line: string): { code: string; file: string } | null => {
  if (line.length < 4) return null;
  const code = line.slice(0, 2);
  const rest = line.slice(3).trim();
  if (!rest) return null;
  const file = rest.includes(" -> ") ? rest.split(" -> ").pop() ?? "" : rest;
  const normalized = file.replace(/^"|"$/g, "").trim();
  if (!normalized) return null;
  return { code, file: normalized };
};

const captureGitWorkspaceSnapshot = async (repoRoot: string): Promise<WorkspaceSnapshot | null> => {
  const inside = await runCommandCapture({
    cwd: repoRoot,
    command: "git",
    args: ["rev-parse", "--is-inside-work-tree"],
    timeoutMs: 4000,
  });
  if (!inside.ok || !/true/i.test(inside.stdout)) {
    return null;
  }

  const status = await runCommandCapture({
    cwd: repoRoot,
    command: "git",
    args: ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=no"],
    timeoutMs: 10000,
  });
  if (!status.ok) return null;

  const snapshot: WorkspaceSnapshot = new Map();
  const lines = status.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  for (const line of lines) {
    const parsed = parseGitStatusPath(line);
    if (!parsed) continue;
    const file = parsed.file.replace(/\\/g, "/");
    if (!shouldTrackSnapshotPath(file)) continue;
    try {
      const fileStat = await stat(path.join(repoRoot, file));
      snapshot.set(file, `${parsed.code}:${fileStat.size}:${Math.round(fileStat.mtimeMs)}`);
    } catch {
      snapshot.set(file, `${parsed.code}:deleted`);
    }
  }
  return snapshot;
};

export const captureWorkspaceSnapshot = async (repoRoot: string): Promise<WorkspaceSnapshot> => {
  const gitSnapshot = await captureGitWorkspaceSnapshot(repoRoot);
  if (gitSnapshot) {
    return gitSnapshot;
  }

  const snapshot: WorkspaceSnapshot = new Map();

  const walk = async (dirAbs: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!shouldTrackSnapshotPath(rel)) continue;
      try {
        const s = await stat(abs);
        snapshot.set(rel, `${s.size}:${Math.round(s.mtimeMs)}`);
      } catch {
        // Best-effort snapshot.
      }
    }
  };

  await walk(repoRoot);
  return snapshot;
};

export const summarizeWorkspaceDelta = (before: WorkspaceSnapshot, after: WorkspaceSnapshot): {
  added: number;
  modified: number;
  deleted: number;
  changed: number;
  sample: string[];
} => {
  let added = 0;
  let modified = 0;
  let deleted = 0;
  const sample: string[] = [];

  for (const [file, sig] of after.entries()) {
    const prev = before.get(file);
    if (!prev) {
      added += 1;
      if (sample.length < 8) sample.push(file);
      continue;
    }
    if (prev !== sig) {
      modified += 1;
      if (sample.length < 8) sample.push(file);
    }
  }
  for (const file of before.keys()) {
    if (!after.has(file)) {
      deleted += 1;
      if (sample.length < 8) sample.push(file);
    }
  }

  return {
    added,
    modified,
    deleted,
    changed: added + modified + deleted,
    sample,
  };
};

type AcceptanceArtifactCheck = {
  missingFiles: string[];
  missingLabels: string[];
};

const extractNavigationLabels = (acceptance: string[]): string[] => {
  const labels: string[] = [];
  for (const line of acceptance) {
    if (!/nav|navigation/i.test(line)) continue;
    const quoted = line.match(/"([^"]+)"/g) ?? [];
    for (const chunk of quoted) {
      const cleaned = chunk.replace(/"/g, "");
      const parts = cleaned.split(",").map((x) => x.trim()).filter(Boolean);
      for (const part of parts) {
        if (part.length > 0) labels.push(part);
      }
    }
  }
  return Array.from(new Set(labels));
};

const slugifyLabel = (label: string): string => {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
};

const readTextOrEmpty = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
};

const resolveAppRouterRoots = async (repoRoot: string): Promise<string[]> => {
  const candidates = ["src/app", "app"];
  const found: string[] = [];
  for (const rel of candidates) {
    try {
      const s = await stat(path.join(repoRoot, rel));
      if (s.isDirectory()) {
        found.push(rel);
      }
    } catch {
      // Ignore missing candidates.
    }
  }
  return found.length > 0 ? found : ["src/app", "app"];
};

export const checkAcceptanceArtifacts = async (repoRoot: string, acceptance: string[]): Promise<AcceptanceArtifactCheck> => {
  const labels = extractNavigationLabels(acceptance);
  if (labels.length === 0) {
    return { missingFiles: [], missingLabels: [] };
  }

  const appRoots = await resolveAppRouterRoots(repoRoot);

  const missingFiles: string[] = [];
  for (const label of labels) {
    const slug = slugifyLabel(label);
    if (!slug) continue;
    const pageCandidates = appRoots.map((root) => `${root}/${slug}/page.tsx`);
    let foundPage = false;
    for (const rel of pageCandidates) {
      try {
        const s = await stat(path.join(repoRoot, rel));
        if (s.isFile()) {
          foundPage = true;
          break;
        }
      } catch {
        // Candidate does not exist.
      }
    }
    if (!foundPage) {
      missingFiles.push(pageCandidates[0]);
    }
  }

  let combined = "";
  for (const root of appRoots) {
    const layoutText = await readTextOrEmpty(path.join(repoRoot, root, "layout.tsx"));
    const homeText = await readTextOrEmpty(path.join(repoRoot, root, "page.tsx"));
    combined = `${combined}\n${layoutText}\n${homeText}`;
  }
  const missingLabels = labels.filter((label) => !new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(combined));

  return {
    missingFiles: Array.from(new Set(missingFiles)),
    missingLabels: Array.from(new Set(missingLabels)),
  };
};
