/**
 * Error Handling Utilities
 *
 * Console logging is disabled by default to avoid polluting the OpenCode TUI.
 * Set MARIO_DEVX_DEBUG=1 to emit verbose console diagnostics when needed.
 */

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

export const logError = (context: string, error: unknown): void => {
  if (!shouldLogToConsole()) return;
  if (error instanceof MarioErrorClass) {
    console.error(`[mario-devx] ${context}: [${error.code}] ${error.message}`);
    if (error.details) {
      console.error(`[mario-devx] ${context} details:`, error.details);
    }
  } else if (error instanceof Error) {
    console.error(`[mario-devx] ${context}: ${error.message}`);
    if (error.stack) {
      console.error(`[mario-devx] ${context} stack:`, error.stack);
    }
  } else {
    console.error(`[mario-devx] ${context}:`, String(error));
  }
};

export const logWarning = (context: string, message: string): void => {
  if (!shouldLogToConsole()) return;
  console.warn(`[mario-devx] ${context}: ${message}`);
};

export const logInfo = (context: string, message: string): void => {
  if (!shouldLogToConsole()) return;
  console.log(`[mario-devx] ${context}: ${message}`);
};
