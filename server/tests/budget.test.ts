/**
 * Stalled provider calls: cut per attempt, retried, and bounded overall.
 *
 * Measured on Gemini's free tier: in a burst of ten questions a third of the
 * calls hung until the 45s timeout while the rest answered in ~1.5s, and the
 * extension gave up at 30s - so those questions came back a minute late.
 */
import { describe, expect, it } from 'vitest';
import { QuestionService } from '../src/question/question.service.js';
import { NullAnswerStore } from '../src/cache/answer-cache.js';
import { ProviderError } from '../src/providers/provider.errors.js';
import { withDeadline } from '../src/providers/provider.utils.js';
import type { AIProvider } from '../src/providers/ai-provider.interface.js';
import type { QuestionAnswer, QuestionRequest } from '../src/question/question.schema.js';
import { StubRegistry, VALID_QUESTION, answerFor } from './helpers.js';

const REQUEST: QuestionRequest = { ...VALID_QUESTION, type: 'multiple_choice' };

/** Behaves like a real adapter: its own per-call timeout, and it honours the signal. */
class StallingProvider implements AIProvider {
  calls = 0;

  constructor(
    private readonly attemptTimeoutMs: number,
    /** Calls (1-based) that hang instead of answering. */
    private readonly stallOn: (call: number) => boolean,
  ) {}

  getName(): string {
    return 'gemini';
  }

  getModel(): string {
    return 'gemini-3.5-flash-lite';
  }

  answerQuestion(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionAnswer> {
    this.calls += 1;
    if (!this.stallOn(this.calls)) return Promise.resolve(answerFor(request));

    const deadline = withDeadline(this.attemptTimeoutMs, signal);
    return new Promise((_resolve, reject) => {
      deadline.signal.addEventListener('abort', () => {
        deadline.dispose();
        reject(new ProviderError('timeout', 'gemini', 'Gemini did not respond in time.'));
      });
    });
  }
}

function service(provider: AIProvider, budgetMs?: number): QuestionService {
  return new QuestionService(new StubRegistry(provider), new NullAnswerStore(), {
    maxAttempts: 3,
    baseRetryDelayMs: 0,
    ...(budgetMs === undefined ? {} : { budgetMs }),
  });
}

describe('stalled provider calls', () => {
  it('cuts a stalled call and answers from the retry', async () => {
    const provider = new StallingProvider(50, (call) => call === 1);
    const started = Date.now();

    const { answer } = await service(provider, 2_000).answer(REQUEST);

    expect(answer.answer).toBe('O(log n)');
    expect(provider.calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stops at the question budget even when every call stalls', async () => {
    // Per-call timeout longer than the budget: only the budget can stop it.
    const provider = new StallingProvider(10_000, () => true);
    const started = Date.now();

    await expect(service(provider, 150).answer(REQUEST)).rejects.toMatchObject({ code: 'timeout' });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(provider.calls).toBe(1);
  });

  it('gives up after the attempt limit when stalls keep happening', async () => {
    const provider = new StallingProvider(30, () => true);

    await expect(service(provider, 5_000).answer(REQUEST)).rejects.toMatchObject({ code: 'timeout' });
    expect(provider.calls).toBe(3);
  });
});
