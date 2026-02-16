/**
 * OpenCode Structured Logging
 * 
 * Wrapper around client.app.log() for user-facing structured logging.
 * Use this for events that should appear in the OpenCode UI and be
 * visible to users in the control session.
 * 
 * Note: Internal debugging should still use console.log/error from errors.ts
 * This is specifically for user-visible operational events.
 */

import { appendFile, stat, writeFile } from "fs/promises";
import path from "path";
import { ensureDir } from "./fs";
import { marioStateDir } from "./paths";
type LogContext = {
  client?: {
    app?: {
      log?: (opts: {
        body: {
          service: string;
          level: LogLevel;
          message: string;
          extra: Record<string, unknown>;
        };
      }) => Promise<void>;
    };
  };
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  service: string;
  level: LogLevel;
  event: string;
  message: string;
  runId?: string;
  taskId?: string;
  iteration?: number;
  reasonCode?: string;
  extra?: Record<string, unknown>;
}

type LogMeta = {
  event?: string;
  runId?: string;
  taskId?: string;
  iteration?: number;
  reasonCode?: string;
};

export type LogEventPayload = {
  level: LogLevel;
  event: string;
  message: string;
  runId?: string;
  taskId?: string;
  iteration?: number;
  reasonCode?: string;
  extra?: Record<string, unknown>;
};

const LOG_FILE = "mario-devx.log";
const MAX_LOG_BYTES = 50 * 1024 * 1024;
const MAX_LOG_STRING_CHARS = 20_000;

const REDACT_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  /\bsk-[A-Za-z0-9]{10,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(AWS_SECRET_ACCESS_KEY\s*[=:]\s*)([^\s"']+)/gi,
  /(OPENAI_API_KEY\s*[=:]\s*)([^\s"']+)/gi,
  /(ANTHROPIC_API_KEY\s*[=:]\s*)([^\s"']+)/gi,
  /(Authorization\s*:\s*Bearer\s+)([^\s"']+)/gi,
];

export const redactForLog = (value: string): string => {
  let next = value;
  for (const pattern of REDACT_PATTERNS) {
    next = next.replace(pattern, (_full, prefix?: string) => {
      if (typeof prefix === "string") {
        return `${prefix}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return next;
};

export const coerceShellOutput = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("utf8");
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString("utf8");
  }
  try {
    return String(value);
  } catch {
    return "";
  }
};

const truncateForLog = (value: string): string => {
  if (value.length <= MAX_LOG_STRING_CHARS) return value;
  const omitted = value.length - MAX_LOG_STRING_CHARS;
  return `${value.slice(0, MAX_LOG_STRING_CHARS)}\n...[truncated ${omitted} chars]`;
};

const sanitizeExtra = (extra?: Record<string, unknown>): Record<string, unknown> => {
  if (!extra) return {};
  try {
    const normalized = JSON.parse(JSON.stringify(extra, (_key, value) => {
      if (typeof value === "string") {
        return truncateForLog(redactForLog(value));
      }
      return value;
    }));
    if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
      return normalized as Record<string, unknown>;
    }
    return { value: normalized };
  } catch {
    return { _loggingWarning: "extra was not serializable" };
  }
};

const centralLogPath = (repoRoot: string): string => path.join(marioStateDir(repoRoot), LOG_FILE);

const appendCentralLog = async (repoRoot: string, entry: LogEntry): Promise<void> => {
  try {
    const logDir = marioStateDir(repoRoot);
    await ensureDir(logDir);
    const filePath = centralLogPath(repoRoot);
    try {
      const info = await stat(filePath);
      if (info.size >= MAX_LOG_BYTES) {
        await writeFile(filePath, "", "utf8");
      }
    } catch {
      // File may not exist yet.
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    await appendFile(filePath, `${line}\n`, "utf8");
  } catch {
    // Best-effort sink; never block plugin flow.
  }
};

/**
 * Send structured log to OpenCode
 * Use for user-facing operational events
 */
export const structuredLog = async (
  ctx: LogContext,
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
  repoRoot?: string,
  meta?: LogMeta,
): Promise<void> => {
  const normalizedExtra = sanitizeExtra(extra);
  const eventFromExtra = typeof normalizedExtra.event === "string" ? String(normalizedExtra.event) : undefined;
  const entry: LogEntry = {
    service: "mario-devx",
    level,
    event: meta?.event ?? eventFromExtra ?? "general",
    message: redactForLog(message),
    ...(meta?.runId ? { runId: meta.runId } : {}),
    ...(meta?.taskId ? { taskId: meta.taskId } : {}),
    ...(typeof meta?.iteration === "number" ? { iteration: meta.iteration } : {}),
    ...(meta?.reasonCode ? { reasonCode: meta.reasonCode } : {}),
    extra: normalizedExtra,
  };

  if (repoRoot) {
    await appendCentralLog(repoRoot, entry);
  }

  try {
    // @ts-expect-error - client.app.log may not be in all OpenCode versions
    if (ctx.client?.app?.log) {
      // @ts-expect-error
      await ctx.client.app.log({
        body: {
          service: entry.service,
          level: entry.level,
          message: entry.message,
          extra: entry.extra,
        },
      });
    }
  } catch {
    // Fallback: if structured logging fails, it's not critical
    // The console logging in errors.ts will still capture it
  }
};

/**
 * Log task completion for user visibility
 */
export const logTaskComplete = async (
  ctx: LogContext,
  repoRoot: string,
  taskId: string,
  completed: number,
  total: number
): Promise<void> => {
  await structuredLog(ctx, "info", `Task ${taskId} completed`, {
    event: "task.completed",
    taskId,
    completed,
    total,
    status: "success",
  }, repoRoot, {
    event: "task.completed",
    taskId,
  });
};

/**
 * Log task blocked for user visibility
 */
export const logTaskBlocked = async (
  ctx: LogContext,
  repoRoot: string,
  taskId: string,
  reason: string
): Promise<void> => {
  await structuredLog(ctx, "warn", `Task ${taskId} blocked`, {
    event: "task.blocked",
    taskId,
    reason,
    status: "blocked",
  }, repoRoot, {
    event: "task.blocked",
    taskId,
  });
};

/**
 * Log PRD wizard completion
 */
export const logPrdComplete = async (
  ctx: LogContext,
  repoRoot: string,
  taskCount: number
): Promise<void> => {
  await structuredLog(ctx, "info", "PRD wizard completed", {
    event: "prd-complete",
    taskCount,
  }, repoRoot, {
    event: "prd.complete",
  });
};

/**
 * Log replanning results
 */
export const logReplanComplete = async (
  ctx: LogContext,
  repoRoot: string,
  itemsReplan: number,
  tasksGenerated: number
): Promise<void> => {
  await structuredLog(ctx, "info", "Replanning completed", {
    event: "replan-complete",
    itemsReplan,
    tasksGenerated,
  }, repoRoot, {
    event: "replan.complete",
  });
};

export const createRunId = (): string => {
  const iso = new Date().toISOString().replace(/[-:.]/g, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${iso}-${rand}`;
};

export const logEvent = async (
  ctx: LogContext,
  repoRoot: string,
  payload: LogEventPayload,
): Promise<void> => {
  await structuredLog(
    ctx,
    payload.level,
    payload.message,
    payload.extra,
    repoRoot,
    {
      event: payload.event,
      ...(payload.runId ? { runId: payload.runId } : {}),
      ...(payload.taskId ? { taskId: payload.taskId } : {}),
      ...(typeof payload.iteration === "number" ? { iteration: payload.iteration } : {}),
      ...(payload.reasonCode ? { reasonCode: payload.reasonCode } : {}),
    },
  );
};
