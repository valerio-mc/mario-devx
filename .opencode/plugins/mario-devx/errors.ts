/**
 * Error Handling Utilities
 * 
 * Standardized error handling across mario-devx.
 * All errors use structured format with codes for programmatic handling.
 * 
 * NOTE: This module uses console.log/error/warn which is acceptable for
 * plugin internal logging. Per OpenCode best practices, client.app.log()
 * should only be used in the main plugin function where the client is
 * available. Internal utility functions can use console for simplicity.
 * 
 * See: https://opencode.ai/docs/plugins/#logging
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

export const logError = (context: string, error: unknown): void => {
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
  console.warn(`[mario-devx] ${context}: ${message}`);
};

export const logInfo = (context: string, message: string): void => {
  console.log(`[mario-devx] ${context}: ${message}`);
};
