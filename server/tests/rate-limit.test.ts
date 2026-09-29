import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ProviderError, retryAfterOf } from '../src/providers/provider.errors.js';
import { StubProvider, StubRegistry, VALID_QUESTION, buildApp } from './helpers.js';

/** The message the Gemini SDK throws on a free-tier 429, trimmed. */
const GEMINI_429 =
  '{"error":{"code":429,"message":"You exceeded your current quota ... limit: 15, model: gemini-3.5-flash-lite\\nPlease retry in 23.268509408s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"23s"}]}}';

describe('retryAfterOf', () => {
  it("reads Google's RetryInfo out of the Gemini SDK message", () => {
    expect(retryAfterOf(new Error(GEMINI_429))).toBe(23_000);
  });

  it('falls back to the "retry in" sentence', () => {
    expect(retryAfterOf(new Error('Quota exceeded. Please retry in 4.2s.'))).toBe(4_200);
  });

  it('reads a Retry-After header, as the OpenAI and Anthropic SDKs expose it', () => {
    expect(retryAfterOf({ headers: new Headers({ 'retry-after': '7' }) })).toBe(7_000);
    expect(retryAfterOf({ headers: { 'retry-after': '2' } })).toBe(2_000);
  });

  it('is undefined when the provider gave no wait', () => {
    expect(retryAfterOf(new Error('Service unavailable'))).toBeUndefined();
    expect(retryAfterOf(null)).toBeUndefined();
  });
});

describe('a rate-limited answer', () => {
  it('tells the client how long to wait, in the body and the Retry-After header', async () => {
    const provider = new StubProvider({
      respond: () =>
        Promise.reject(
          new ProviderError('rate_limited', 'gemini', 'Gemini rate limit reached; retry in 23s.', {
            retryAfterMs: 23_000,
          }),
        ),
    });

    const response = await request(buildApp(new StubRegistry(provider)))
      .post('/api/questions/answer')
      .send(VALID_QUESTION)
      .expect(429);

    expect(response.headers['retry-after']).toBe('23');
    expect(response.body.error).toMatchObject({ code: 'rate_limited', retryAfterMs: 23_000 });
    // One call: a 23s wait is handed back, not slept on.
    expect(provider.calls).toBe(1);
  });
});
