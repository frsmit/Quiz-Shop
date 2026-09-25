/**
 * The question service: cache lookup, provider dispatch, request coalescing.
 *
 * It is the only place that knows a cache exists, and the only place that
 * turns a `ProviderId` into a live adapter, which keeps the controller thin
 * and the providers ignorant of each other.
 */
import { createHash } from 'node:crypto';
import type { AnswerStore } from '../cache/answer-cache.js';
import type { HistoryStore } from '../history/history-store.js';
import type { ProviderRegistry } from '../providers/provider.factory.js';
import type { QuestionAnswer, QuestionRequest } from './question.schema.js';
import { withRetry } from '../providers/retry.js';
import { getLogger } from '../config/logger.js';

export interface AnswerResult {
  answer: QuestionAnswer;
  cached: boolean;
}

export interface QuestionServiceOptions {
  /** Attempts per question, including the first. */
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  /** Where answered questions are recorded; omitted means nowhere. */
  history?: HistoryStore;
  now?: () => number;
}

export class QuestionService {
  /** Identical questions arriving together share one provider call. */
  private readonly inFlight = new Map<string, Promise<QuestionAnswer>>();
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly history: HistoryStore | undefined;
  private readonly now: () => number;

  constructor(
    private readonly factory: ProviderRegistry,
    private readonly store: AnswerStore,
    options: QuestionServiceOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.history = options.history;
    this.now = options.now ?? Date.now;
  }

  async answer(request: QuestionRequest, signal?: AbortSignal): Promise<AnswerResult> {
    const startedAt = this.now();
    const result = await this.resolve(request, signal);
    this.record(request, result, this.now() - startedAt);
    return result;
  }

  private async resolve(request: QuestionRequest, signal?: AbortSignal): Promise<AnswerResult> {
    const provider = this.factory.create(request.provider, request.model);
    const key = cacheKey(provider.getName(), provider.getModel(), request);

    // A cache that is down (a MongoDB blip, say) costs a provider call, not
    // the answer.
    const hit = await this.store.get(key).catch((error: unknown) => {
      getLogger().warn({ err: error }, 'Answer cache read failed; asking the provider');
      return undefined;
    });
    if (hit) return { answer: hit, cached: true };

    const pending = this.inFlight.get(key);
    if (pending) return { answer: await pending, cached: false };

    const work = withRetry(() => provider.answerQuestion(request, signal), {
      attempts: this.maxAttempts,
      baseDelayMs: this.baseRetryDelayMs,
      maxDelayMs: 8_000,
      signal,
      onRetry: (attempt, delayMs, error) => {
        getLogger().warn(
          { provider: provider.getName(), code: error.code, attempt, delayMs },
          'Retrying a transient provider failure',
        );
      },
    })
      .then(async (answer) => {
        await this.store.set(key, answer).catch((error: unknown) => {
          getLogger().warn({ err: error }, 'Answer cache write failed');
        });
        return answer;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, work);
    return { answer: await work, cached: false };
  }

  clearCache(): Promise<void> {
    return this.store.clear();
  }

  /** Fire and forget: history is a record, and never delays or fails an answer. */
  private record(request: QuestionRequest, result: AnswerResult, latencyMs: number): void {
    if (!this.history?.enabled) return;
    this.history
      .record({ request, answer: result.answer, cached: result.cached, latencyMs })
      .catch((error: unknown) => {
        getLogger().warn({ err: error }, 'Could not record question history');
      });
  }
}

/**
 * A stable key over the content that changes the answer.
 * The source URL and page title are deliberately excluded, so the same
 * question on two different pages is one cache entry.
 */
export function cacheKey(provider: string, model: string, request: QuestionRequest): string {
  const canonical = [
    provider,
    model,
    request.type,
    normalize(request.question),
    ...(request.options ?? []).map(normalize),
    normalize(request.context ?? ''),
  ].join('\u0001');

  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}
