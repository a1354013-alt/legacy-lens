/**
 * JSON field normalization utilities
 * 
 * Handles the case where MySQL driver may return JSON fields as either:
 * - parsed JavaScript objects/arrays
 * - stringified JSON (in some driver versions or configurations)
 * 
 * Use these helpers to ensure consistent contract across migrations, reads, and API responses.
 */

/**
 * Normalize a JSON array field value.
 * 
 * MySQL driver may return JSON array fields as:
 * - Already parsed: [] (Array)
 * - As string: "[]" (string)
 * - As null: null
 * 
 * @param value Raw value from database
 * @param fallback Default value if parsing fails (default: [])
 * @returns Normalized array value
 */
export function normalizeJsonArrayField<T = unknown>(value: unknown, fallback: T[] = []): T[] {
  // Already an array
  if (Array.isArray(value)) {
    return value;
  }

  // Null or undefined
  if (value === null || value === undefined) {
    return fallback;
  }

  // String representation
  if (typeof value === "string") {
    if (value.trim() === "") {
      return fallback;
    }
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      // Invalid JSON string - return fallback
      console.warn(`[jsonNormalization] Failed to parse JSON string: ${value}`, error);
      return fallback;
    }
  }

  // Unknown type - return fallback
  console.warn(`[jsonNormalization] Unexpected JSON field type: ${typeof value}`, value);
  return fallback;
}

/**
 * Normalize a JSON object field value.
 * 
 * @param value Raw value from database
 * @param fallback Default value if parsing fails (default: {})
 * @returns Normalized object value
 */
export function normalizeJsonObjectField<T extends Record<string, unknown> = Record<string, unknown>>(
  value: unknown,
  fallback: T = {} as T
): T {
  // Already an object
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as T;
  }

  // Null or undefined
  if (value === null || value === undefined) {
    return fallback;
  }

  // String representation
  if (typeof value === "string") {
    if (value.trim() === "") {
      return fallback;
    }
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as T;
      }
    } catch (error) {
      // Invalid JSON string - return fallback
      console.warn(`[jsonNormalization] Failed to parse JSON string: ${value}`, error);
      return fallback;
    }
  }

  // Unknown type - return fallback
  console.warn(`[jsonNormalization] Unexpected JSON field type: ${typeof value}`, value);
  return fallback;
}
