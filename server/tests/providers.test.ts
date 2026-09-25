/**
 * Provider adapter tests.
 *
 * The SDKs are exercised for real against a stubbed `fetch`, rather than
 * mocked away, so the tests cover the part most likely to break: how each
 * SDK's own error types are translated into our error vocabulary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/providers/anthropic.provider.js';
import { GEMINI_DEFAULT_MODEL, GeminiProvider } from '../src/providers/gemini.provider.js';
import { OpenAIProvider } from '../src/providers/openai.provider.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.provider.js';
import { ProviderFactory } from '../src/providers/provider.factory.js';
import { ProviderError } from '../src/providers/provider.errors.js';
import { parseAnswerText } from '../src/providers/provider.utils.js';
import { loadEnv } from '../src/config/env.js';
import type { QuestionRequest } from '../src/question/question.schema.js';

const QUESTION: QuestionRequest = {
  question: 'What is the time complexity of binary search?',
  type: 'multiple_choice',
  options: ['O(n)', 'O(log n)'],
};

const ANSWER_JSON = JSON.stringify({
  answer: 'O(log n)',
  explanation: 'Binary search halves the remaining range each step.',
  confidence: 0.96,
  reasoningSummary: 'Standard complexity result.',
});

const CONTEXT = { model: undefined, timeoutMs: 5_000 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function chatCompletion(content: string, finishReason = 'stop'): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function stubFetch(handler: (input: unknown, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(handler));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseAnswerText', () => {
  it('accepts a plain JSON object', () => {
    expect(parseAnswerText(ANSWER_JSON, 'test').answer).toBe('O(log n)');
  });

  it('accepts JSON inside a fenced code block', () => {
    expect(parseAnswerText('```json\n' + ANSWER_JSON + '\n```', 'test').answer).toBe('O(log n)');
  });

  it('accepts JSON surrounded by chatter', () => {
    const text = `Sure, here you go:\n${ANSWER_JSON}\nHope that helps!`;
    expect(parseAnswerText(text, 'test').answer).toBe('O(log n)');
  });

  it('rejects an empty response', () => {
    expect(() => parseAnswerText('', 'test')).toThrow(ProviderError);
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseAnswerText('The answer is O(log n).', 'test')).toThrow(/not valid JSON/);
  });

  it('rejects JSON that is missing a required field', () => {
    expect(() => parseAnswerText('{"answer":"O(log n)"}', 'test')).toThrow(/did not match/);
  });

  it('rejects a confidence outside 0..1', () => {
    const bad = JSON.stringify({ answer: 'a', explanation: 'b', confidence: 4 });
    expect(() => parseAnswerText(bad, 'test')).toThrow(/did not match/);
  });
});

describe('OpenAIProvider', () => {
  it('returns a structured answer on success', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(chatCompletion(ANSWER_JSON))));

    const answer = await new OpenAIProvider('sk-test', CONTEXT).answerQuestion(QUESTION);

    expect(answer).toMatchObject({
      answer: 'O(log n)',
      provider: 'openai',
      model: 'gpt-4o-mini',
      confidence: 0.96,
    });
  });

  it('sends the question and options to the model', async () => {
    const calls: string[] = [];
    stubFetch((_input, init) => {
      calls.push(String(init?.body ?? ''));
      return Promise.resolve(jsonResponse(chatCompletion(ANSWER_JSON)));
    });

    await new OpenAIProvider('sk-test', CONTEXT).answerQuestion(QUESTION);

    expect(calls[0]).toContain('binary search');
    expect(calls[0]).toContain('O(log n)');
    expect(calls[0]).toContain('json_schema');
  });

  it('maps 401 to an authentication error', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ error: { message: 'bad key' } }, 401)));

    await expect(new OpenAIProvider('sk-test', CONTEXT).answerQuestion(QUESTION)).rejects.toMatchObject(
      { code: 'authentication', provider: 'openai', status: 502 },
    );
  });

  it('maps 429 to a retryable rate-limit error', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ error: { message: 'slow down' } }, 429)));

    await expect(
      new OpenAIProvider('sk-test', { ...CONTEXT, timeoutMs: 2_000 }).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('maps 500 to an unavailable error', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ error: { message: 'boom' } }, 500)));

    await expect(
      new OpenAIProvider('sk-test', { ...CONTEXT, timeoutMs: 2_000 }).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('reports a connection failure as unavailable', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));

    await expect(
      new OpenAIProvider('sk-test', { ...CONTEXT, timeoutMs: 2_000 }).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects a malformed model response', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(chatCompletion('not json at all'))));

    await expect(new OpenAIProvider('sk-test', CONTEXT).answerQuestion(QUESTION)).rejects.toMatchObject(
      { code: 'invalid_response' },
    );
  });

  it('rejects a response that was cut off', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(chatCompletion('{"answer":', 'length'))));

    await expect(new OpenAIProvider('sk-test', CONTEXT).answerQuestion(QUESTION)).rejects.toMatchObject(
      { code: 'invalid_response' },
    );
  });

  it('times out when the provider stops responding', async () => {
    stubFetch(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );

    await expect(
      new OpenAIProvider('sk-test', { ...CONTEXT, timeoutMs: 60 }).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });

  it('honours a model override', () => {
    expect(new OpenAIProvider('sk-test', { ...CONTEXT, model: 'gpt-4.1' }).getModel()).toBe('gpt-4.1');
  });
});

describe('OpenAICompatibleProvider', () => {
  const config = { baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'local-model' };

  it('talks to the configured base URL', async () => {
    const urls: string[] = [];
    stubFetch((input) => {
      urls.push(String(input));
      return Promise.resolve(jsonResponse(chatCompletion(ANSWER_JSON)));
    });

    const answer = await new OpenAICompatibleProvider(config, CONTEXT).answerQuestion(QUESTION);

    expect(urls[0]).toContain('https://example.test/v1');
    expect(answer.provider).toBe('openai-compatible');
  });

  it('maps an endpoint authentication failure', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ error: { message: 'bad key' } }, 401)));

    await expect(
      new OpenAICompatibleProvider(config, { ...CONTEXT, timeoutMs: 2_000 }).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'authentication', provider: 'openai-compatible' });
  });

  it('reports an unreachable endpoint as unavailable', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));

    await expect(
      new OpenAICompatibleProvider(config, { ...CONTEXT, timeoutMs: 2_000 }).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('times out when the endpoint stops responding', async () => {
    stubFetch(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );

    await expect(
      new OpenAICompatibleProvider(config, { ...CONTEXT, timeoutMs: 60 }).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects a reply that contains no JSON at all', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(chatCompletion('I think it is O(log n).'))));

    await expect(
      new OpenAICompatibleProvider(config, CONTEXT).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('copes with an endpoint that ignores JSON mode', async () => {
    stubFetch(() =>
      Promise.resolve(jsonResponse(chatCompletion('Here is the answer:\n```json\n' + ANSWER_JSON + '\n```'))),
    );

    const answer = await new OpenAICompatibleProvider(config, CONTEXT).answerQuestion(QUESTION);
    expect(answer.answer).toBe('O(log n)');
  });
});

describe('AnthropicProvider', () => {
  function message(overrides: Record<string, unknown> = {}): unknown {
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: ANSWER_JSON }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
      ...overrides,
    };
  }

  it('returns a structured answer on success', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(message())));

    const answer = await new AnthropicProvider('sk-ant-test', CONTEXT).answerQuestion(QUESTION);

    expect(answer).toMatchObject({
      answer: 'O(log n)',
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
  });

  it('treats a refusal stop reason as a rejected request', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse(
          message({
            stop_reason: 'refusal',
            content: [],
            stop_details: { type: 'refusal', category: 'other', explanation: null },
          }),
        ),
      ),
    );

    await expect(
      new AnthropicProvider('sk-ant-test', CONTEXT).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'bad_request', provider: 'anthropic' });
  });

  it('treats a truncated answer as an invalid response', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(message({ stop_reason: 'max_tokens' }))));

    await expect(
      new AnthropicProvider('sk-ant-test', CONTEXT).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps 401 to an authentication error', async () => {
    stubFetch(() =>
      Promise.resolve(jsonResponse({ type: 'error', error: { message: 'bad key' } }, 401)),
    );

    await expect(
      new AnthropicProvider('sk-ant-test', CONTEXT).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'authentication' });
  });

  it('maps 529 to a retryable unavailable error', async () => {
    stubFetch(() =>
      Promise.resolve(jsonResponse({ type: 'error', error: { message: 'overloaded' } }, 529)),
    );

    await expect(
      new AnthropicProvider('sk-ant-test', { ...CONTEXT, timeoutMs: 2_000 }).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: true });
  });
});

describe('ProviderFactory', () => {
  const base = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;

  it('lists every provider and marks which are configured', () => {
    const factory = new ProviderFactory(loadEnv({ ...base, OPENAI_API_KEY: 'sk-test' }));

    expect(factory.describe().map((entry) => entry.id)).toEqual([
      'openai',
      'gemini',
      'anthropic',
      'openai-compatible',
    ]);
    expect(factory.configured()).toEqual(['openai']);
  });

  it('builds the configured provider by default', () => {
    const factory = new ProviderFactory(
      loadEnv({ ...base, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' }),
    );

    expect(factory.create().getName()).toBe('anthropic');
  });

  it('applies a per-request model override', () => {
    const factory = new ProviderFactory(loadEnv({ ...base, OPENAI_API_KEY: 'sk-test' }));
    expect(factory.create('openai', 'gpt-4.1-mini').getModel()).toBe('gpt-4.1-mini');
  });

  it('refuses to build a provider with no credentials', () => {
    const factory = new ProviderFactory(loadEnv({ ...base, OPENAI_API_KEY: 'sk-test' }));

    expect(() => factory.create('gemini')).toThrow(ProviderError);
    expect(() => factory.create('gemini')).toThrow(/GEMINI_API_KEY/);
  });

  it('requires a base URL, key and model for an OpenAI-compatible endpoint', () => {
    const partial = new ProviderFactory(
      loadEnv({ ...base, AI_BASE_URL: 'https://example.test/v1', AI_API_KEY: 'key' }),
    );
    expect(() => partial.create('openai-compatible')).toThrow(/AI_MODEL/);

    const complete = new ProviderFactory(
      loadEnv({
        ...base,
        AI_BASE_URL: 'https://example.test/v1',
        AI_API_KEY: 'key',
        AI_MODEL: 'local-model',
      }),
    );
    expect(complete.create('openai-compatible').getModel()).toBe('local-model');
  });
});

describe('GeminiProvider', () => {
  function generateContentResponse(text: string, finishReason = 'STOP'): unknown {
    return {
      candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason, index: 0 }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    };
  }

  it('returns a structured answer on success', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(generateContentResponse(ANSWER_JSON))));

    const answer = await new GeminiProvider('gemini-key', CONTEXT).answerQuestion(QUESTION);

    expect(answer).toMatchObject({
      answer: 'O(log n)',
      provider: 'gemini',
      model: GEMINI_DEFAULT_MODEL,
    });
  });

  it('asks for JSON output and sends the system instruction', async () => {
    const bodies: string[] = [];
    stubFetch((_input, init) => {
      bodies.push(String(init?.body ?? ''));
      return Promise.resolve(jsonResponse(generateContentResponse(ANSWER_JSON)));
    });

    await new GeminiProvider('gemini-key', CONTEXT).answerQuestion(QUESTION);

    expect(bodies[0]).toContain('application/json');
    expect(bodies[0]).toContain('study assistant');
    expect(bodies[0]).toContain('binary search');
    // Gemini rejects additionalProperties, so it must not be in the schema.
    expect(bodies[0]).not.toContain('additionalProperties');
  });

  it('rejects a malformed model response', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(generateContentResponse('sorry, no JSON here'))));

    await expect(
      new GeminiProvider('gemini-key', CONTEXT).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'invalid_response', provider: 'gemini' });
  });

  it('rejects an empty response', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ candidates: [] })));

    await expect(
      new GeminiProvider('gemini-key', CONTEXT).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps an authentication failure', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse({ error: { code: 401, message: 'API key not valid', status: 'UNAUTHENTICATED' } }, 401),
      ),
    );

    await expect(
      new GeminiProvider('gemini-key', { ...CONTEXT, timeoutMs: 2_000 }).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'authentication', provider: 'gemini' });
  });

  it('maps a rate limit to a retryable error', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, 429),
      ),
    );

    await expect(
      new GeminiProvider('gemini-key', { ...CONTEXT, timeoutMs: 2_000 }).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('times out when Gemini stops responding', async () => {
    stubFetch(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );

    await expect(
      new GeminiProvider('gemini-key', { ...CONTEXT, timeoutMs: 60 }).answerQuestion(QUESTION),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });

  it('honours a model override', () => {
    expect(new GeminiProvider('k', { ...CONTEXT, model: 'gemini-2.5-pro' }).getModel()).toBe(
      'gemini-2.5-pro',
    );
  });
});
