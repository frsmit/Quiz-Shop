import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnswerCache } from '../src/background/cache';
import { forContentScript, sanitize } from '../src/background/settings';
import { BackendError, checkHealth, requestAnswer, testProvider } from '../src/background/backend-client';
import { DEFAULT_SETTINGS } from '../src/shared/constants';
import type { ExtensionSettings, QuestionAnswer } from '../src/shared/types';

const SETTINGS: ExtensionSettings = { ...DEFAULT_SETTINGS, backendUrl: 'http://localhost:3000' };

const ANSWER: QuestionAnswer = {
  answer: 'O(log n)',
  explanation: 'Binary search halves the range each step.',
  provider: 'openai',
  model: 'gpt-4o-mini',
};

const QUESTION = {
  question: 'What is the time complexity of binary search?',
  type: 'multiple_choice' as const,
  options: ['O(n)', 'O(log n)'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('answer cache', () => {
  it('returns a stored answer', () => {
    const cache = createAnswerCache();
    cache.set('abc', ANSWER);
    expect(cache.get('abc')).toEqual(ANSWER);
  });

  it('misses on an unknown key', () => {
    expect(createAnswerCache().get('nope')).toBeUndefined();
  });

  it('expires entries once the TTL has passed', () => {
    let now = 1_000;
    const cache = createAnswerCache(500, 10, () => now);

    cache.set('abc', ANSWER);
    now += 499;
    expect(cache.get('abc')).toEqual(ANSWER);

    now += 2;
    expect(cache.get('abc')).toBeUndefined();
  });

  it('evicts the least recently used entry when full', () => {
    const cache = createAnswerCache(60_000, 2);

    cache.set('a', ANSWER);
    cache.set('b', ANSWER);
    cache.get('a'); // 'a' is now the most recently used.
    cache.set('c', ANSWER);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual(ANSWER);
    expect(cache.get('c')).toEqual(ANSWER);
    expect(cache.size).toBe(2);
  });

  it('clears everything on request', () => {
    const cache = createAnswerCache();
    cache.set('a', ANSWER);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('settings sanitisation', () => {
  it('fills in defaults for an empty object', () => {
    expect(sanitize({})).toEqual(DEFAULT_SETTINGS);
  });

  it('survives a corrupt stored value', () => {
    expect(sanitize('not an object')).toEqual(DEFAULT_SETTINGS);
    expect(sanitize(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('rejects an unknown provider', () => {
    expect(sanitize({ provider: 'some-other-vendor' }).provider).toBe(DEFAULT_SETTINGS.provider);
  });

  it('clamps numeric settings into range', () => {
    expect(sanitize({ maxContextLength: -50 }).maxContextLength).toBe(0);
    expect(sanitize({ maxContextLength: 99_999 }).maxContextLength).toBe(8000);
    expect(sanitize({ requestTimeoutMs: 10 }).requestTimeoutMs).toBe(2000);
  });

  it('drops a trailing slash and rejects a non-http backend URL', () => {
    expect(sanitize({ backendUrl: 'http://localhost:4000/' }).backendUrl).toBe('http://localhost:4000');
    expect(sanitize({ backendUrl: 'javascript:alert(1)' }).backendUrl).toBe(DEFAULT_SETTINGS.backendUrl);
    expect(sanitize({ backendUrl: 'not a url' }).backendUrl).toBe(DEFAULT_SETTINGS.backendUrl);
  });

  it('keeps only well-formed origins, de-duplicated', () => {
    const settings = sanitize({
      enabledOrigins: [
        'https://example.com/some/path',
        'https://example.com',
        'ftp://example.com',
        42,
      ],
    });

    expect(settings.enabledOrigins).toEqual(['https://example.com']);
  });
});

describe('backend client', () => {
  it('posts the question and returns the answer', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(jsonResponse({ data: ANSWER, meta: { cached: false } }));
      }),
    );

    const answer = await requestAnswer(QUESTION, SETTINGS);

    expect(answer).toEqual(ANSWER);
    expect(calls[0]?.url).toBe('http://localhost:3000/api/questions/answer');
    expect(String(calls[0]?.init?.body)).toContain('binary search');
  });

  it('sends the backend key only when one is configured', async () => {
    const headers: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        headers.push((init?.headers ?? {}) as Record<string, string>);
        return Promise.resolve(jsonResponse({ data: ANSWER }));
      }),
    );

    await requestAnswer(QUESTION, SETTINGS);
    expect(headers[0]?.['x-api-key']).toBeUndefined();

    await requestAnswer(QUESTION, { ...SETTINGS, backendApiKey: 'secret' });
    expect(headers[1]?.['x-api-key']).toBe('secret');
  });

  it('surfaces the backend error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({ error: { code: 'rate_limited', message: 'Too many requests.' } }, 429),
        ),
      ),
    );

    await expect(requestAnswer(QUESTION, SETTINGS)).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'Too many requests.',
    });
  });

  it('reports an unreachable backend as a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

    await expect(requestAnswer(QUESTION, SETTINGS)).rejects.toMatchObject({ code: 'network' });
  });

  it('times out when the backend stops responding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );

    await expect(
      requestAnswer(QUESTION, { ...SETTINGS, requestTimeoutMs: 2000 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects a malformed answer envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ data: { nope: true } }))));

    await expect(requestAnswer(QUESTION, SETTINGS)).rejects.toBeInstanceOf(BackendError);
  });

  it('reads the health endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(jsonResponse({ status: 'ok', activeProvider: 'openai', providers: ['openai'] })),
      ),
    );

    await expect(checkHealth(SETTINGS)).resolves.toMatchObject({ activeProvider: 'openai' });
  });
});

describe("the user's own provider key", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function captureHeaders(): Array<Record<string, string>> {
    const headers: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        headers.push((init?.headers ?? {}) as Record<string, string>);
        return Promise.resolve(jsonResponse({ data: ANSWER }));
      }),
    );
    return headers;
  }

  it('travels as a header, never in the body', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return Promise.resolve(jsonResponse({ data: ANSWER }));
      }),
    );
    await requestAnswer(QUESTION, { ...SETTINGS, provider: 'gemini', aiApiKey: 'g-user-key' });
    expect(bodies[0]).not.toContain('g-user-key');
  });

  it('is sent with the provider it was entered for', async () => {
    const headers = captureHeaders();
    await requestAnswer(QUESTION, { ...SETTINGS, provider: 'gemini', aiApiKey: 'g-user-key' });
    expect(headers[0]?.['x-ai-api-key']).toBe('g-user-key');
    expect(headers[0]?.['x-ai-base-url']).toBeUndefined();
  });

  it("is not sent while the backend's own provider is selected", async () => {
    const headers = captureHeaders();
    await requestAnswer(QUESTION, { ...SETTINGS, provider: '', aiApiKey: 'stale-key' });
    expect(headers[0]?.['x-ai-api-key']).toBeUndefined();
  });

  it('brings its endpoint along for an OpenAI-compatible provider', async () => {
    const headers = captureHeaders();
    await requestAnswer(QUESTION, {
      ...SETTINGS,
      provider: 'openai-compatible',
      model: 'llama',
      aiApiKey: 'k',
      aiBaseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(headers[0]).toMatchObject({ 'x-ai-api-key': 'k', 'x-ai-base-url': 'https://openrouter.ai/api/v1' });
  });

  it('can be tried against the backend before it is saved', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
        return Promise.resolve(
          jsonResponse({ data: { provider: 'anthropic', model: 'claude-opus-5', answer: '4', latencyMs: 900 } }),
        );
      }),
    );

    const result = await testProvider({ ...SETTINGS, provider: 'anthropic', aiApiKey: 'sk-ant' });
    expect(result).toMatchObject({ provider: 'anthropic', answer: '4' });
    expect(calls[0]).toMatchObject({
      url: 'http://localhost:3000/api/providers/test',
      headers: { 'x-ai-api-key': 'sk-ant' },
      body: { provider: 'anthropic' },
    });
  });
});

describe('provider settings sanitisation', () => {
  it('keeps a key and an http(s) endpoint, and drops anything else', () => {
    const settings = sanitize({ aiApiKey: '  sk-abc  ', aiBaseUrl: 'https://example.test/v1/' });
    expect(settings.aiApiKey).toBe('sk-abc');
    expect(settings.aiBaseUrl).toBe('https://example.test/v1');
    expect(sanitize({ aiBaseUrl: 'javascript:alert(1)' }).aiBaseUrl).toBe('');
    expect(sanitize({ aiApiKey: 42 }).aiApiKey).toBe('');
  });

  it('hides both keys from content scripts', () => {
    const settings = forContentScript({ ...SETTINGS, aiApiKey: 'sk-user', backendApiKey: 'shared' });
    expect(settings.aiApiKey).toBe('');
    expect(settings.backendApiKey).toBe('');
    expect(settings.autoFill).toBe(SETTINGS.autoFill);
  });
});
