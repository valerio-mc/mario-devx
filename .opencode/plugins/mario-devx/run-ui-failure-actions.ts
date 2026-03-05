export const extractUiFailurePid = (note: string | null | undefined): number | null => {
  if (!note) return null;
  const match = note.match(/\bpid\s+(\d+)\b/i);
  if (!match?.[1]) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
};

export const buildUiVerifyFailedNextActions = (note: string | null | undefined): string[] => {
  const actions: string[] = [];
  const pid = extractUiFailurePid(note);
  if (pid) {
    actions.push(`kill ${pid}`);
  } else {
    actions.push("Resolve the UI verifier environment issue described in the UI note.");
  }
  actions.push("Retry /mario-devx:run 1.");
  return actions;
};
