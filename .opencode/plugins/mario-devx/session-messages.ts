import { unwrapSdkData } from "./opencode-sdk";

export type SessionMessage = {
  info?: { role?: string; id?: string };
  parts?: Array<{ text?: string }>;
};

export const readSessionMessages = async (ctx: any, sessionId: string): Promise<SessionMessage[]> => {
  try {
    const byId = await ctx.client.session.messages({ path: { id: sessionId } });
    const unwrapped = unwrapSdkData<SessionMessage[]>(byId);
    return Array.isArray(unwrapped) ? unwrapped : [];
  } catch {
    try {
      const bySessionID = await ctx.client.session.messages({ path: { sessionID: sessionId } });
      const unwrapped = unwrapSdkData<SessionMessage[]>(bySessionID);
      return Array.isArray(unwrapped) ? unwrapped : [];
    } catch {
      return [];
    }
  }
};

export const countAssistantMessages = async (ctx: any, sessionId: string): Promise<number> => {
  const messages = await readSessionMessages(ctx, sessionId);
  return messages.reduce((count, entry) => (entry?.info?.role === "assistant" ? count + 1 : count), 0);
};
