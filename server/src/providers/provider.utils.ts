/**
 * Helpers shared by the provider adapters: response parsing and timeouts.
 */
import { ProviderError } from './provider.errors.js';
import { providerAnswerSchema } from '../question/question.schema.js';
import type { ProviderAnswer } from '../question/question.schema.js';

/** Strip a ```json fence, which some models add even when asked not to. */
function unfence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

/**
 * Find the outermost JSON object in a string.
 * Used only as a fallback for endpoints without native JSON output; the first
 * `{` to its matching `}` is enough for the single flat object we ask for.
 */
function extractObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** Validate a parsed value against the answer contract. */
export function validateAnswer(value: unknown, provider: string): ProviderAnswer {
  const parsed = providerAnswerSchema.safeParse(value);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'answer'}: ${issue.message}`)
      .join('; ');
    throw new ProviderError(
      'invalid_response',
      provider,
      `The model returned an answer that did not match the expected shape (${summary}).`,
    );
  }
  return parsed.data;
}

/** Parse and validate a JSON answer returned as text. */
export function parseAnswerText(text: string | null | undefined, provider: string): ProviderAnswer {
  if (!text || !text.trim()) {
    throw new ProviderError('invalid_response', provider, 'The model returned an empty response.');
  }

  const candidate = unfence(text).trim();
  const attempts = [candidate, extractObject(candidate)].filter(
    (value): value is string => typeof value === 'string',
  );

  for (const attempt of attempts) {
    try {
      return validateAnswer(JSON.parse(attempt), provider);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // Not valid JSON - fall through to the next attempt.
    }
  }

  throw new ProviderError(
    'invalid_response',
    provider,
    'The model returned a response that was not valid JSON.',
  );
}

/**
 * Combine a caller's abort signal with a deadline of our own, so a provider
 * that stops responding cannot hold an Express request open indefinitely.
 */
export function withDeadline(
  timeoutMs: number,
  signal?: AbortSignal,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let expired = false;

  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);

  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward, { once: true });
  if (signal?.aborted) controller.abort();

  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    },
  };
}
