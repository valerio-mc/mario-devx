type UnknownRecord = Record<string, unknown>;

const isObject = (value: unknown): value is UnknownRecord => {
  return typeof value === "object" && value !== null;
};

/**
 * OpenCode SDK returns either raw payloads or field-style wrappers:
 * { data, request, response }.
 */
export const unwrapSdkData = <T>(value: unknown): T | null => {
  if (!isObject(value)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(value, "data")) {
    const wrapped = value as { data?: unknown };
    return (wrapped.data ?? null) as T | null;
  }
  return value as T;
};

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

export const readLatestSessionMessageId = async (ctx: any, sessionId: string): Promise<string | null> => {
  const messages = await readSessionMessages(ctx, sessionId);
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const id = messages[idx]?.info?.id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  return null;
};

export const extractSessionId = (response: unknown): string | null => {
  const candidate = response as { data?: { id?: string } };
  return candidate.data?.id ?? null;
};

export const extractMessageId = (response: unknown): string | null => {
  const candidate = response as { data?: { info?: { id?: string } }; info?: { id?: string } };
  return candidate.data?.info?.id ?? candidate.info?.id ?? null;
};

export const isSessionNotFoundError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /session not found|notfounderror/i.test(message);
};
