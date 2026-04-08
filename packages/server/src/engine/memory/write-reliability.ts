export type RetryableWriteFailureCode = "TIMEOUT" | "TEMPORARY_UNAVAILABLE";

export type RetryableWriteFailure = {
  status: number;
  code: RetryableWriteFailureCode;
  message: string;
  retryable: boolean;
};

const RETRYABLE_ERROR_SNIPPETS = [
  "econnreset",
  "econnrefused",
  "etimedout",
  "timed out",
  "timeout",
  "abort",
  "connection",
  "connect",
  "socket",
  "terminated",
  "temporarily unavailable",
  "temporary unavailable",
  "too many connections",
  "too many clients",
  "could not serialize access",
  "deadlock detected",
  "remaining connection slots are reserved",
  "rate limit",
  "429",
  "502",
  "503",
  "504",
  "p1001",
  "p1002",
  "p1008",
  "can't reach database server",
  "database server was reached but timed out",
  "operations timed out",
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Write failed");
}

export function isRetryableWriteFailure(error: unknown): boolean {
  const normalized = errorMessage(error).toLowerCase();
  return RETRYABLE_ERROR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

export function classifyRetryableWriteFailure(error: unknown): RetryableWriteFailure {
  const normalized = errorMessage(error).toLowerCase();
  const timeout =
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("abort") ||
    normalized.includes("etimedout") ||
    normalized.includes("p1002") ||
    normalized.includes("p1008");

  return {
    status: timeout ? 504 : 503,
    code: timeout ? "TIMEOUT" : "TEMPORARY_UNAVAILABLE",
    message: timeout ? "Memory write timed out before commit" : "Memory write could not be committed",
    retryable: isRetryableWriteFailure(error),
  };
}

export function getRetryDelayMs(attempt: number, baseDelayMs = 500, maxDelayMs = 30_000): number {
  const safeAttempt = Math.max(1, attempt);
  return Math.min(maxDelayMs, baseDelayMs * Math.pow(2, safeAttempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetryableWriteRetries<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    label?: string;
    logger?: Pick<Console, "warn">;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 5,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    label = "MemoryWrite",
    logger = console,
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const retryable = isRetryableWriteFailure(error);
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }

      const delayMs = getRetryDelayMs(attempt, baseDelayMs, maxDelayMs);
      logger.warn(
        `[${label}] transient failure on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms:`,
        error instanceof Error ? error.message : String(error)
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`${label} exhausted retry attempts`);
}
