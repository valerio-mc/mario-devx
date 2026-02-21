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
