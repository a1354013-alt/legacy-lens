/**
 * Retry utility with exponential backoff
 * For long-running tasks that may fail transiently
 */

export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Initial delay in milliseconds */
  initialDelayMs: number;
  /** Maximum delay between retries */
  maxDelayMs: number;
  /** Backoff multiplier (e.g., 2 = exponential) */
  backoffMultiplier: number;
  /** Which errors should trigger retry */
  shouldRetry?: (error: Error) => boolean;
  /** Callback called before each retry */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  shouldRetry: () => true, // Retry all errors by default
};

/**
 * Execute a function with retry logic and exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    backoffMultiplier,
    shouldRetry,
    onRetry,
  } = { ...DEFAULT_OPTIONS, ...options };

  let lastError: Error | undefined;
  let delayMs = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry if shouldRetry returns false
      if (shouldRetry && !shouldRetry(lastError)) {
        throw lastError;
      }

      // Don't wait after the last attempt
      if (attempt < maxAttempts) {
        onRetry?.(attempt, lastError, delayMs);
        
        // Wait with exponential backoff
        await new Promise(resolve => setTimeout(resolve, delayMs));
        
        // Increase delay for next attempt (capped at maxDelayMs)
        delayMs = Math.min(delayMs * backoffMultiplier, maxDelayMs);
      }
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError || new Error("Retry failed");
}

/**
 * Create a retryable version of a function
 */
export function createRetryableFunction<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options: Partial<RetryOptions> = {}
): T {
  return (async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    return withRetry(() => fn(...args), options);
  }) as T;
}

/**
 * Default retry strategies for common scenarios
 */
export const retryStrategies = {
  /** Conservative: 3 attempts, start at 1s, max 30s */
  conservative: {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
  },
  
  /** Aggressive: 5 attempts, start at 500ms, max 10s */
  aggressive: {
    maxAttempts: 5,
    initialDelayMs: 500,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
  },
  
  /** Quick: 2 attempts, start at 100ms, max 1s */
  quick: {
    maxAttempts: 2,
    initialDelayMs: 100,
    maxDelayMs: 1000,
    backoffMultiplier: 2,
  },
  
  /** Database operations: 3 attempts, start at 500ms, max 15s */
  database: {
    maxAttempts: 3,
    initialDelayMs: 500,
    maxDelayMs: 15000,
    backoffMultiplier: 2,
    shouldRetry: (error: Error) => {
      // Don't retry constraint violations or syntax errors
      const nonRetryablePatterns = [
        /duplicate key/i,
        /foreign key/i,
        /syntax error/i,
        /constraint violation/i,
      ];
      return !nonRetryablePatterns.some(pattern => pattern.test(error.message));
    },
  },
  
  /** HTTP requests: 4 attempts, start at 1s, max 20s */
  http: {
    maxAttempts: 4,
    initialDelayMs: 1000,
    maxDelayMs: 20000,
    backoffMultiplier: 2,
    shouldRetry: (error: Error) => {
      // Retry network errors and 5xx responses
      const retryablePatterns = [
        /ETIMEDOUT/i,
        /ECONNREFUSED/i,
        /ECONNRESET/i,
        /ENOTFOUND/i,
        /5\d{2}/,
      ];
      return retryablePatterns.some(pattern => pattern.test(error.message));
    },
  },
} as const;
