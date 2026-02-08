/**
 * Error Handling Utilities
 * 
 * Standardized error handling across mario-devx.
 * All errors use structured format with codes for programmatic handling.
 */

import type { MarioError } from "./types-extended";

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

export const createError = (code: string, message: string, details?: unknown): MarioError => ({
  code,
  message,
  details,
});

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

export const handleAsyncError = async <T>(
  operation: () => Promise<T>,
  context: string,
  errorCode: string,
  defaultValue?: T
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    logError(context, error);
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new MarioErrorClass(errorCode, `Failed in ${context}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
};

export const safelyParseJSON = <T>(json: string, context: string): T | null => {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    logError(context, createError("JSON_PARSE_ERROR", "Failed to parse JSON", { json: json.substring(0, 200), error }));
    return null;
  }
};
