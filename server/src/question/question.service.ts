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
import type { ClientCredentials } from '../providers/ai-provider.interface.js';
import type { ProviderId, QuestionAnswer, QuestionRequest } from './question.schema.js';
import { withRetry } from '../providers/retry.js';
import { withDeadline } from '../providers/provider.utils.js';
import { getLogger } from '../config/logger.js';

export interface AnswerResult {
  answer: QuestionAnswer;
  cached: boolean;
}

export interface ProbeResult {
  provider: string;
  model: string;
  answer: string;
  latencyMs: number;
}

/** Small enough to cost almost nothing, and with one unarguable answer. */
const PROBE_QUESTION: QuestionRequest = {
  question: 'What is 2 + 2?',
  type: 'multiple_choice',
  options: ['3', '4', '5', '22'],
};

export interface QuestionServiceOptions {
  /** Attempts per question, including the first. */
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  /**
   * Time allowed for one question across every attempt. Past it, the call in
   * progress is aborted and no further attempt starts. Omitted means only the
   * per-call timeout applies.
   */
  budgetMs?: number;
  /** Where answered questions are recorded; omitted means nowhere. */
  history?: HistoryStore;
  now?: () => number;
}

export class QuestionService {
  /** Identical questions arriving together share one provider call. */
  private readonly inFlight = new Map<string, Promise<QuestionAnswer>>();
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly budgetMs: number | undefined;
  private readonly history: HistoryStore | undefined;
  private readonly now: () => number;

  constructor(
    private readonly factory: ProviderRegistry,
    private readonly store: AnswerStore,
    options: QuestionServiceOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.budgetMs = options.budgetMs;
    this.history = options.history;
    this.now = options.now ?? Date.now;
  }

  /**
   * `credentials` is the caller's own provider key, for this request only.
   * It reaches the adapter and nothing else: the cache key and the history
   * record name the provider and model, never the key.
   */
  async answer(
    request: QuestionRequest,
    signal?: AbortSignal,
    credentials?: ClientCredentials,
  ): Promise<AnswerResult> {
    const startedAt = this.now();
    const result = await this.resolve(request, signal, credentials);
    this.record(request, result, this.now() - startedAt);
    return result;
  }

  private async resolve(
    request: QuestionRequest,
    signal?: AbortSignal,
    credentials?: ClientCredentials,
  ): Promise<AnswerResult> {
    const provider = this.factory.create(request.provider, request.model, credentials);
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

    // One deadline for the whole question, so a stalled call can be cut and
    // retried without the retries outlasting the client that is waiting.
    const budget = this.budgetMs === undefined ? undefined : withDeadline(this.budgetMs, signal);
    const scoped = budget?.signal ?? signal;

    const work = withRetry(() => provider.answerQuestion(request, scoped), {
      attempts: this.maxAttempts,
      baseDelayMs: this.baseRetryDelayMs,
      maxDelayMs: 8_000,
      signal: scoped,
      onRetry: (attempt, delayMs, error) => {
        getLogger().warn(
          { provider: provider.getName(), code: error.code, attempt, delayMs },
          'Retrying a transient provider failure',
        );
      },
    })
      .then(async (raw) => {
        const answer = alignAnswer(raw, request);
        await this.store.set(key, answer).catch((error: unknown) => {
          getLogger().warn({ err: error }, 'Answer cache write failed');
        });
        return answer;
      })
      .finally(() => {
        budget?.dispose();
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, work);
    return { answer: await work, cached: false };
  }

  clearCache(): Promise<void> {
    return this.store.clear();
  }

  /**
   * Ask a provider one fixed question, bypassing the cache, the retries and
   * the history - so a key or model can be tried out from the settings page
   * before any page question depends on it. Failures propagate as the same
   * `ProviderError`s a real question would raise.
   */
  async probe(
    target: { provider?: ProviderId | undefined; model?: string | undefined },
    signal?: AbortSignal,
    credentials?: ClientCredentials,
  ): Promise<ProbeResult> {
    const provider = this.factory.create(target.provider, target.model, credentials);
    const budget = this.budgetMs === undefined ? undefined : withDeadline(this.budgetMs, signal);
    const startedAt = this.now();
    try {
      const raw = await provider.answerQuestion(PROBE_QUESTION, budget?.signal ?? signal);
      return {
        provider: provider.getName(),
        model: raw.model || provider.getModel(),
        answer: alignAnswer(raw, PROBE_QUESTION).answer,
        latencyMs: this.now() - startedAt,
      };
    } finally {
      budget?.dispose();
    }
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
    // Appended only when set, so every single-answer key is unchanged.
    ...(request.multiSelect ? ['multi-select'] : []),
  ].join('\u0001');

  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** `B. on`, `(b) on`, `B) on`, `B: on` - the label the prompt put on the option. */
const LABELLED_ANSWER = /^\(?([a-z])\s*[).:\]]\s*(.+)$/is;

/**
 * The prompt shows options as `A. …`, `B. …`, and some models copy the label
 * into the answer despite being told to give the option text verbatim
 * (Gemini returns `B. on` for the option `on`). The contract is "the exact
 * text of an option", so a label is stripped here - but only when the text
 * after it is an option, so a real answer that happens to start `a.` is left
 * alone. When label and text disagree, the text wins: it is what the model
 * actually wrote out.
 */
export function alignToOption(answer: QuestionAnswer, options: readonly string[] | undefined): QuestionAnswer {
  if (!options?.length) return answer;
  const aligned = alignText(answer.answer, options);
  return aligned === undefined ? answer : { ...answer, answer: aligned };
}

/** The option `text` names, by its exact text or its label; undefined if none. */
function alignText(text: string, options: readonly string[]): string | undefined {
  const trimmed = text.trim();
  if (options.includes(trimmed)) return trimmed;

  const exact = options.find((option) => normalize(option) === normalize(trimmed));
  if (exact !== undefined) return exact;

  const labelled = LABELLED_ANSWER.exec(trimmed);
  if (!labelled?.[2]) return undefined;
  return options.find((candidate) => normalize(candidate) === normalize(labelled[2] as string));
}

/**
 * Bring a provider's answer into the contract for this request.
 *
 * `answers` is kept only for a multi-select question, where it is the list
 * the extension ticks - each entry aligned to an option the same way
 * `answer` is. A model that left the list empty is read from `answer`
 * instead, split on the "; " the prompt asked it to join with. Elsewhere the
 * list would only repeat `answer`, so it is dropped.
 */
export function alignAnswer(raw: QuestionAnswer, request: QuestionRequest): QuestionAnswer {
  const { answers, ...single } = raw;
  const options = request.options;
  if (!request.multiSelect || !options?.length) return alignToOption(single, options);

  const listed = answers?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  const source = listed.length > 0 ? listed : raw.answer.split(/\s*;\s*|\n+/).filter(Boolean);
  const picked = [...new Set(source.map((entry) => alignText(entry, options) ?? entry))];
  if (picked.length === 0) return alignToOption(single, options);

  return { ...single, answer: picked.join('; '), answers: picked };
}
