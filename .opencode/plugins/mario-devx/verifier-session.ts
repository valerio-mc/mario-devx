import { createHash } from "crypto";
import path from "path";
import { assetsDir } from "./assets";
import { readText } from "./fs";
import { resolvePromptText } from "./runner";
import { readVerifierSessionState, writeVerifierSessionState } from "./state";
import type { VerifierSessionState } from "./types";

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

const createVerifierSession = async (
  ctx: any,
  baselineText: string,
  baselineFingerprint: string,
  agent?: string,
): Promise<VerifierSessionState> => {
  const created = await ctx.client.session.create();
  const sessionId = extractSessionId(created);
  if (!sessionId) {
    throw new Error("Failed to create verifier session");
  }

  await ctx.client.session.update({
    path: { id: sessionId },
    body: { title: "mario-devx (verifier)" },
  });

  const baselineResp = await ctx.client.session.prompt({
    path: { id: sessionId },
    body: {
      noReply: true,
      ...(agent ? { agent } : {}),
      parts: [{ type: "text", text: baselineText }],
    },
  });
  const baselineMessageId = extractMessageId(baselineResp);
  if (!baselineMessageId) {
    throw new Error("Failed to create verifier baseline message");
  }

  const now = nowIso();
  return {
    sessionId,
    baselineMessageId,
    baselineFingerprint,
    ...(agent ? { agent } : {}),
    createdAt: now,
    updatedAt: now,
  };
};

const verifierSessionHealthy = async (ctx: any, session: VerifierSessionState): Promise<boolean> => {
  try {
    await ctx.client.session.get({ path: { id: session.sessionId } });
    await ctx.client.session.message({ path: { id: session.sessionId, messageID: session.baselineMessageId } });
    return true;
  } catch {
    return false;
  }
};

export const ensureVerifierSession = async (opts: {
  ctx: any;
  repoRoot: string;
  capabilitySummary: string;
  agent?: string;
}): Promise<VerifierSessionState> => {
  const { ctx, repoRoot, capabilitySummary, agent } = opts;
  const baseline = await buildVerifierBaseline(capabilitySummary);
  const existing = await readVerifierSessionState(repoRoot);
  if (
    existing
    && existing.baselineFingerprint === baseline.fingerprint
    && (existing.agent ?? "") === (agent ?? "")
    && await verifierSessionHealthy(ctx, existing)
  ) {
    const now = nowIso();
    const refreshed: VerifierSessionState = { ...existing, updatedAt: now, lastHealthCheckAt: now };
    await writeVerifierSessionState(repoRoot, refreshed);
    return refreshed;
  }

  const created = await createVerifierSession(ctx, baseline.text, baseline.fingerprint, agent);
  await writeVerifierSessionState(repoRoot, created);
  return created;
};

export const resetVerifierSessionToBaseline = async (
  ctx: any,
  repoRoot: string,
  session: VerifierSessionState,
): Promise<void> => {
  await ctx.client.session.revert({
    path: { id: session.sessionId },
    body: { messageID: session.baselineMessageId },
  });
  await writeVerifierSessionState(repoRoot, { ...session, updatedAt: nowIso() });
};

export const invalidateVerifierSession = async (repoRoot: string): Promise<void> => {
  await writeVerifierSessionState(repoRoot, null);
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
