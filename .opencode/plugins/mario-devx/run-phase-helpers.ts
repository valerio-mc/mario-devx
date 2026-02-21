import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import { runUiVerification, type UiVerificationResult } from "./ui-verify";
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

const SNAPSHOT_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".mario",
  ".opencode",
]);

const shouldIncludeSnapshotFile = (relativePath: string): boolean => {
  if (!relativePath) return false;
  if (relativePath.startsWith("public/")) return true;
  if (relativePath.startsWith("src/")) return true;
  if (relativePath.startsWith("app/")) return true;
  if (/^README\.md$/i.test(relativePath)) return true;
  if (/^(package|pnpm-workspace)\.json$/i.test(relativePath)) return true;
  if (/^(pnpm-lock\.yaml|tsconfig\.json|next\.config\.(js|mjs|ts))$/i.test(relativePath)) return true;
  return false;
};

export type WorkspaceSnapshot = Map<string, string>;

export const captureWorkspaceSnapshot = async (repoRoot: string): Promise<WorkspaceSnapshot> => {
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
      if (!shouldIncludeSnapshotFile(rel)) continue;
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
