import { ensureMario, readRunState, writeRunState } from "./state";
import type { RunState } from "./types";
import { forgetSessionIdle, getSessionIdleSequence, waitForSessionIdleSignal } from "./session-idle-signal";
import { extractMessageId, extractSessionId, isSessionNotFoundError } from "./session-utils";

const nowIso = (): string => new Date().toISOString();

export type SessionIdleWaitResult = {
  ok: boolean;
  reason: "idle" | "aborted" | "timeout";
  unknownChecks: number;
  activeChecks: number;
  idleSequence: number;
};

const DEFAULT_IDLE_WAIT_TIMEOUT_MS = 60_000;

export const waitForSessionIdle = async (
  _ctx: any,
  sessionId: string,
  _timeoutMs: number,
  opts?: {
    afterSequence?: number;
    abortSignal?: AbortSignal;
  },
): Promise<boolean> => {
  const result = await waitForSessionIdleStableDetailed(_ctx, sessionId, _timeoutMs, 1, opts);
  return result.ok;
};

export const waitForSessionIdleStable = async (
  _ctx: any,
  sessionId: string,
  _timeoutMs: number,
  consecutiveIdleChecks = 1,
  opts?: {
    afterSequence?: number;
    abortSignal?: AbortSignal;
  },
): Promise<boolean> => {
  const result = await waitForSessionIdleStableDetailed(_ctx, sessionId, _timeoutMs, consecutiveIdleChecks, opts);
  return result.ok;
};

export const waitForSessionIdleStableDetailed = async (
  _ctx: any,
  sessionId: string,
  _timeoutMs: number,
  _consecutiveIdleChecks = 1,
  opts?: {
    afterSequence?: number;
    abortSignal?: AbortSignal;
  },
): Promise<SessionIdleWaitResult> => {
  const afterSequence = Number.isFinite(opts?.afterSequence)
    ? Number(opts?.afterSequence)
    : getSessionIdleSequence(sessionId);
  const idleResult = await waitForSessionIdleSignal({
    sessionId,
    afterSequence,
    timeoutMs: _timeoutMs > 0 ? _timeoutMs : DEFAULT_IDLE_WAIT_TIMEOUT_MS,
    ...(opts?.abortSignal ? { signal: opts.abortSignal } : {}),
  });
  return {
    ok: idleResult.ok,
    reason: idleResult.reason,
    unknownChecks: 0,
    activeChecks: 0,
    idleSequence: idleResult.sequence,
  };
};

const getBaselineText = (repoRoot: string): string => {
  return [
    "# mario-devx work session",
    "",
    "This is the mario-devx work session for this repo.",
    "",
    "Hard rules:",
    "- Never edit the control plane: do not modify .opencode/plugins/mario-devx/**",
    "- Keep work state in .mario/ and git.",
    "- One task per build iteration.",
    "",
    "Canonical files:",
    "- PRD + tasks: .mario/prd.json",
    "- Agent config: .mario/AGENTS.md",
    "- State: .mario/state/state.json",
    "",
    `Repo: ${repoRoot}`,
  ].join("\n");
};

export const ensureWorkSession = async (
  ctx: any,
  repoRoot: string,
  agent: string | undefined,
): Promise<{ sessionId: string; baselineMessageId: string }> => {
  await ensureMario(repoRoot, false);

  const created = await ctx.client.session.create();
  const sessionId = extractSessionId(created);
  if (!sessionId) {
    throw new Error("Failed to create work session");
  }

  await ctx.client.session.update({
    path: { id: sessionId },
    body: { title: "mario-devx (work)" },
  });

  const baseline = getBaselineText(repoRoot);
  const baselineResp = await ctx.client.session.prompt({
    path: { id: sessionId },
    body: {
      noReply: true,
      ...(agent ? { agent } : {}),
      parts: [{ type: "text", text: baseline }],
    },
  });
  const baselineMessageId = extractMessageId(baselineResp);
  if (!baselineMessageId) {
    throw new Error("Failed to create baseline message in work session");
  }
  return { sessionId, baselineMessageId };
};

export const resetWorkSession = async (
  ctx: any,
  repoRoot: string,
  agent: string | undefined,
): Promise<{ sessionId: string; baselineMessageId: string }> => {
  return ensureWorkSession(ctx, repoRoot, agent);
};

export const deleteSessionBestEffort = async (
  ctx: any,
  sessionId: string | undefined,
  controlSessionId?: string,
): Promise<"deleted" | "not-found" | "skipped-control" | "failed" | "none"> => {
  if (!sessionId) {
    return "none";
  }
  if (controlSessionId && sessionId === controlSessionId) {
    return "skipped-control";
  }
  try {
    await ctx.client.session.delete({ path: { id: sessionId } });
    forgetSessionIdle(sessionId);
    return "deleted";
  } catch (error) {
    if (isSessionNotFoundError(error)) {
      forgetSessionIdle(sessionId);
      return "not-found";
    }
    return "failed";
  }
};

export const setWorkSessionTitle = async (
  ctx: any,
  sessionId: string,
  title: string,
): Promise<void> => {
  try {
    await ctx.client.session.update({
      path: { id: sessionId },
      body: { title },
    });
  } catch {
    // Best-effort only.
  }
};

export const ensureNotInWorkSession = async (
  repoRoot: string,
  context: { sessionID?: string },
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const run = await readRunState(repoRoot);
  if (!run.workSessionId || run.status !== "DOING") {
    return { ok: true };
  }
  if (!context.sessionID || context.sessionID !== run.workSessionId) {
    return { ok: true };
  }
  return {
    ok: false,
    message: `This command cannot run inside mario-devx work phase session (${run.workSessionId}). Use your control session.`,
  };
};

export const updateRunState = async (
  repoRoot: string,
  patch: Partial<RunState>,
): Promise<RunState> => {
  const run = await readRunState(repoRoot);
  const next: RunState = {
    ...run,
    ...patch,
    updatedAt: nowIso(),
  };
  await writeRunState(repoRoot, next);
  return next;
};

export const extractTextFromPromptResponse = (resp: unknown): string => {
  const out = resp as {
    parts?: Array<{ type?: string; text?: string }>;
    data?: {
      parts?: Array<{ type?: string; text?: string }>;
      message?: {
        parts?: Array<{ type?: string; text?: string }>;
      };
    };
  };
  const parts = out.parts ?? out.data?.parts ?? out.data?.message?.parts ?? [];
  const text = parts
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
  return text;
};

const extractPromptMessageId = (resp: unknown): string | null => {
  const out = resp as {
    info?: { id?: unknown };
    data?: { info?: { id?: unknown } };
  };
  const id = out.info?.id ?? out.data?.info?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
};

const readSessionMessageText = async (ctx: any, sessionId: string, messageId: string): Promise<string> => {
  try {
    const bySessionID = await ctx.client.session.message({
      path: { sessionID: sessionId, messageID: messageId },
    });
    const text = extractTextFromPromptResponse(bySessionID);
    if (text.length > 0) return text;
  } catch {
    // Fallback below.
  }

  try {
    const byId = await ctx.client.session.message({
      path: { id: sessionId, messageID: messageId },
    });
    return extractTextFromPromptResponse(byId);
  } catch {
    return "";
  }
};

export const resolvePromptText = async (
  ctx: any,
  sessionId: string,
  promptResponse: unknown,
): Promise<string> => {
  const direct = extractTextFromPromptResponse(promptResponse);
  if (direct.length > 0) {
    return direct;
  }

  const messageId = extractPromptMessageId(promptResponse);
  if (!messageId) {
    return "";
  }

  const idle = await waitForSessionIdle(ctx, sessionId, 45_000);
  if (!idle) {
    return readSessionMessageText(ctx, sessionId, messageId);
  }

  return readSessionMessageText(ctx, sessionId, messageId);
};
