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

import type { PluginContext } from "./types-extended";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  service: string;
  level: LogLevel;
  message: string;
  extra?: Record<string, unknown>;
}

/**
 * Send structured log to OpenCode
 * Use for user-facing operational events
 */
export const structuredLog = async (
  ctx: PluginContext,
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>
): Promise<void> => {
  try {
    // @ts-expect-error - client.app.log may not be in all OpenCode versions
    if (ctx.client?.app?.log) {
      // @ts-expect-error
      await ctx.client.app.log({
        body: {
          service: "mario-devx",
          level,
          message,
          extra: extra ?? {},
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
  ctx: PluginContext,
  taskId: string,
  completed: number,
  total: number
): Promise<void> => {
  await structuredLog(ctx, "info", `Task ${taskId} completed`, {
    taskId,
    completed,
    total,
    status: "success",
  });
};

/**
 * Log task blocked for user visibility
 */
export const logTaskBlocked = async (
  ctx: PluginContext,
  taskId: string,
  reason: string
): Promise<void> => {
  await structuredLog(ctx, "warn", `Task ${taskId} blocked`, {
    taskId,
    reason,
    status: "blocked",
  });
};

/**
 * Log PRD wizard completion
 */
export const logPrdComplete = async (
  ctx: PluginContext,
  taskCount: number
): Promise<void> => {
  await structuredLog(ctx, "info", "PRD wizard completed", {
    event: "prd-complete",
    taskCount,
  });
};

/**
 * Log replanning results
 */
export const logReplanComplete = async (
  ctx: PluginContext,
  itemsReplan: number,
  tasksGenerated: number
): Promise<void> => {
  await structuredLog(ctx, "info", "Replanning completed", {
    event: "replan-complete",
    itemsReplan,
    tasksGenerated,
  });
};
