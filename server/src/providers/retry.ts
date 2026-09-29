/**
 * Bounded retry for transient provider failures.
 *
 * Free tiers return 429 and 503 routinely under load, and a single one of
 * those should not become a failed answer when waiting a second would have
 * worked. Only errors the provider itself marked retryable are retried, the
 * attempt count is small, and the caller's abort signal is honoured between
 * attempts so a disconnected client stops the whole thing.
 */
import { ProviderError } from './provider.errors.js';

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts: number;
  /** Delay before the second attempt; doubles each time. */
  baseDelayMs: number;
  /** Upper bound on any single delay. */
  maxDelayMs: number;
  signal?: AbortSignal | undefined;
  /** Called before each wait, for logging. */
  onRetry?: (attempt: number, delayMs: number, error: ProviderError) => void;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Full jitter, so several callers backing off do not retry in lockstep. */
function jitter(delay: number): number {
  return Math.round(delay * (0.5 + Math.random() * 0.5));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const attempts = Math.max(1, options.attempts);

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      const retryable = error instanceof ProviderError && error.retryable;
      const hasAttemptsLeft = attempt < attempts;
      if (!retryable || !hasAttemptsLeft || options.signal?.aborted) throw error;

      // A stalled call is retried like any other transient fault: the budget
      // for the whole question is the caller's signal, checked above, so a
      // timeout that used all of it has already stopped here.

      // A rate limit that names its wait: honour it, and if it is longer than
      // any wait we would make, hand it back to the caller now rather than
      // spending the question's budget (and more of the quota) waiting here.
      if (error.retryAfterMs !== undefined && error.retryAfterMs > options.maxDelayMs) throw error;

      const delay = Math.max(
        jitter(Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs)),
        error.retryAfterMs ?? 0,
      );
      options.onRetry?.(attempt, delay, error);
      await sleep(delay);
    }
  }

  throw lastError;
}
