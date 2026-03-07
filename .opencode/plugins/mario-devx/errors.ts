/**
 * Error Handling Utilities
 *
 * Console logging is disabled by default to avoid polluting the OpenCode TUI.
 * Set MARIO_DEVX_DEBUG=1 to emit verbose console diagnostics when needed.
 */

import { redactForLog } from "./logging";

type MarioError = {
  code: string;
  message: string;
  details?: unknown;
};

export class MarioErrorClass extends Error implements MarioError {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "MarioError";
    this.code = code;
    this.details = details;
  }
}

const shouldLogToConsole = (): boolean => process.env.MARIO_DEVX_DEBUG === "1";

const toSafeLogString = (value: unknown): string => {
  if (typeof value === "string") {
    return redactForLog(value);
  }
  if (value instanceof Error) {
    return redactForLog(value.message);
  }
  try {
    return redactForLog(JSON.stringify(value));
  } catch {
    return redactForLog(String(value));
  }
};

export const logError = (context: string, error: unknown): void => {
  if (!shouldLogToConsole()) return;
  if (error instanceof MarioErrorClass) {
    console.error(`[mario-devx] ${context}: [${error.code}] ${toSafeLogString(error.message)}`);
    if (error.details) {
      console.error(`[mario-devx] ${context} details:`, toSafeLogString(error.details));
    }
  } else if (error instanceof Error) {
    console.error(`[mario-devx] ${context}: ${toSafeLogString(error.message)}`);
    if (error.stack) {
      console.error(`[mario-devx] ${context} stack:`, toSafeLogString(error.stack));
    }
  } else {
    console.error(`[mario-devx] ${context}:`, toSafeLogString(error));
  }
};

export const logWarning = (context: string, message: string): void => {
  if (!shouldLogToConsole()) return;
  console.warn(`[mario-devx] ${context}: ${toSafeLogString(message)}`);
};

export const logInfo = (context: string, message: string): void => {
  if (!shouldLogToConsole()) return;
  console.log(`[mario-devx] ${context}: ${toSafeLogString(message)}`);
};
