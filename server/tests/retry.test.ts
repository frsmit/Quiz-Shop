import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../src/providers/retry.js';
import { ProviderError } from '../src/providers/provider.errors.js';

const noSleep = () => Promise.resolve();

function options(overrides: Record<string, unknown> = {}) {
  return { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: noSleep, ...overrides };
}

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    const operation = vi.fn(() => Promise.resolve('ok'));
    await expect(withRetry(operation, options())).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a rate limit and succeeds', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ProviderError('rate_limited', 'gemini', '429'))
      .mockResolvedValue('ok');

    await expect(withRetry(operation, options())).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries an unavailable provider up to the attempt limit', async () => {
    const operation = vi.fn(() =>
      Promise.reject(new ProviderError('unavailable', 'gemini', '503')),
    );

    await expect(withRetry(operation, options({ attempts: 3 }))).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable failure', async () => {
    const operation = vi.fn(() =>
      Promise.reject(new ProviderError('authentication', 'gemini', 'bad key')),
    );

    await expect(withRetry(operation, options())).rejects.toMatchObject({ code: 'authentication' });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry a timeout, which has already spent its budget', async () => {
    const operation = vi.fn(() => Promise.reject(new ProviderError('timeout', 'gemini', 'slow')));

    await expect(withRetry(operation, options())).rejects.toMatchObject({ code: 'timeout' });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error that is not a ProviderError', async () => {
    const operation = vi.fn(() => Promise.reject(new Error('boom')));
    await expect(withRetry(operation, options())).rejects.toThrow('boom');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops when the caller has disconnected', async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(() =>
      Promise.reject(new ProviderError('unavailable', 'gemini', '503')),
    );

    await expect(
      withRetry(operation, options({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially, with jitter inside the bound', async () => {
    const delays: number[] = [];
    const operation = vi.fn(() =>
      Promise.reject(new ProviderError('rate_limited', 'gemini', '429')),
    );

    await expect(
      withRetry(
        operation,
        options({
          attempts: 4,
          baseDelayMs: 1000,
          maxDelayMs: 8000,
          sleep: (ms: number) => {
            delays.push(ms);
            return Promise.resolve();
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(delays).toHaveLength(3);
    // Full jitter: each delay sits between half the nominal value and all of it.
    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(1000);
    expect(delays[1]).toBeGreaterThanOrEqual(1000);
    expect(delays[1]).toBeLessThanOrEqual(2000);
    expect(delays[2]).toBeGreaterThanOrEqual(2000);
    expect(delays[2]).toBeLessThanOrEqual(4000);
  });

  it('reports each retry to the caller', async () => {
    const onRetry = vi.fn();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ProviderError('rate_limited', 'gemini', '429'))
      .mockResolvedValue('ok');

    await withRetry(operation, options({ onRetry }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toBe(1);
  });
});
