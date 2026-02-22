import { discoverAgentBrowserCapabilities } from "./agent-browser-capabilities";
import { TIMEOUTS } from "./config";
import { RUN_EVENT, RUN_REASON } from "./run-contracts";
import { validateTaskGraph, setPrdTaskLastAttempt } from "./planner";
import { writePrdJson, type PrdGatesAttempt, type PrdJudgeAttempt, type PrdJson, type PrdTask, type PrdTaskAttempt, type PrdUiAttempt } from "./prd";
import { resolveNodeWorkspaceRoot } from "./gates";
import { validateRunPrerequisites, syncFrontendAgentsConfig, parseMaxItems, resolveSessionAgents } from "./run-preflight";
import { resolveUiRunSetup } from "./run-ui";
import { bumpIteration, readRunState, writeRunState } from "./state";

type DefaultAgentBrowserCaps = {
  available: boolean;
  version: string | null;
  commands: string[];
  openUsage: string | null;
  notes: string[];
};

export type RunPreflightReady = {
  blocked: false;
  prd: PrdJson;
  workspaceRoot: "." | "app";
  workspaceAbs: string;
  maxItems: number;
  uiSetup: Awaited<ReturnType<typeof resolveUiRunSetup>>;
  sessionAgents: Awaited<ReturnType<typeof resolveSessionAgents>>;
  agentBrowserCaps: DefaultAgentBrowserCaps;
  runStartIteration: number;
};

export type RunPreflightBlocked = {
  blocked: true;
  prd: PrdJson;
  message: string;
};

export const runPreflightStep = async (opts: {
  ctx: any;
  repoRoot: string;
  args: { max_items?: string };
  controlSessionId?: string;
  runId: string;
  nowIso: () => string;
  ensurePrd: (repoRoot: string) => Promise<PrdJson>;
  formatReasonCode: (code: string) => string;
  persistBlockedTaskAttempt: (opts: {
    ctx: any;
    repoRoot: string;
    prd: PrdJson;
    task: PrdTask;
    attemptAt: string;
    iteration: number;
    gates: PrdGatesAttempt;
    ui: PrdUiAttempt;
    judge: PrdJudgeAttempt;
    runId: string;
  }) => Promise<PrdJson>;
  showToast: (ctx: any, message: string, variant?: "info" | "success" | "warning" | "error") => Promise<void>;
  logRunEvent: (
    ctx: any,
    repoRoot: string,
    level: "info" | "warn" | "error",
    event: string,
    message: string,
    extra?: Record<string, unknown>,
    runCtx?: { runId?: string; taskId?: string; reasonCode?: string },
  ) => Promise<void>;
  buildCapabilitySummary: (caps: {
    available: boolean;
    version: string | null;
    openUsage: string | null;
    commands: string[];
    notes: string[];
  }) => string;
}): Promise<RunPreflightReady | RunPreflightBlocked> => {
  const {
    ctx,
    repoRoot,
    args,
    controlSessionId,
    runId,
    nowIso,
    ensurePrd,
    formatReasonCode,
    persistBlockedTaskAttempt,
    showToast,
    logRunEvent,
  } = opts;

  let prd = await ensurePrd(repoRoot);
  const workspaceRoot = await resolveNodeWorkspaceRoot(repoRoot);
  const workspaceAbs = workspaceRoot === "." ? repoRoot : `${repoRoot}/${workspaceRoot}`;
  const prerequisites = validateRunPrerequisites(prd);
  if (!prerequisites.ok) {
    const event = prerequisites.reasonCode === RUN_REASON.PRD_INCOMPLETE
      ? RUN_EVENT.BLOCKED_PRD_INCOMPLETE
      : prerequisites.reasonCode === RUN_REASON.NO_TASKS
        ? RUN_EVENT.BLOCKED_NO_TASKS
        : RUN_EVENT.BLOCKED_NO_QUALITY_GATES;
    await logRunEvent(ctx, repoRoot, "warn", event, "Run blocked during preflight validation", {
      ...(prerequisites.extra ?? {}),
    }, { runId, ...(prerequisites.reasonCode ? { reasonCode: prerequisites.reasonCode } : {}) });
    await showToast(ctx, "Run blocked during preflight", "warning");
    return { blocked: true, prd, message: prerequisites.message ?? "Run blocked during preflight validation." };
  }

  const inProgress = (prd.tasks ?? []).filter((t) => t.status === "in_progress");
  if (inProgress.length > 1) {
    const focus = inProgress[0];
    const ids = new Set(inProgress.map((t) => t.id));
    const state = await bumpIteration(repoRoot);
    const attemptAt = nowIso();
    const gates: PrdGatesAttempt = { ok: false, commands: [] };
    const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
    const judge: PrdJudgeAttempt = {
      status: "FAIL",
      exitSignal: false,
      reason: [
        `Invalid task state: multiple tasks are in_progress (${inProgress.map((t) => t.id).join(", ")}).`,
      ],
      nextActions: [
        "Edit .mario/prd.json so at most one task is in_progress (set the others to open/blocked/cancelled).",
        "Then rerun /mario-devx:run 1.",
      ],
    };
    const lastAttempt: PrdTaskAttempt = {
      at: attemptAt,
      iteration: state.iteration,
      gates,
      ui,
      judge,
    };
    prd = {
      ...prd,
      tasks: (prd.tasks ?? []).map((t) => (ids.has(t.id) ? { ...t, status: "blocked" as const } : t)),
    };
    for (const t of inProgress) {
      prd = setPrdTaskLastAttempt(prd, t.id, lastAttempt);
    }
    await writePrdJson(repoRoot, prd);
    await writeRunState(repoRoot, {
      iteration: state.iteration,
      status: "BLOCKED",
      phase: "run",
      ...(focus?.id ? { currentPI: focus.id } : {}),
      ...(controlSessionId ? { controlSessionId } : {}),
      updatedAt: nowIso(),
    });
    await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_INVALID_TASK_STATE, "Run blocked: invalid in_progress task state", {
      inProgressTaskIds: inProgress.map((t) => t.id),
    }, { runId, reasonCode: RUN_REASON.INVALID_TASK_STATE });
    return {
      blocked: true,
      prd,
      message: judge.reason.concat(["", "See tasks[].lastAttempt.judge.nextActions in .mario/prd.json."]).join("\n"),
    };
  }

  const taskGraphIssue = validateTaskGraph(prd);
  if (taskGraphIssue) {
    const focusTask = (prd.tasks ?? []).find((t) => t.id === taskGraphIssue.taskId) ?? (prd.tasks ?? [])[0];
    if (focusTask) {
      const state = await bumpIteration(repoRoot);
      const attemptAt = nowIso();
      const gates: PrdGatesAttempt = { ok: false, commands: [] };
      const ui: PrdUiAttempt = { ran: false, ok: null, note: "UI verification not run." };
      const judge: PrdJudgeAttempt = {
        status: "FAIL",
        exitSignal: false,
        reason: [
          formatReasonCode(taskGraphIssue.reasonCode),
          taskGraphIssue.message,
        ],
        nextActions: taskGraphIssue.nextActions,
      };
      prd = await persistBlockedTaskAttempt({
        ctx,
        repoRoot,
        prd,
        task: focusTask,
        attemptAt,
        iteration: state.iteration,
        gates,
        ui,
        judge,
        runId,
      });
    }
    await logRunEvent(ctx, repoRoot, "error", RUN_EVENT.BLOCKED_TASK_GRAPH, "Run blocked: invalid task dependency graph", {
      reasonCode: taskGraphIssue.reasonCode,
      taskId: taskGraphIssue.taskId,
      message: taskGraphIssue.message,
    }, { runId, taskId: taskGraphIssue.taskId, reasonCode: taskGraphIssue.reasonCode });
    return {
      blocked: true,
      prd,
      message: [
        formatReasonCode(taskGraphIssue.reasonCode),
        taskGraphIssue.message,
        ...taskGraphIssue.nextActions,
      ].join("\n"),
    };
  }

  const frontendSync = await syncFrontendAgentsConfig({
    repoRoot,
    workspaceRoot,
    prd,
  });
  if (frontendSync.parseWarnings > 0) {
    await showToast(ctx, `Run warning: AGENTS.md parse warnings (${frontendSync.parseWarnings})`, "warning");
  }

  const maxItems = parseMaxItems(args.max_items);
  const uiSetup = await resolveUiRunSetup({
    ctx,
    repoRoot,
    workspaceRoot,
    onWarnings: async (count) => {
      await showToast(ctx, `Run warning: AGENTS.md parse warnings (${count})`, "warning");
    },
    onPrereqLog: async (entry) => {
      if (entry.event === "ui.prereq.browser-install.start") {
        await showToast(ctx, "Run: installing browser runtime for UI verification (may take a few minutes)", "info");
      }
      await logRunEvent(
        ctx,
        repoRoot,
        entry.level,
        entry.event,
        entry.message,
        entry.extra,
        { runId, ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) },
      );
    },
  });

  const {
    uiVerifyEnabled,
    uiVerifyRequired,
    shouldRunUiVerify,
    isWebApp,
  } = uiSetup;

  const sessionAgents = await resolveSessionAgents({ repoRoot });
  if (sessionAgents.parseWarnings > 0) {
    await showToast(ctx, `Run warning: AGENTS.md parse warnings (${sessionAgents.parseWarnings})`, "warning");
  }
  const defaultAgentBrowserCaps: DefaultAgentBrowserCaps = {
    available: false,
    version: null,
    commands: [],
    openUsage: null,
    notes: [],
  };
  const agentBrowserCaps = (uiVerifyEnabled && isWebApp)
    ? await Promise.race([
      discoverAgentBrowserCapabilities(ctx),
      new Promise<DefaultAgentBrowserCaps>((resolve) => {
        setTimeout(() => {
          resolve({
            ...defaultAgentBrowserCaps,
            notes: ["Capability probe timed out after 8s; continuing without capability metadata."],
          });
        }, 8000);
      }),
    ])
    : defaultAgentBrowserCaps;

  if (uiVerifyEnabled && isWebApp) {
    await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.UI_CAPABILITIES, "Discovered agent-browser capabilities", {
      available: agentBrowserCaps.available,
      version: agentBrowserCaps.version,
      openUsage: agentBrowserCaps.openUsage,
      commands: agentBrowserCaps.commands,
      notes: agentBrowserCaps.notes,
    }, { runId });
  }

  await logRunEvent(ctx, repoRoot, "info", RUN_EVENT.STARTED, "Run started", {
    maxItems,
    uiVerifyEnabled,
    uiVerifyRequired,
    shouldRunUiVerify,
    workAgent: sessionAgents.workAgent,
    verifyAgent: sessionAgents.verifyAgent,
    streamWorkEvents: sessionAgents.streamWorkEvents,
    streamVerifyEvents: sessionAgents.streamVerifyEvents,
    uiVerifyWaitMs: TIMEOUTS.UI_VERIFY_WAIT_MS,
    agentBrowserVersion: agentBrowserCaps.version,
    agentBrowserOpenUsage: agentBrowserCaps.openUsage,
    agentBrowserCommands: agentBrowserCaps.commands,
    agentBrowserNotes: agentBrowserCaps.notes,
  }, { runId });

  const runStartIteration = (await readRunState(repoRoot)).iteration;
  return {
    blocked: false,
    prd,
    workspaceRoot,
    workspaceAbs,
    maxItems,
    uiSetup,
    sessionAgents,
    agentBrowserCaps,
    runStartIteration,
  };
};
