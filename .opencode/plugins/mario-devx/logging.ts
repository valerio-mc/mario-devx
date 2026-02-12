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
  message: string;
  extra?: Record<string, unknown>;
}

const LOG_FILE = "mario-devx.log";
const MAX_LOG_BYTES = 50 * 1024 * 1024;

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
): Promise<void> => {
  const entry: LogEntry = {
    service: "mario-devx",
    level,
    message,
    extra: extra ?? {},
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
  }, repoRoot);
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
  }, repoRoot);
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
  }, repoRoot);
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
  }, repoRoot);
};
