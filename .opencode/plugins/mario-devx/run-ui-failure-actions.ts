import type { PrdUiAttempt } from "./prd";
import type { UiFailureSubtype, UiVerificationFailure } from "./ui-types";

const clip = (text: string, maxChars: number): string => {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}…`;
};

export const buildUiFailureSignature = (opts: {
  subtype: UiFailureSubtype;
  pid?: number;
  lockPath?: string;
}): string => {
  return `${opts.subtype}|${typeof opts.pid === "number" ? opts.pid : ""}|${opts.lockPath ?? ""}`;
};

const normalizeTranscript = (transcript: string[] | undefined): string[] => {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .map((line) => String(line).trim())
    .filter(Boolean)
    .slice(0, 12);
};

const normalizeFailure = (failure: UiVerificationFailure | PrdUiAttempt["failure"] | undefined): PrdUiAttempt["failure"] | undefined => {
  if (!failure) return undefined;
  const subtype = failure.subtype ?? "UNKNOWN";
  const pid = typeof failure.pid === "number" && Number.isFinite(failure.pid) && failure.pid > 0
    ? failure.pid
    : undefined;
  const lockPath = typeof failure.lockPath === "string" && failure.lockPath.trim().length > 0
    ? failure.lockPath.trim()
    : undefined;
  const signature = typeof failure.signature === "string" && failure.signature.trim().length > 0
    ? failure.signature
    : buildUiFailureSignature({ subtype, ...(typeof pid === "number" ? { pid } : {}), ...(lockPath ? { lockPath } : {}) });
  const repeatCount = typeof failure.repeatCount === "number" && Number.isFinite(failure.repeatCount) && failure.repeatCount > 1
    ? Math.floor(failure.repeatCount)
    : undefined;
  return {
    subtype,
    ...(typeof pid === "number" ? { pid } : {}),
    ...(lockPath ? { lockPath } : {}),
    transcript: normalizeTranscript(failure.transcript),
    signature,
    ...(typeof repeatCount === "number" ? { repeatCount } : {}),
  };
};

export const compactUiFailureForAttempt = (opts: {
  note: string | null | undefined;
  failure: UiVerificationFailure | undefined;
  previousUi: PrdUiAttempt | undefined;
}): { note: string | undefined; failure: PrdUiAttempt["failure"] | undefined } => {
  const normalizedFailure = normalizeFailure(opts.failure);
  const note = typeof opts.note === "string" ? opts.note.trim() : "";
  if (!normalizedFailure) {
    return { note: note || undefined, failure: undefined };
  }
  const previousFailure = normalizeFailure(opts.previousUi?.failure);
  const currentSignature = normalizedFailure.signature ?? buildUiFailureSignature(normalizedFailure);
  const previousSignature = previousFailure?.signature ?? (previousFailure ? buildUiFailureSignature(previousFailure) : null);
  if (!previousFailure || !previousSignature || currentSignature !== previousSignature) {
    return {
      note: note || undefined,
      failure: {
        ...normalizedFailure,
        signature: currentSignature,
      },
    };
  }

  const repeatCount = (previousFailure.repeatCount ?? 1) + 1;
  const prefixParts = [
    `Repeated UI verify failure (${repeatCount}x)`,
    `Subtype=${normalizedFailure.subtype}`,
    ...(typeof normalizedFailure.pid === "number" ? [`pid=${normalizedFailure.pid}`] : []),
    ...(normalizedFailure.lockPath ? [`lockPath=${normalizedFailure.lockPath}`] : []),
  ];
  const compactedNote = `${prefixParts.join("; ")}. Latest: ${clip(note || "UI verification failed.", 420)}`;
  return {
    note: compactedNote,
    failure: {
      ...normalizedFailure,
      signature: currentSignature,
      repeatCount,
    },
  };
};

export const buildUiVerifyBlockedPayload = (ui: PrdUiAttempt | undefined, phase: string): Record<string, unknown> => {
  const failure = normalizeFailure(ui?.failure);
  return {
    phase,
    uiOk: ui?.ok ?? null,
    ...(ui?.note ? { note: clip(ui.note, 600) } : {}),
    ...(failure ? {
      failure: {
        subtype: failure.subtype,
        ...(typeof failure.pid === "number" ? { pid: failure.pid } : {}),
        ...(failure.lockPath ? { lockPath: failure.lockPath } : {}),
        ...(failure.signature ? { signature: failure.signature } : {}),
        ...(typeof failure.repeatCount === "number" ? { repeatCount: failure.repeatCount } : {}),
        transcript: failure.transcript.slice(0, 8),
      },
    } : {}),
  };
};

export const extractUiFailurePid = (note: string | null | undefined, failure?: PrdUiAttempt["failure"]): number | null => {
  if (typeof failure?.pid === "number" && Number.isFinite(failure.pid) && failure.pid > 0) {
    return failure.pid;
  }
  if (!note) return null;
  const match = note.match(/\bpid\s+(\d+)\b/i);
  if (!match?.[1]) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
};

export const buildUiVerifyFailedNextActions = (note: string | null | undefined, failure?: PrdUiAttempt["failure"]): string[] => {
  const actions: string[] = [];
  const pid = extractUiFailurePid(note, failure);
  if (pid) {
    actions.push(`kill ${pid}`);
  } else {
    actions.push("Resolve the UI verifier environment issue described in the UI note.");
  }
  actions.push("Retry /mario-devx:run 1.");
  return actions;
};
