type StreamPhase = "work" | "verify";

type ProgressLine = {
  phase: StreamPhase;
  text: string;
  at: number;
  taskId?: string;
};

type ProgressReporter = (snapshot: {
  phase: StreamPhase;
  taskId?: string;
  lines: string[];
  updatedAt: string;
}) => void;

type ProgressChannel = {
  lines: ProgressLine[];
  revision: number;
  deliveredRevision: number;
  lastDeliveredAt: number;
  reporter?: ProgressReporter;
  maxLines: number;
};

const channels = new Map<string, ProgressChannel>();

const CLIP_TEXT_CHARS = 260;
const DEFAULT_MAX_LINES = 5;
const DEFAULT_MIN_INTERVAL_MS = 900;

const normalizeText = (value: string): string => {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= CLIP_TEXT_CHARS) return singleLine;
  return `${singleLine.slice(0, CLIP_TEXT_CHARS)}...`;
};

const getOrCreateChannel = (controlSessionId: string): ProgressChannel => {
  const existing = channels.get(controlSessionId);
  if (existing) return existing;
  const created: ProgressChannel = {
    lines: [],
    revision: 0,
    deliveredRevision: 0,
    lastDeliveredAt: 0,
    maxLines: DEFAULT_MAX_LINES,
  };
  channels.set(controlSessionId, created);
  return created;
};

export const registerControlProgressReporter = (
  controlSessionId: string,
  reporter: ProgressReporter,
  maxLines = DEFAULT_MAX_LINES,
): (() => void) => {
  const channel = getOrCreateChannel(controlSessionId);
  channel.reporter = reporter;
  channel.maxLines = Number.isFinite(maxLines) ? Math.max(3, Math.min(8, Math.round(maxLines))) : DEFAULT_MAX_LINES;
  return () => {
    const live = channels.get(controlSessionId);
    if (!live) return;
    if (live.reporter === reporter) {
      delete live.reporter;
    }
    if (!live.reporter) {
      channels.delete(controlSessionId);
    }
  };
};

export const pushControlProgressLine = (
  controlSessionId: string,
  line: {
    phase: StreamPhase;
    text: string;
    taskId?: string;
  },
): boolean => {
  const text = normalizeText(line.text);
  if (!text) return false;
  const channel = getOrCreateChannel(controlSessionId);
  const prev = channel.lines[channel.lines.length - 1];
  if (prev && prev.phase === line.phase && prev.text === text) {
    return false;
  }
  channel.lines.push({
    phase: line.phase,
    text,
    at: Date.now(),
    ...(line.taskId ? { taskId: line.taskId } : {}),
  });
  if (channel.lines.length > channel.maxLines) {
    channel.lines = channel.lines.slice(-channel.maxLines);
  }
  channel.revision += 1;
  return true;
};

export const ingestControlProgressEvent = (opts: {
  controlSessionId: string;
  event: unknown;
  workSessionId?: string;
  verifierSessionId?: string;
  streamWorkEvents?: boolean;
  streamVerifyEvents?: boolean;
  taskId?: string;
}): boolean => {
  const {
    controlSessionId,
    event,
    workSessionId,
    verifierSessionId,
    streamWorkEvents,
    streamVerifyEvents,
    taskId,
  } = opts;
  if (!event || typeof event !== "object") return false;
  const e = event as { type?: unknown; properties?: unknown };
  if (e.type !== "message.part.updated") return false;
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
  if (!sessionID) return false;
  if (part?.type !== "text") return false;
  const delta = typeof props?.delta === "string" ? props.delta : "";
  const text = normalizeText(delta);
  if (!text) return false;

  if (workSessionId && sessionID === workSessionId) {
    if (!streamWorkEvents) return false;
    return pushControlProgressLine(controlSessionId, { phase: "work", text, ...(taskId ? { taskId } : {}) });
  }
  if (verifierSessionId && sessionID === verifierSessionId) {
    if (!streamVerifyEvents) return false;
    return pushControlProgressLine(controlSessionId, { phase: "verify", text, ...(taskId ? { taskId } : {}) });
  }
  return false;
};

export const flushControlProgress = (
  controlSessionId: string,
  opts?: {
    force?: boolean;
    minIntervalMs?: number;
  },
): boolean => {
  const channel = channels.get(controlSessionId);
  if (!channel || !channel.reporter) return false;
  if (channel.revision === channel.deliveredRevision) return false;
  const minIntervalMs = Number.isFinite(opts?.minIntervalMs) ? Math.max(0, Number(opts?.minIntervalMs)) : DEFAULT_MIN_INTERVAL_MS;
  const now = Date.now();
  if (!opts?.force && now - channel.lastDeliveredAt < minIntervalMs) return false;

  const latest = channel.lines[channel.lines.length - 1];
  const snapshot = {
    phase: latest?.phase ?? "work",
    ...(latest?.taskId ? { taskId: latest.taskId } : {}),
    lines: channel.lines.map((line) => `${line.phase}: ${line.text}`),
    updatedAt: new Date(now).toISOString(),
  };
  try {
    channel.reporter(snapshot);
    channel.deliveredRevision = channel.revision;
    channel.lastDeliveredAt = now;
    return true;
  } catch {
    return false;
  }
};
