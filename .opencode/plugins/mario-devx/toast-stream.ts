type StreamPhase = "work" | "verify";

type ToastVariant = "info" | "success" | "warning" | "error";

type ToastNotifier = (input: {
  message: string;
  variant: ToastVariant;
}) => Promise<void>;

type ToolCallMarker = "start" | "completed" | "error";

type UnknownRecord = Record<string, unknown>;

type PhaseBuffer = {
  text: string;
  taskId?: string;
  lastToastAt: number;
  lastToastText: string;
  toolCalls: Map<string, ToolCallMarker>;
  patchHashes: Set<string>;
};

type ToastChannel = {
  work: PhaseBuffer;
  verify: PhaseBuffer;
};

const channels = new Map<string, ToastChannel>();

const CLIP_TEXT_CHARS = 240;
const MAX_BUFFER_CHARS = 1200;
const DEFAULT_MIN_INTERVAL_MS = 3500;
const TOOL_DETAIL_CHARS = 140;

const createPhaseBuffer = (): PhaseBuffer => ({
  text: "",
  lastToastAt: 0,
  lastToastText: "",
  toolCalls: new Map<string, ToolCallMarker>(),
  patchHashes: new Set<string>(),
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

const asRecord = (value: unknown): UnknownRecord | null => {
  if (!value || typeof value !== "object") return null;
  return value as UnknownRecord;
};

const readString = (record: UnknownRecord | null, key: string): string => {
  if (!record) return "";
  const value = record[key];
  return typeof value === "string" ? value : "";
};

const readNumber = (record: UnknownRecord | null, key: string): number | null => {
  if (!record) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const normalizeToastText = (value: string): string => {
  return value
    .replace(/\s+/g, " ")
    .trim();
};

const clipText = (value: string, maxChars = CLIP_TEXT_CHARS): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
};

const appendToastLine = (phaseBuffer: PhaseBuffer, text: string): boolean => {
  const line = normalizeToastText(text);
  if (!line) return false;
  phaseBuffer.text = phaseBuffer.text.length > 0 ? `${phaseBuffer.text}\n${line}` : line;
  if (phaseBuffer.text.length > MAX_BUFFER_CHARS) {
    phaseBuffer.text = phaseBuffer.text.slice(-MAX_BUFFER_CHARS);
  }
  return true;
};

const pruneMapToSize = <T>(map: Map<string, T>, maxSize: number): void => {
  while (map.size > maxSize) {
    const first = map.keys().next();
    if (first.done) return;
    map.delete(first.value);
  }
};

const pruneSetToSize = (set: Set<string>, maxSize: number): void => {
  while (set.size > maxSize) {
    const first = set.values().next();
    if (first.done) return;
    set.delete(first.value);
  }
};

const toolInputSummary = (toolName: string, input: unknown): string => {
  const inputObj = asRecord(input);
  const command = readString(inputObj, "command");
  if (toolName === "bash" && command) {
    return clipText(normalizeToastText(command), TOOL_DETAIL_CHARS);
  }
  const filePath = readString(inputObj, "filePath") || readString(inputObj, "path");
  if (filePath) {
    return clipText(normalizeToastText(filePath), TOOL_DETAIL_CHARS);
  }
  const description = readString(inputObj, "description");
  if (description) {
    return clipText(normalizeToastText(description), TOOL_DETAIL_CHARS);
  }
  return "";
};

const toolMarkerForStatus = (status: string): ToolCallMarker | null => {
  if (status === "pending" || status === "running") return "start";
  if (status === "completed") return "completed";
  if (status === "error") return "error";
  return null;
};

const toolEventLine = (part: UnknownRecord): { key: string; marker: ToolCallMarker; line: string } | null => {
  const toolName = readString(part, "tool") || "tool";
  const callId = readString(part, "callID") || readString(part, "id");
  const state = asRecord(part.state);
  const status = readString(state, "status");
  const marker = toolMarkerForStatus(status);
  if (!marker) return null;

  const title = readString(state, "title");
  const detail = title || toolInputSummary(toolName, state?.input);
  if (marker === "start") {
    const line = detail
      ? `tool ${toolName} started: ${clipText(normalizeToastText(detail), TOOL_DETAIL_CHARS)}`
      : `tool ${toolName} started`;
    return {
      key: callId || `${toolName}:${status}`,
      marker,
      line,
    };
  }

  if (marker === "completed") {
    const metadata = asRecord(state?.metadata);
    const exitCode = readNumber(metadata, "exitCode");
    const withExit = toolName === "bash" && exitCode !== null
      ? `tool ${toolName} completed (exit ${exitCode})`
      : `tool ${toolName} completed`;
    const line = detail
      ? `${withExit}: ${clipText(normalizeToastText(detail), TOOL_DETAIL_CHARS)}`
      : withExit;
    return {
      key: callId || `${toolName}:${status}`,
      marker,
      line,
    };
  }

  const err = clipText(normalizeToastText(readString(state, "error")), TOOL_DETAIL_CHARS);
  return {
    key: callId || `${toolName}:${status}`,
    marker,
    line: err ? `tool ${toolName} failed: ${err}` : `tool ${toolName} failed`,
  };
};

const patchEventLine = (part: UnknownRecord): { hash: string; line: string } | null => {
  const hash = readString(part, "hash");
  const filesRaw = Array.isArray(part.files) ? part.files : [];
  const files = filesRaw
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .slice(0, 3);
  const count = Array.isArray(part.files) ? part.files.length : files.length;
  const suffix = count > files.length ? ` (+${count - files.length} more)` : "";
  const listed = files.length > 0 ? `: ${files.join(", ")}${suffix}` : "";
  return {
    hash,
    line: `patch updated (${count || files.length} file${(count || files.length) === 1 ? "" : "s"})${listed}`,
  };
};

const resolvePhase = (opts: {
  sessionID: string;
  workSessionId?: string;
  verifierSessionId?: string;
  streamWorkEvents?: boolean;
  streamVerifyEvents?: boolean;
}): StreamPhase | null => {
  const {
    sessionID,
    workSessionId,
    verifierSessionId,
    streamWorkEvents,
    streamVerifyEvents,
  } = opts;

  if (workSessionId && sessionID === workSessionId) {
    return streamWorkEvents ? "work" : null;
  }
  if (verifierSessionId && sessionID === verifierSessionId) {
    return streamVerifyEvents ? "verify" : null;
  }
  return null;
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

const appendToolEvent = (opts: {
  controlSessionId: string;
  phase: StreamPhase;
  key: string;
  marker: ToolCallMarker;
  line: string;
  taskId?: string;
}): boolean => {
  const channel = getOrCreateChannel(opts.controlSessionId);
  const phaseBuffer = channel[opts.phase];
  const previous = phaseBuffer.toolCalls.get(opts.key);
  if (previous === opts.marker) return false;
  if (previous === "completed" || previous === "error") return false;
  phaseBuffer.toolCalls.set(opts.key, opts.marker);
  pruneMapToSize(phaseBuffer.toolCalls, 300);
  if (opts.taskId) {
    phaseBuffer.taskId = opts.taskId;
  }
  return appendToastLine(phaseBuffer, opts.line);
};

const appendPatchEvent = (opts: {
  controlSessionId: string;
  phase: StreamPhase;
  hash: string;
  line: string;
  taskId?: string;
}): boolean => {
  const channel = getOrCreateChannel(opts.controlSessionId);
  const phaseBuffer = channel[opts.phase];
  const dedupeHash = opts.hash || opts.line;
  if (phaseBuffer.patchHashes.has(dedupeHash)) return false;
  phaseBuffer.patchHashes.add(dedupeHash);
  pruneSetToSize(phaseBuffer.patchHashes, 300);
  if (opts.taskId) {
    phaseBuffer.taskId = opts.taskId;
  }
  return appendToastLine(phaseBuffer, opts.line);
};

type StreamIngestResult =
  | { accepted: false }
  | {
    accepted: true;
    phase: StreamPhase;
    forceFlush: boolean;
  };

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
  const props = asRecord(e.properties);
  const part = asRecord(props?.part);
  const sessionID = readString(part, "sessionID");
  if (!sessionID) return { accepted: false };
  const phase = resolvePhase({
    sessionID,
    workSessionId,
    verifierSessionId,
    streamWorkEvents,
    streamVerifyEvents,
  });
  if (!phase) return { accepted: false };

  const partType = readString(part, "type");
  if (partType === "text") {
    const delta = typeof props?.delta === "string" ? props.delta : "";
    if (!delta.trim()) return { accepted: false };
    const accepted = appendToastDelta({
      controlSessionId,
      phase,
      delta,
      ...(taskId ? { taskId } : {}),
    });
    return accepted
      ? {
        accepted: true,
        phase,
        forceFlush: false,
      }
      : { accepted: false };
  }

  if (partType === "tool") {
    const tool = toolEventLine(part);
    if (!tool) return { accepted: false };
    const accepted = appendToolEvent({
      controlSessionId,
      phase,
      key: tool.key,
      marker: tool.marker,
      line: tool.line,
      ...(taskId ? { taskId } : {}),
    });
    return accepted
      ? {
        accepted: true,
        phase,
        forceFlush: true,
      }
      : { accepted: false };
  }

  if (partType === "patch") {
    const patch = patchEventLine(part);
    if (!patch) return { accepted: false };
    const accepted = appendPatchEvent({
      controlSessionId,
      phase,
      hash: patch.hash,
      line: patch.line,
      ...(taskId ? { taskId } : {}),
    });
    return accepted
      ? {
        accepted: true,
        phase,
        forceFlush: true,
      }
      : { accepted: false };
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
