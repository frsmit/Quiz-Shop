/**
 * One error vocabulary for every provider.
 *
 * Each adapter translates its SDK's exceptions into a `ProviderError` so the
 * controller can answer with a consistent status and the client never has to
 * know which vendor was behind the call.
 */

export type ProviderErrorCode =
  | 'missing_credentials'
  | 'authentication'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'invalid_response'
  | 'bad_request'
  | 'unknown';

const STATUS_BY_CODE: Record<ProviderErrorCode, number> = {
  missing_credentials: 503,
  authentication: 502,
  rate_limited: 429,
  timeout: 504,
  unavailable: 503,
  invalid_response: 502,
  bad_request: 400,
  unknown: 502,
};

/** Codes where retrying the same request later could plausibly succeed. */
const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set([
  'rate_limited',
  'timeout',
  'unavailable',
]);

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly status: number;
  readonly retryable: boolean;
  /** How long the provider asked us to wait before trying again, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ProviderErrorCode,
    provider: string,
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number | undefined },
  ) {
    super(message, options);
    this.name = 'ProviderError';
    this.code = code;
    this.provider = provider;
    this.status = STATUS_BY_CODE[code];
    this.retryable = RETRYABLE.has(code);
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * The wait a provider asked for on a rate limit, from whichever form it used:
 * a `Retry-After` header (OpenAI, Anthropic) or Google's RetryInfo, which the
 * Gemini SDK only surfaces inside the message text ("retryDelay":"23s",
 * "Please retry in 23.2s").
 */
export function retryAfterOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const headers = (error as { headers?: unknown }).headers;
  const header =
    headers && typeof (headers as Headers).get === 'function'
      ? (headers as Headers).get('retry-after')
      : (headers as Record<string, unknown> | undefined)?.['retry-after'];
  const seconds = Number(header);
  if (header !== undefined && header !== null && Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const text = error instanceof Error ? error.message : '';
  // The structured RetryInfo field first; the sentence is the fallback.
  const value =
    /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text)?.[1] ??
    /retry in (\d+(?:\.\d+)?)\s*s/i.exec(text)?.[1];
  return value === undefined ? undefined : Math.ceil(Number(value) * 1000);
}

/**
 * Map an HTTP status from any provider onto our vocabulary.
 * The SDKs expose `status` on their error objects with the same meanings.
 */
export function codeForStatus(status: number | undefined): ProviderErrorCode {
  if (status === undefined) return 'unknown';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 529 || status === 503) return 'unavailable';
  if (status >= 500) return 'unavailable';
  return 'unknown';
}

/** Best-effort status extraction from an unknown SDK error. */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  return undefined;
}

/** True when the failure is an abort caused by our own timeout. */
export function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR';
}

export function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
