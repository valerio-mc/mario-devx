import { ensureMario, readRunState, readWorkSessionState, writeRunState, writeWorkSessionState } from "./state";
import type { RunState } from "./types";

const nowIso = (): string => new Date().toISOString();

export const waitForSessionIdle = async (
  ctx: any,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = await ctx.client.session.status();
    const status = (statuses as Record<string, { type?: string }>)[sessionId];
    if (!status || status.type === "idle") {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
};

export const waitForSessionIdleStable = async (
  ctx: any,
  sessionId: string,
  timeoutMs: number,
  consecutiveIdleChecks = 2,
): Promise<boolean> => {
  const start = Date.now();
  let idleStreak = 0;
  while (Date.now() - start < timeoutMs) {
    const statuses = await ctx.client.session.status();
    const status = (statuses as Record<string, { type?: string }>)[sessionId];
    if (!status || status.type === "idle") {
      idleStreak += 1;
      if (idleStreak >= Math.max(1, consecutiveIdleChecks)) {
        return true;
      }
    } else {
      idleStreak = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
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

const extractSessionId = (response: unknown): string | null => {
  const candidate = response as { data?: { id?: string } };
  return candidate.data?.id ?? null;
};

const extractMessageId = (response: unknown): string | null => {
  const candidate = response as { data?: { info?: { id?: string } }; info?: { id?: string } };
  return candidate.data?.info?.id ?? candidate.info?.id ?? null;
};

export const ensureWorkSession = async (
  ctx: any,
  repoRoot: string,
  agent: string | undefined,
): Promise<{ sessionId: string; baselineMessageId: string }> => {
  await ensureMario(repoRoot, false);
  const existing = await readWorkSessionState(repoRoot);
  if (existing?.sessionId && existing?.baselineMessageId) {
    return { sessionId: existing.sessionId, baselineMessageId: existing.baselineMessageId };
  }

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

  const now = nowIso();
  await writeWorkSessionState(repoRoot, {
    sessionId,
    baselineMessageId,
    createdAt: now,
    updatedAt: now,
  });
  return { sessionId, baselineMessageId };
};

export const resetWorkSession = async (
  ctx: any,
  repoRoot: string,
  agent: string | undefined,
): Promise<{ sessionId: string; baselineMessageId: string }> => {
  const ws = await ensureWorkSession(ctx, repoRoot, agent);
  await ctx.client.session.revert({
    path: { id: ws.sessionId },
    body: { messageID: ws.baselineMessageId },
  });
  return ws;
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
  const ws = await readWorkSessionState(repoRoot);
  if (!ws?.sessionId) {
    return { ok: true };
  }
  if (!context.sessionID || context.sessionID !== ws.sessionId) {
    return { ok: true };
  }
  return {
    ok: false,
    message: `This command cannot run inside mario-devx work session (${ws.sessionId}). Use your control session.`,
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
  waitTimeoutMs: number,
): Promise<string> => {
  const direct = extractTextFromPromptResponse(promptResponse);
  if (direct.length > 0) {
    return direct;
  }

  const messageId = extractPromptMessageId(promptResponse);
  if (!messageId) {
    return "";
  }

  const idle = await waitForSessionIdle(ctx, sessionId, waitTimeoutMs);
  if (!idle) {
    return "";
  }

  return readSessionMessageText(ctx, sessionId, messageId);
};
