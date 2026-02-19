type UnknownRecord = Record<string, unknown>;

const isObject = (value: unknown): value is UnknownRecord => {
  return typeof value === "object" && value !== null;
};

/**
 * OpenCode SDK returns either raw payloads or field-style wrappers:
 * { data, request, response }.
 */
export const unwrapSdkData = <T>(value: unknown): T | null => {
  if (!isObject(value)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(value, "data")) {
    const wrapped = value as { data?: unknown };
    return (wrapped.data ?? null) as T | null;
  }
  return value as T;
};
