import { createHash } from "crypto";
import path from "path";
import { assetsDir } from "./paths";
import { readText } from "./fs";
import { resolvePromptText } from "./runner";
import { unwrapSdkData } from "./opencode-sdk";
import { forgetSessionIdle, getSessionIdleSequence, waitForSessionIdleSignal } from "./session-idle-signal";
import { extractMessageId, extractSessionId, isSessionNotFoundError } from "./session-utils";

const nowIso = (): string => new Date().toISOString();

const buildFingerprint = (input: string): string => {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
};

export const buildVerifierBaseline = async (capabilitySummary: string): Promise<{ text: string; fingerprint: string }> => {
  const playbookPath = path.join(assetsDir(), "prompts", "UI_VERIFIER.md");
  const playbook = await readText(playbookPath);
  const baseline = [
    "# mario-devx verifier session baseline",
    "",
    "You are the verifier session. Use this baseline on every verifier pass.",
    "Hard rules:",
    "- Never modify repository files.",
    "- Use evidence-based judgment against current task and PRD context.",
    "- If FAIL, provide concrete nextActions.",
    "",
    "Runtime capability summary:",
    capabilitySummary || "(none)",
    "",
    playbook,
  ].join("\n");
  return {
    text: baseline,
    fingerprint: buildFingerprint(baseline),
  };
};

export type VerifierPhaseSession = {
  sessionId: string;
  baselineMessageId: string;
  baselineFingerprint: string;
  createdAt: string;
};

export const createVerifierPhaseSession = async (opts: {
  ctx: any;
  capabilitySummary: string;
  agent?: string;
}): Promise<VerifierPhaseSession> => {
  const { ctx, capabilitySummary, agent } = opts;
  const baseline = await buildVerifierBaseline(capabilitySummary);
  const created = await ctx.client.session.create();
  const sessionId = extractSessionId(created);
  if (!sessionId) {
    throw new Error("Failed to create verifier phase session");
  }

  await ctx.client.session.update({
    path: { id: sessionId },
    body: { title: "mario-devx (verify phase)" },
  });

  const baselineResp = await ctx.client.session.prompt({
    path: { id: sessionId },
    body: {
      noReply: true,
      ...(agent ? { agent } : {}),
      parts: [{ type: "text", text: baseline.text }],
    },
  });
  const baselineMessageId = extractMessageId(baselineResp);
  if (!baselineMessageId) {
    throw new Error("Failed to create verifier phase baseline message");
  }

  return {
    sessionId,
    baselineMessageId,
    baselineFingerprint: baseline.fingerprint,
    createdAt: nowIso(),
  };
};

export const disposeVerifierPhaseSession = async (
  ctx: any,
  sessionId: string,
  controlSessionId?: string,
): Promise<"deleted" | "not-found" | "skipped-control" | "failed"> => {
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

export const runVerifierTurn = async (opts: {
  ctx: any;
  sessionId: string;
  promptText: string;
  agent?: string;
}): Promise<string> => {
  const { ctx, sessionId, promptText, agent } = opts;
  const body = {
    ...(agent ? { agent } : {}),
    parts: [{ type: "text", text: promptText }],
  };

  const isLikelyTransportParseError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /unexpected eof|unexpected end of json input|json parse error|empty response/i.test(message);
  };

  const readMessages = async (): Promise<Array<{ info?: { role?: string; id?: string }; parts?: Array<{ text?: string }> }>> => {
    try {
      const byId = await ctx.client.session.messages({ path: { id: sessionId } });
      const unwrapped = unwrapSdkData<Array<{ info?: { role?: string; id?: string }; parts?: Array<{ text?: string }> }>>(byId);
      return Array.isArray(unwrapped) ? unwrapped : [];
    } catch {
      try {
        const bySessionID = await ctx.client.session.messages({ path: { sessionID: sessionId } });
        const unwrapped = unwrapSdkData<Array<{ info?: { role?: string; id?: string }; parts?: Array<{ text?: string }> }>>(bySessionID);
        return Array.isArray(unwrapped) ? unwrapped : [];
      } catch {
        return [];
      }
    }
  };

  const textFromParts = (parts: Array<{ text?: string }> | undefined): string => {
    const safeParts = Array.isArray(parts) ? parts : [];
    return safeParts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  };

  const waitForLatestAssistantText = async (baselineAssistantCount: number): Promise<string> => {
    let afterSequence = getSessionIdleSequence(sessionId);
    while (true) {
      const messages = await readMessages();
      const assistants = messages.filter((entry) => entry.info?.role === "assistant");
      if (assistants.length > baselineAssistantCount) {
        const latest = assistants[assistants.length - 1];
        const text = textFromParts(latest?.parts);
        if (text.length > 0) {
          return text;
        }
      }
      const idle = await waitForSessionIdleSignal({
        sessionId,
        afterSequence,
      });
      if (!idle.ok) {
        return "";
      }
      afterSequence = idle.sequence;
    }
  };

  try {
    const response = await ctx.client.session.prompt({
      path: { id: sessionId },
      body,
    });
    return resolvePromptText(ctx, sessionId, response);
  } catch (error) {
    if (!isLikelyTransportParseError(error)) {
      throw error;
    }

    const baselineMessages = await readMessages();
    const baselineAssistantCount = baselineMessages.filter((entry) => entry.info?.role === "assistant").length;
    await ctx.client.session.promptAsync({
      path: { id: sessionId },
      body,
    });
    const fallbackText = await waitForLatestAssistantText(baselineAssistantCount);
    if (fallbackText.length > 0) {
      return fallbackText;
    }
    throw error;
  }
};
