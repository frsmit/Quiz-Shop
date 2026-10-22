import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/providers/provider.errors.js';
import { QUESTION_LIMITS } from '../src/question/question.schema.js';
import { StubProvider, StubRegistry, VALID_QUESTION, buildApp } from './helpers.js';

describe('GET /api/health', () => {
  it('reports the active provider and which providers are configured', async () => {
    const response = await request(buildApp()).get('/api/health').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.activeProvider).toBe('openai');
    expect(response.body.providers).toEqual(['openai']);
    expect(response.body.allProviders).toHaveLength(4);
  });

  it('never exposes credentials', async () => {
    const response = await request(buildApp()).get('/api/health').expect(200);
    expect(JSON.stringify(response.body)).not.toMatch(/key/i);
  });
});

describe('POST /api/questions/answer', () => {
  it('answers a valid multiple-choice question', async () => {
    const response = await request(buildApp())
      .post('/api/questions/answer')
      .send(VALID_QUESTION)
      .expect(200);

    expect(response.body.data).toMatchObject({
      answer: 'O(log n)',
      provider: 'stub',
      model: 'stub-model',
    });
    expect(response.body.data.explanation).toBeTruthy();
    expect(response.body.meta.cached).toBe(false);
  });

  it('defaults the question type when it is omitted', async () => {
    const provider = new StubProvider({
      respond: async (req) => ({
        answer: req.type,
        explanation: 'echoing the type',
        provider: 'stub',
        model: 'stub-model',
      }),
    });

    const response = await request(buildApp(new StubRegistry(provider)))
      .post('/api/questions/answer')
      .send({ question: 'Explain polymorphism in Java.' })
      .expect(200);

    expect(response.body.data.answer).toBe('unknown');
  });

  it('passes a per-request provider and model override to the factory', async () => {
    const registry = new StubRegistry();
    await request(buildApp(registry))
      .post('/api/questions/answer')
      .send({ ...VALID_QUESTION, provider: 'anthropic', model: 'claude-opus-5' })
      .expect(200);

    expect(registry.createCalls).toEqual([{ id: 'anthropic', model: 'claude-opus-5' }]);
  });

  it("passes the user's own key and endpoint to the factory, from headers only", async () => {
    const registry = new StubRegistry();
    await request(buildApp(registry))
      .post('/api/questions/answer')
      .set('x-ai-api-key', ' sk-user ')
      .set('x-ai-base-url', 'https://mine.test/v1')
      .send({ ...VALID_QUESTION, provider: 'openai-compatible', model: 'm', apiKey: 'ignored' })
      .expect(200);

    expect(registry.createCalls).toEqual([
      {
        id: 'openai-compatible',
        model: 'm',
        credentials: { apiKey: 'sk-user', baseUrl: 'https://mine.test/v1' },
      },
    ]);
  });

  it('carries the multi-select flag through to the provider and keeps the chosen list', async () => {
    let seen: boolean | undefined;
    const provider = new StubProvider({
      respond: async (req) => {
        seen = req.multiSelect;
        return {
          answer: 'O(n); O(1)',
          answers: ['A. O(n)', 'O(1)'],
          explanation: 'x',
          provider: 'stub',
          model: 'stub-model',
        };
      },
    });
    const response = await request(buildApp(new StubRegistry(provider)))
      .post('/api/questions/answer')
      .send({ ...VALID_QUESTION, multiSelect: true })
      .expect(200);

    expect(seen).toBe(true);
    expect(response.body.data.answers).toEqual(['O(n)', 'O(1)']);
    expect(response.body.data.answer).toBe('O(n); O(1)');
  });

  it('rejects a request with no question', async () => {
    const response = await request(buildApp())
      .post('/api/questions/answer')
      .send({ type: 'short_answer' })
      .expect(400);

    expect(response.body.error.code).toBe('invalid_request');
    expect(response.body.error.details[0].path).toBe('question');
  });

  it('rejects a question that is too short', async () => {
    await request(buildApp()).post('/api/questions/answer').send({ question: 'why?' }).expect(400);
  });

  it('rejects context beyond the allowed length', async () => {
    const response = await request(buildApp())
      .post('/api/questions/answer')
      .send({
        ...VALID_QUESTION,
        context: 'x'.repeat(QUESTION_LIMITS.maxContextLength + 1),
      })
      .expect(400);

    expect(response.body.error.details[0].path).toBe('context');
  });

  it('rejects a single-option multiple-choice question', async () => {
    await request(buildApp())
      .post('/api/questions/answer')
      .send({ ...VALID_QUESTION, options: ['only one'] })
      .expect(400);
  });

  it('rejects an unknown provider id', async () => {
    await request(buildApp())
      .post('/api/questions/answer')
      .send({ ...VALID_QUESTION, provider: 'some-other-vendor' })
      .expect(400);
  });

  it('rejects a body that is not valid JSON', async () => {
    const response = await request(buildApp())
      .post('/api/questions/answer')
      .set('Content-Type', 'application/json')
      .send('{"question": ')
      .expect(400);

    expect(response.body.error.code).toBe('invalid_json');
  });

  it('rejects an oversized body', async () => {
    const response = await request(buildApp())
      .post('/api/questions/answer')
      .send({ ...VALID_QUESTION, context: 'x'.repeat(40_000) })
      .expect(413);

    expect(response.body.error.code).toBe('payload_too_large');
  });

  describe('provider failures', () => {
    const cases = [
      { code: 'missing_credentials', status: 503, retryable: false },
      { code: 'authentication', status: 502, retryable: false },
      { code: 'rate_limited', status: 429, retryable: true },
      { code: 'timeout', status: 504, retryable: true },
      { code: 'unavailable', status: 503, retryable: true },
      { code: 'invalid_response', status: 502, retryable: false },
    ] as const;

    for (const { code, status, retryable } of cases) {
      it(`maps a ${code} provider error to ${status}`, async () => {
        const provider = new StubProvider({
          respond: () => Promise.reject(new ProviderError(code, 'stub', `simulated ${code}`)),
        });

        const response = await request(buildApp(new StubRegistry(provider)))
          .post('/api/questions/answer')
          .send(VALID_QUESTION)
          .expect(status);

        expect(response.body.error).toMatchObject({ code, provider: 'stub', retryable });
      });
    }

    it('does not leak internals when a provider throws an unexpected error', async () => {
      const provider = new StubProvider({
        respond: () => Promise.reject(new Error('ECONNRESET at secret-internal-host:5432')),
      });

      const response = await request(buildApp(new StubRegistry(provider)))
        .post('/api/questions/answer')
        .send(VALID_QUESTION)
        .expect(500);

      expect(response.body.error.code).toBe('internal_error');
      expect(JSON.stringify(response.body)).not.toContain('secret-internal-host');
    });

    it('reports an off-contract provider answer as a provider failure', async () => {
      const provider = new StubProvider({
        // A provider returning the wrong shape must not reach the client.
        respond: () => Promise.resolve({ answer: '' } as never),
      });

      await request(buildApp(new StubRegistry(provider)))
        .post('/api/questions/answer')
        .send(VALID_QUESTION)
        .expect(502);
    });
  });
});

describe('caching', () => {
  it('serves a repeated question from the cache', async () => {
    const provider = new StubProvider();
    const app = buildApp(new StubRegistry(provider), { CACHE_ENABLED: 'true' });

    const first = await request(app).post('/api/questions/answer').send(VALID_QUESTION).expect(200);
    const second = await request(app).post('/api/questions/answer').send(VALID_QUESTION).expect(200);

    expect(first.body.meta.cached).toBe(false);
    expect(second.body.meta.cached).toBe(true);
    expect(provider.calls).toBe(1);
  });

  it('treats a different question as a different entry', async () => {
    const provider = new StubProvider();
    const app = buildApp(new StubRegistry(provider), { CACHE_ENABLED: 'true' });

    await request(app).post('/api/questions/answer').send(VALID_QUESTION).expect(200);
    await request(app)
      .post('/api/questions/answer')
      .send({ ...VALID_QUESTION, question: 'What is the time complexity of a linear scan?' })
      .expect(200);

    expect(provider.calls).toBe(2);
  });

  it('clears the cache on request', async () => {
    const provider = new StubProvider();
    const app = buildApp(new StubRegistry(provider), { CACHE_ENABLED: 'true' });

    await request(app).post('/api/questions/answer').send(VALID_QUESTION).expect(200);
    await request(app).post('/api/cache/clear').expect(200);
    const third = await request(app).post('/api/questions/answer').send(VALID_QUESTION).expect(200);

    expect(third.body.meta.cached).toBe(false);
    expect(provider.calls).toBe(2);
  });
});

describe('access control', () => {
  it('requires the shared secret when one is configured', async () => {
    const app = buildApp(new StubRegistry(), { API_ACCESS_KEY: 'super-secret' });

    const denied = await request(app).post('/api/questions/answer').send(VALID_QUESTION).expect(401);
    expect(denied.body.error.code).toBe('unauthorized');

    await request(app)
      .post('/api/questions/answer')
      .set('x-api-key', 'super-secret')
      .send(VALID_QUESTION)
      .expect(200);
  });

  it('rejects a wrong secret of the same length', async () => {
    const app = buildApp(new StubRegistry(), { API_ACCESS_KEY: 'super-secret' });
    await request(app)
      .post('/api/questions/answer')
      .set('x-api-key', 'super-secreT')
      .send(VALID_QUESTION)
      .expect(401);
  });

  it('leaves health unauthenticated so the options page can probe it', async () => {
    const app = buildApp(new StubRegistry(), { API_ACCESS_KEY: 'super-secret' });
    await request(app).get('/api/health').expect(200);
  });

  it('rate limits once the window is exhausted', async () => {
    const app = buildApp(new StubRegistry(), { RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' });

    await request(app).post('/api/questions/answer').send(VALID_QUESTION).expect(200);
    await request(app).post('/api/questions/answer').send(VALID_QUESTION).expect(200);
    const limited = await request(app).post('/api/questions/answer').send(VALID_QUESTION).expect(429);

    expect(limited.body.error.code).toBe('rate_limited');
  });

  it('rejects an origin that is not allowed', async () => {
    const app = buildApp(new StubRegistry(), { CORS_ALLOWED_ORIGINS: 'chrome-extension://*' });
    await request(app)
      .post('/api/questions/answer')
      .set('Origin', 'https://evil.example')
      .send(VALID_QUESTION)
      .expect(403);
  });

  it('allows any extension origin through the wildcard', async () => {
    const app = buildApp(new StubRegistry(), { CORS_ALLOWED_ORIGINS: 'chrome-extension://*' });
    const response = await request(app)
      .post('/api/questions/answer')
      .set('Origin', 'chrome-extension://abcdefghijklmnop')
      .send(VALID_QUESTION)
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('chrome-extension://abcdefghijklmnop');
  });
});

describe('POST /api/providers/test', () => {
  it('asks the chosen provider one question and reports how it went', async () => {
    const registry = new StubRegistry();
    const response = await request(buildApp(registry))
      .post('/api/providers/test')
      .set('x-ai-api-key', 'sk-user')
      .send({ provider: 'gemini', model: 'gemini-x' })
      .expect(200);

    expect(registry.createCalls).toEqual([
      { id: 'gemini', model: 'gemini-x', credentials: { apiKey: 'sk-user' } },
    ]);
    expect(response.body.data).toMatchObject({ provider: 'stub', model: 'stub-model', answer: '4' });
    expect(typeof response.body.data.latencyMs).toBe('number');
  });

  it('reports a rejected key with the provider error status', async () => {
    const provider = new StubProvider({
      respond: async () => {
        throw new ProviderError('authentication', 'stub', 'Incorrect API key provided.');
      },
    });
    const response = await request(buildApp(new StubRegistry(provider)))
      .post('/api/providers/test')
      .send({})
      .expect(502);

    expect(response.body.error.message).toMatch(/Incorrect API key/);
  });

  it('never caches or records the probe', async () => {
    const provider = new StubProvider();
    const app = buildApp(new StubRegistry(provider), { CACHE_ENABLED: 'true' });
    await request(app).post('/api/providers/test').send({}).expect(200);
    await request(app).post('/api/providers/test').send({}).expect(200);
    expect(provider.calls).toBe(2);
  });
});

describe('unknown routes', () => {
  it('returns a structured 404', async () => {
    const response = await request(buildApp()).get('/api/nope').expect(404);
    expect(response.body.error.code).toBe('not_found');
  });
});
