import { getRepoRoot } from "./paths";
import {
  hasNonEmpty,
} from "./interview";
import {
  setPrdTaskLastAttempt,
  setPrdTaskStatus,
} from "./planner";
import {
  updateRunState,
} from "./runner";
import {
  defaultPrdJson,
  readPrdJsonIfExists,
  writePrdJson,
  type PrdGatesAttempt,
  type PrdJudgeAttempt,
  type PrdJson,
  type PrdTask,
  type PrdTaskAttempt,
  type PrdUiAttempt,
} from "./prd";
import {
  WIZARD_REQUIREMENTS,
} from "./config";
import { logError } from "./errors";
import { logEvent, redactForLog } from "./logging";
import { type RunLogMeta } from "./run-types";
import { runShellCommand } from "./shell";
import { createVerifierPhaseSession, disposeVerifierPhaseSession, runVerifierTurn } from "./verifier-session";
import { buildVerifierTransportFailureJudge, enforceJudgeOutputQuality } from "./run-verifier";
import { RUN_EVENT, RUN_REASON } from "./run-contracts";
import { createStatusTool } from "./tool-status";
import { createDoctorTool } from "./tool-doctor";
import { createBacklogTools } from "./tool-backlog";
import { createNewTool } from "./tool-new";
import { createRunTool } from "./tool-run";
import type { PluginContext } from "./tool-common";
import { firstActionableJudgeReason, isPassEvidenceLine } from "./judge-utils";

const nowIso = (): string => new Date().toISOString();

const repairPlanning = (existing: PrdJson) => ({
  decompositionStrategy: hasNonEmpty(existing.planning?.decompositionStrategy)
    ? existing.planning!.decompositionStrategy
    : "Split features into smallest independently verifiable tasks.",
  granularityRules: Array.isArray(existing.planning?.granularityRules)
    ? existing.planning!.granularityRules
    : ["Each task should fit in one focused iteration.", "Each task must include explicit acceptance criteria."],
  stopWhen: Array.isArray(existing.planning?.stopWhen)
    ? existing.planning!.stopWhen
    : ["All must-have features are mapped to tasks.", "All tasks have deterministic verification."],
});

const repairVerificationPolicy = (existing: PrdJson): PrdJson["verificationPolicy"] => ({
  globalGates: Array.isArray(existing.verificationPolicy?.globalGates)
    ? existing.verificationPolicy!.globalGates
    : (Array.isArray(existing.qualityGates) ? existing.qualityGates : []),
  taskGates: (existing.verificationPolicy?.taskGates && typeof existing.verificationPolicy.taskGates === "object")
    ? existing.verificationPolicy!.taskGates
    : {},
  uiPolicy: existing.verificationPolicy?.uiPolicy === "required"
    ? "required"
    : existing.verificationPolicy?.uiPolicy === "off"
      ? "off"
      : typeof existing.uiVerificationRequired === "boolean"
        ? (existing.uiVerificationRequired ? "required" : "off")
      : "best_effort",
});

const repairUi = (existing: PrdJson): PrdJson["ui"] => ({
  designSystem: existing.ui?.designSystem ?? null,
  styleReferenceMode: existing.ui?.styleReferenceMode === "url"
    ? "url"
    : existing.ui?.styleReferenceMode === "screenshot"
      ? "screenshot"
      : "mixed",
  styleReferences: Array.isArray(existing.ui?.styleReferences) ? existing.ui!.styleReferences : [],
  visualDirection: typeof existing.ui?.visualDirection === "string" ? existing.ui!.visualDirection : "",
  uxRequirements: Array.isArray(existing.ui?.uxRequirements) ? existing.ui!.uxRequirements : [],
});

const repairDocs = (existing: PrdJson) => ({
  readmeRequired: typeof existing.docs?.readmeRequired === "boolean" ? existing.docs!.readmeRequired : true,
  readmeSections: Array.isArray(existing.docs?.readmeSections)
    ? existing.docs!.readmeSections
    : ["Overview", "Tech Stack", "Setup", "Environment Variables", "Scripts", "Usage"],
});

const repairProduct = (existing: PrdJson) => ({
  targetUsers: Array.isArray(existing.product?.targetUsers) ? existing.product!.targetUsers : [],
  userProblems: Array.isArray(existing.product?.userProblems) ? existing.product!.userProblems : [],
  mustHaveFeatures: Array.isArray(existing.product?.mustHaveFeatures) ? existing.product!.mustHaveFeatures : [],
  nonGoals: Array.isArray(existing.product?.nonGoals) ? existing.product!.nonGoals : [],
  successMetrics: Array.isArray(existing.product?.successMetrics) ? existing.product!.successMetrics : [],
  constraints: Array.isArray(existing.product?.constraints) ? existing.product!.constraints : [],
});

const repairTasks = (existing: PrdJson) =>
  Array.isArray(existing.tasks) ? existing.tasks : [];

const ensurePrd = async (repoRoot: string): Promise<PrdJson> => {
  const existing = await readPrdJsonIfExists(repoRoot);
  if (existing) {
    const createdAt = existing.meta?.createdAt?.trim() ? existing.meta.createdAt : nowIso();
    const repaired: PrdJson = {
      ...existing,
      meta: { ...existing.meta, createdAt },
      wizard: {
        ...existing.wizard,
        totalSteps: Math.max(existing.wizard?.totalSteps ?? 0, WIZARD_REQUIREMENTS.TOTAL_STEPS),
      },
      version: 4,
      uiVerificationRequired: typeof existing.uiVerificationRequired === "boolean" ? existing.uiVerificationRequired : null,
      planning: repairPlanning(existing),
      verificationPolicy: repairVerificationPolicy(existing),
      ui: repairUi(existing),
      docs: repairDocs(existing),
      backlog: {
        featureRequests: Array.isArray(existing.backlog?.featureRequests) ? existing.backlog.featureRequests : [],
      },
      tasks: repairTasks(existing),
      product: repairProduct(existing),
    };
    if (JSON.stringify(repaired) !== JSON.stringify(existing)) {
      await writePrdJson(repoRoot, repaired);
      return repaired;
    }
    return existing;
  }
  const created = defaultPrdJson();
  await writePrdJson(repoRoot, created);
  return created;
};

const formatReasonCode = (code: string): string => `ReasonCode: ${code}`;

const isSystemReasonCode = (line: string): boolean => {
  const m = line.match(/^ReasonCode:\s*([A-Z0-9_]+)/i);
  if (!m) return false;
  const code = (m[1] ?? "").toUpperCase();
  return code.startsWith("VERIFIER_TRANSPORT")
    || code.startsWith("RUN_")
    || code.startsWith("HEARTBEAT_")
    || code.startsWith("COMMAND_NOT_FOUND")
    || code.startsWith("MISSING_SCRIPT_");
};

const isMetaCarryForwardLine = (line: string): boolean => {
  const text = String(line ?? "").trim();
  if (!text) return true;
  if (/^ReasonCode:\s*[A-Z0-9_]+/i.test(text)) return true;
  if (/^Last failing gate output \(clipped\):/i.test(text)) return true;
  if (/^Latest failing gate output \(clipped\):/i.test(text)) return true;
  if (/^rubric:/i.test(text)) return true;
  if (isPassEvidenceLine(text)) return true;
  if (/Task evidence indicates/i.test(text)) return true;
  if (/\.mario\/prd\.json/i.test(text) && /status|lastAttempt|ReasonCode|blocked/i.test(text)) return true;
  return false;
};

const normalizeIssueLine = (line: unknown): string => {
  const text = String(line ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s+/, "")
    .trim()
    .replace(/[.\s]+$/, "")
    .toLowerCase();
  return text;
};

const collectCarryForwardIssues = (task: PrdTask): string[] => {
  const attempt = task.lastAttempt;
  if (!attempt || task.status !== "blocked") return [];
  const reasons = (attempt.judge.reason ?? [])
    .map((r) => String(r).trim())
    .filter(Boolean)
    .filter((r) => !isMetaCarryForwardLine(r))
    .filter((r) => !isSystemReasonCode(r));
  const actions = (attempt.judge.nextActions ?? [])
    .map((a) => String(a).trim())
    .filter(Boolean)
    .filter((a) => !isMetaCarryForwardLine(a))
    .filter((a) => !/retry \/mario-devx:run 1/i.test(a));
  const uiNotes = attempt.ui?.note ? [String(attempt.ui.note).trim()] : [];
  return Array.from(new Set([...reasons, ...actions, ...uiNotes])).slice(0, 10);
};

const applyRepeatedFailureBackpressure = (
  previous: PrdTaskAttempt | undefined,
  judge: PrdJudgeAttempt,
): PrdJudgeAttempt => {
  if (!previous || judge.status !== "FAIL") return judge;
  const prev = (previous.judge.reason ?? []).map(normalizeIssueLine).filter(Boolean);
  const curr = (judge.reason ?? []).map(normalizeIssueLine).filter(Boolean);
  if (prev.length === 0 || curr.length === 0) return judge;
  const overlap = curr.filter((c) => prev.includes(c));
  if (overlap.length === 0) return judge;
  const reason = [
    formatReasonCode(RUN_REASON.REPEATED_VERIFIER_FINDINGS),
    ...judge.reason,
  ];
  const nextActions = Array.from(new Set([
    ...(judge.nextActions ?? []),
    "Previous verifier findings are repeating; address those findings explicitly before new changes.",
  ]));
  return { ...judge, reason, nextActions };
};

const parseJudgeAttemptFromText = (text: string): PrdJudgeAttempt | null => {
  const jsonMatch = text.match(/<VERIFIER_JSON>([\s\S]*?)<\/VERIFIER_JSON>/i);
  if (!jsonMatch) {
    return null;
  }
  try {
    const parsed = JSON.parse(jsonMatch[1].trim()) as {
      status?: unknown;
      reason?: unknown;
      nextActions?: unknown;
    };
    const status = parsed.status === "PASS" || parsed.status === "FAIL"
      ? parsed.status
      : null;
    if (!status) {
      return null;
    }
    const reason = Array.isArray(parsed.reason)
      ? parsed.reason.map((line) => String(line).trim()).filter(Boolean)
      : [String(parsed.reason ?? "No reason provided").trim()].filter(Boolean);
    const nextActions = Array.isArray(parsed.nextActions)
      ? parsed.nextActions.map((line) => String(line).trim()).filter(Boolean)
      : [String(parsed.nextActions ?? "Fix issues and rerun /mario-devx:run 1.").trim()].filter(Boolean);
    return {
      status,
      exitSignal: status === "PASS",
      reason: reason.length > 0 ? reason : ["No reason provided"],
      nextActions: nextActions.length > 0 ? nextActions : ["Fix issues and rerun /mario-devx:run 1."],
      rawText: text,
    };
  } catch (err) {
    logError("verifier", `JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
};

const buildVerifierOutputRepairPrompt = (invalidResponse: string): string => {
  return [
    "Your previous verifier output was invalid.",
    "Re-output using ONLY this exact format:",
    "<VERIFIER_JSON>",
    '{"status":"PASS|FAIL","reason":["<reason>"],"nextActions":["<action>"]}',
    "</VERIFIER_JSON>",
    "No markdown. No prose outside the XML block.",
    "Previous invalid output:",
    invalidResponse,
  ].join("\n");
};

const showToast = async (
  ctx: PluginContext,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
): Promise<void> => {
  if (!ctx.client?.tui?.showToast) {
    return;
  }
  try {
    await ctx.client.tui.showToast({
      body: {
        message,
        variant,
      },
    });
  } catch {
    // Best-effort notifications only.
  }
};

const logRunEvent = async (
  ctx: PluginContext,
  repoRoot: string,
  level: "info" | "warn" | "error",
  event: string,
  message: string,
  extra?: Record<string, unknown>,
  runCtx?: RunLogMeta,
): Promise<void> => {
  await logEvent(ctx, repoRoot, {
    level,
    event,
    message,
    ...(runCtx?.runId ? { runId: runCtx.runId } : {}),
    ...(runCtx?.taskId ? { taskId: runCtx.taskId } : {}),
    ...(typeof runCtx?.iteration === "number" ? { iteration: runCtx.iteration } : {}),
    ...(runCtx?.reasonCode ? { reasonCode: runCtx.reasonCode } : {}),
    extra,
  });
};

const logToolEvent = async (
  ctx: PluginContext,
  repoRoot: string,
  level: "info" | "warn" | "error",
  event: string,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> => {
  await logEvent(ctx, repoRoot, {
    level,
    event,
    message,
    extra,
  });
};

const runShellWithFailureLog = async (
  ctx: PluginContext,
  repoRoot: string,
  command: string,
  logMeta: {
    event: string;
    message: string;
    reasonCode?: string;
    runId?: string;
    taskId?: string;
    extra?: Record<string, unknown>;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> => {
  if (!ctx.$) {
    const stderr = "No shell available for command execution.";
    await logRunEvent(
      ctx,
      repoRoot,
      "error",
      logMeta.event,
      logMeta.message,
      {
        command,
        exitCode: 127,
        durationMs: 0,
        stdout: "",
        stderr,
        ...(logMeta.extra ?? {}),
      },
      {
        ...(logMeta.runId ? { runId: logMeta.runId } : {}),
        ...(logMeta.taskId ? { taskId: logMeta.taskId } : {}),
        ...(logMeta.reasonCode ? { reasonCode: logMeta.reasonCode } : {}),
      },
    );
    return { exitCode: 127, stdout: "", stderr, durationMs: 0 };
  }
  const commandResult = await runShellCommand(ctx.$, command);
  const { exitCode, stdout, stderr, durationMs } = commandResult;
  if (exitCode !== 0) {
    await logRunEvent(
      ctx,
      repoRoot,
      "error",
      logMeta.event,
      logMeta.message,
      {
        command,
        exitCode,
        durationMs,
        stdout,
        stderr,
        ...(logMeta.extra ?? {}),
      },
      {
        ...(logMeta.runId ? { runId: logMeta.runId } : {}),
        ...(logMeta.taskId ? { taskId: logMeta.taskId } : {}),
        ...(logMeta.reasonCode ? { reasonCode: logMeta.reasonCode } : {}),
      },
    );
  }
  return { exitCode, stdout, stderr, durationMs };
};

const isLikelyJsonEofError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unexpected eof|unexpected end of json input|json parse error|empty verifier response text/i.test(message);
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const buildCapabilitySummary = (caps: {
  available: boolean;
  version: string | null;
  openUsage: string | null;
  commands: string[];
  notes: string[];
}): string => {
  return [
    `available: ${caps.available ? "yes" : "no"}`,
    `version: ${caps.version ?? "unknown"}`,
    `open usage: ${caps.openUsage ?? "unknown"}`,
    `commands: ${caps.commands.join(", ") || "none"}`,
    ...(caps.notes.length > 0 ? [`notes: ${caps.notes.join("; ")}`] : []),
  ].join("\n");
};

const promptAndResolveWithRetry = async (opts: {
  ctx: PluginContext;
  repoRoot: string;
  promptText: string;
  runId: string;
  taskId: string;
  agent?: string;
  capabilitySummary: string;
}): Promise<string> => {
  const { ctx, repoRoot, promptText, runId, taskId, agent, capabilitySummary } = opts;
  const maxAttempts = 3;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let verifierPhaseSession: { sessionId: string; baselineMessageId: string; baselineFingerprint: string } | null = null;
    try {
      verifierPhaseSession = await createVerifierPhaseSession({
        ctx,
        capabilitySummary,
        ...(agent ? { agent } : {}),
      });
      await updateRunState(repoRoot, {
        verifierSessionId: verifierPhaseSession.sessionId,
      });
      await logRunEvent(ctx, repoRoot, "info", "verifier.phase.create.ok", "Verifier phase session created", {
        verifierSessionId: verifierPhaseSession.sessionId,
        baselineFingerprint: verifierPhaseSession.baselineFingerprint,
        attempt,
      }, { runId, taskId });
      await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.VERIFY_PROMPT_SENT, "Verifier prompt sent", {
        attempt,
        maxAttempts,
        verifierSessionId: verifierPhaseSession.sessionId,
      }, { runId, taskId });
      const verifierText = await runVerifierTurn({
        ctx,
        sessionId: verifierPhaseSession.sessionId,
        promptText,
        ...(agent ? { agent } : {}),
      });
      if (!verifierText.trim()) {
        throw new Error("Empty verifier response text");
      }
      await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.VERIFY_RESPONSE_RECEIVED, "Verifier response received", {
        attempt,
        hasText: true,
      }, { runId, taskId });
      return verifierText;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      await logRunEvent(ctx, repoRoot, "error", "verifier.session.reset.fail", "Verifier session turn failed", {
        attempt,
        error: message,
      }, { runId, taskId, reasonCode: RUN_REASON.VERIFIER_TRANSPORT_ERROR });
      await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.VERIFY_TRANSPORT_ERROR, "Verifier transport/parse error", {
        attempt,
        maxAttempts,
        error: message,
        stack: error instanceof Error ? error.stack ?? "" : "",
      }, { runId, taskId, reasonCode: RUN_REASON.VERIFIER_TRANSPORT_ERROR });
      if (!isLikelyJsonEofError(error) || attempt === maxAttempts) {
        break;
      }
      await sleep(500 * attempt);
    } finally {
      if (verifierPhaseSession?.sessionId) {
        await disposeVerifierPhaseSession(ctx, verifierPhaseSession.sessionId).catch(() => "failed");
      }
      await updateRunState(repoRoot, {
        verifierSessionId: undefined,
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Verifier prompt failed"));
};

const resolveVerifierJudge = async (opts: {
  ctx: PluginContext;
  repoRoot: string;
  verifierPrompt: string;
  runId: string;
  taskId: string;
  capabilitySummary: string;
  agent?: string;
}): Promise<{ judge: PrdJudgeAttempt } | { transportFailure: PrdJudgeAttempt; errorMessage: string }> => {
  const { ctx, repoRoot, verifierPrompt, runId, taskId, capabilitySummary, agent } = opts;
  try {
    const verifierText = await promptAndResolveWithRetry({
      ctx,
      repoRoot,
      promptText: verifierPrompt,
      runId,
      taskId,
      ...(agent ? { agent } : {}),
      capabilitySummary,
    });
    const parsedJudge = parseJudgeAttemptFromText(verifierText);
    if (!parsedJudge) {
      const repairedText = await promptAndResolveWithRetry({
        ctx,
        repoRoot,
        promptText: buildVerifierOutputRepairPrompt(verifierText),
        runId,
        taskId,
        ...(agent ? { agent } : {}),
        capabilitySummary,
      });
      const repairedJudge = parseJudgeAttemptFromText(repairedText);
      if (!repairedJudge) {
        return {
          transportFailure: buildVerifierTransportFailureJudge(
            "VERIFIER_OUTPUT_INVALID_FORMAT",
            "Verifier response did not match <VERIFIER_JSON> format after repair request.",
          ),
          errorMessage: "Verifier output format invalid",
        };
      }
      return { judge: enforceJudgeOutputQuality(repairedJudge) };
    }
    return { judge: enforceJudgeOutputQuality(parsedJudge) };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      transportFailure: buildVerifierTransportFailureJudge(
        "VERIFIER_TRANSPORT_EOF",
        `Verifier transport failed: ${errMsg}`,
      ),
      errorMessage: errMsg,
    };
  }
};

const persistBlockedTaskAttempt = async (opts: {
  ctx: PluginContext;
  repoRoot: string;
  prd: PrdJson;
  task: PrdTask;
  attemptAt: string;
  iteration: number;
  gates: PrdGatesAttempt;
  ui: PrdUiAttempt;
  judge: PrdJudgeAttempt;
  runId: string;
  runStateStatus?: "DOING" | "BLOCKED";
  logAsRunBlocked?: boolean;
}): Promise<PrdJson> => {
  const {
    ctx,
    repoRoot,
    prd,
    task,
    attemptAt,
    iteration,
    gates,
    ui,
    judge,
    runId,
    runStateStatus = "BLOCKED",
    logAsRunBlocked = true,
  } = opts;
  const lastAttempt: PrdTaskAttempt = {
    at: attemptAt,
    iteration,
    gates,
    ui,
    judge,
  };
  let nextPrd = setPrdTaskStatus(prd, task.id, "blocked");
  nextPrd = setPrdTaskLastAttempt(nextPrd, task.id, lastAttempt);
  await writePrdJson(repoRoot, nextPrd);
  await updateRunState(repoRoot, {
    status: runStateStatus,
    phase: "run",
    currentPI: task.id,
  });
  if (logAsRunBlocked) {
    await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_FAIL_EARLY, `Run blocked on ${task.id}`, {
      taskId: task.id,
      reason: judge.reason?.[0] ?? "Unknown failure",
    }, { runId, taskId: task.id, reasonCode: RUN_REASON.TASK_FAIL_EARLY });
  }
  return nextPrd;
};

export const createTools = (ctx: PluginContext) => {
  const repoRoot = getRepoRoot(ctx);

  const statusTool = createStatusTool({
    ctx,
    repoRoot,
    ensurePrd,
    logToolEvent,
  });
  const doctorTool = createDoctorTool({
    ctx,
    repoRoot,
    logToolEvent,
    redactForLog,
  });
  const backlogTools = createBacklogTools({
    ctx,
    repoRoot,
    ensurePrd,
    logToolEvent,
  });
  const runToolEngineDeps = {
    ensurePrd,
    formatReasonCode,
    firstActionableJudgeReason,
    collectCarryForwardIssues,
    applyRepeatedFailureBackpressure,
    resolveVerifierJudge,
    persistBlockedTaskAttempt,
    runShellWithFailureLog,
    buildCapabilitySummary,
  };
  const newTool = createNewTool({
    ctx,
    repoRoot,
    ensurePrd,
    logToolEvent,
  });

  return {
    ...newTool,

    ...createRunTool({
      ctx,
      repoRoot,
      nowIso,
      showToast,
      logRunEvent,
      engine: runToolEngineDeps,
    }),

    ...backlogTools,

    ...statusTool,
    ...doctorTool,

  };
};
