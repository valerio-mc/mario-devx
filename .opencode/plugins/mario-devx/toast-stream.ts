type StreamPhase = "work" | "verify";

type ToastVariant = "info" | "success" | "warning" | "error";

type ToastNotifier = (input: {
  message: string;
  variant: ToastVariant;
}) => Promise<void>;

type PhaseBuffer = {
  text: string;
  taskId?: string;
  lastToastAt: number;
  lastToastText: string;
};

type ToastChannel = {
  work: PhaseBuffer;
  verify: PhaseBuffer;
};

const channels = new Map<string, ToastChannel>();

const CLIP_TEXT_CHARS = 240;
const MAX_BUFFER_CHARS = 1200;
const DEFAULT_MIN_INTERVAL_MS = 3500;

const createPhaseBuffer = (): PhaseBuffer => ({
  text: "",
  lastToastAt: 0,
  lastToastText: "",
});

const getOrCreateChannel = (controlSessionId: string): ToastChannel => {
  const existing = channels.get(controlSessionId);
  if (existing) return existing;
  const created: ToastChannel = {
    work: createPhaseBuffer(),
    verify: createPhaseBuffer(),
  };
  channels.set(controlSessionId, created);
  return created;
};

const normalizeDelta = (value: string): string => {
  return value.replace(/\r/g, "");
};

const normalizeToastText = (value: string): string => {
  return value
    .replace(/\s+/g, " ")
    .trim();
};

const clipText = (value: string): string => {
  if (value.length <= CLIP_TEXT_CHARS) return value;
  return `${value.slice(0, CLIP_TEXT_CHARS)}...`;
};

const appendToastDelta = (opts: {
  controlSessionId: string;
  phase: StreamPhase;
  delta: string;
  taskId?: string;
}): boolean => {
  const delta = normalizeDelta(opts.delta);
  if (!delta.trim()) return false;

  const channel = getOrCreateChannel(opts.controlSessionId);
  const phaseBuffer = channel[opts.phase];
  phaseBuffer.text = `${phaseBuffer.text}${delta}`;
  if (phaseBuffer.text.length > MAX_BUFFER_CHARS) {
    phaseBuffer.text = phaseBuffer.text.slice(-MAX_BUFFER_CHARS);
  }
  if (opts.taskId) {
    phaseBuffer.taskId = opts.taskId;
  }
  return true;
};

type StreamIngestResult =
  | { accepted: false }
  | { accepted: true; phase: StreamPhase };

export const ingestToastStreamEvent = (opts: {
  controlSessionId: string;
  event: unknown;
  workSessionId?: string;
  verifierSessionId?: string;
  streamWorkEvents?: boolean;
  streamVerifyEvents?: boolean;
  taskId?: string;
}): StreamIngestResult => {
  const {
    controlSessionId,
    event,
    workSessionId,
    verifierSessionId,
    streamWorkEvents,
    streamVerifyEvents,
    taskId,
  } = opts;
  if (!event || typeof event !== "object") return { accepted: false };
  const e = event as { type?: unknown; properties?: unknown };
  if (e.type !== "message.part.updated") return { accepted: false };
  const props = e.properties as {
    delta?: unknown;
    part?: {
      sessionID?: unknown;
      type?: unknown;
    };
  } | undefined;
  const part = props?.part;
  const sessionID = typeof part?.sessionID === "string" && part.sessionID.length > 0
    ? part.sessionID
    : "";
  if (!sessionID) return { accepted: false };
  if (part?.type !== "text") return { accepted: false };
  const delta = typeof props?.delta === "string" ? props.delta : "";
  if (!delta.trim()) return { accepted: false };

  if (workSessionId && sessionID === workSessionId) {
    if (!streamWorkEvents) return { accepted: false };
    const accepted = appendToastDelta({
      controlSessionId,
      phase: "work",
      delta,
      ...(taskId ? { taskId } : {}),
    });
    return accepted ? { accepted: true, phase: "work" } : { accepted: false };
  }

  if (verifierSessionId && sessionID === verifierSessionId) {
    if (!streamVerifyEvents) return { accepted: false };
    const accepted = appendToastDelta({
      controlSessionId,
      phase: "verify",
      delta,
      ...(taskId ? { taskId } : {}),
    });
    return accepted ? { accepted: true, phase: "verify" } : { accepted: false };
  }

  return { accepted: false };
};

export const flushToastStream = async (opts: {
  controlSessionId: string;
  notify: ToastNotifier;
  phase?: StreamPhase;
  force?: boolean;
  minIntervalMs?: number;
}): Promise<boolean> => {
  const channel = channels.get(opts.controlSessionId);
  if (!channel) return false;

  const minIntervalMs = Number.isFinite(opts.minIntervalMs)
    ? Math.max(0, Number(opts.minIntervalMs))
    : DEFAULT_MIN_INTERVAL_MS;

  const phaseList: StreamPhase[] = opts.phase ? [opts.phase] : ["work", "verify"];
  let emitted = false;

  for (const phase of phaseList) {
    const phaseBuffer = channel[phase];
    const normalized = normalizeToastText(phaseBuffer.text);
    if (!normalized) continue;

    const now = Date.now();
    if (!opts.force && now - phaseBuffer.lastToastAt < minIntervalMs) {
      continue;
    }

    const body = clipText(normalized);
    const title = `${phase}${phaseBuffer.taskId ? ` ${phaseBuffer.taskId}` : ""}`;
    const message = `${title}: ${body}`;
    if (message === phaseBuffer.lastToastText) {
      phaseBuffer.text = "";
      continue;
    }

    try {
      await opts.notify({
        message,
        variant: "info",
      });
      phaseBuffer.lastToastAt = now;
      phaseBuffer.lastToastText = message;
      phaseBuffer.text = "";
      emitted = true;
    } catch {
      // Best-effort notifications only.
    }
  }

  return emitted;
};

export const clearToastStreamChannel = (controlSessionId: string): void => {
  channels.delete(controlSessionId);
};
