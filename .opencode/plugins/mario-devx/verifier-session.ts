import { createHash } from "crypto";
import path from "path";
import { assetsDir } from "./assets";
import { readText } from "./fs";
import { resolvePromptText } from "./runner";

const nowIso = (): string => new Date().toISOString();

const extractSessionId = (response: unknown): string | null => {
  const candidate = response as { data?: { id?: string } };
  return candidate.data?.id ?? null;
};

const extractMessageId = (response: unknown): string | null => {
  const candidate = response as { data?: { info?: { id?: string } }; info?: { id?: string } };
  return candidate.data?.info?.id ?? candidate.info?.id ?? null;
};

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

const isSessionNotFoundError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /session not found|notfounderror/i.test(message);
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
    return "deleted";
  } catch (error) {
    if (isSessionNotFoundError(error)) {
      return "not-found";
    }
    return "failed";
  }
};

export const runVerifierTurn = async (opts: {
  ctx: any;
  sessionId: string;
  promptText: string;
  timeoutMs: number;
  agent?: string;
}): Promise<string> => {
  const { ctx, sessionId, promptText, timeoutMs, agent } = opts;
  const response = await ctx.client.session.prompt({
    path: { id: sessionId },
    body: {
      ...(agent ? { agent } : {}),
      parts: [{ type: "text", text: promptText }],
    },
  });
  return resolvePromptText(ctx, sessionId, response, timeoutMs);
};
