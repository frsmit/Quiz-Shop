/**
 * The three pieces of runtime behaviour the popup and monitor depend on:
 * the pause / start-delay state machine, the global pacer, and the log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/constants';
import { readiness } from '../src/background/run-state';
import { createPacer } from '../src/background/pacer';
import type { ExtensionSettings, RunState } from '../src/shared/types';

const RUNNING: RunState = { paused: false, resumedAt: 1_000_000 };

function settings(overrides: Partial<ExtensionSettings> = {}): ExtensionSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('readiness', () => {
  it('is running with no start delay configured', () => {
    expect(readiness(RUNNING, settings({ startDelayMs: 0 }), 1_000_000)).toEqual({
      status: 'running',
      startsInMs: 0,
    });
  });

  it('is paused when the user paused it', () => {
    const state: RunState = { paused: true, resumedAt: 0 };
    expect(readiness(state, settings(), 1_000_000).status).toBe('paused');
  });

  it('reports detection being switched off separately from pausing', () => {
    expect(readiness(RUNNING, settings({ autoDetect: false }), 1_000_000).status).toBe('disabled');
  });

  it('counts down while the start delay has not elapsed', () => {
    const result = readiness(RUNNING, settings({ startDelayMs: 300_000 }), 1_000_000 + 120_000);
    expect(result.status).toBe('starting');
    expect(result.startsInMs).toBe(180_000);
  });

  it('starts running the moment the delay elapses', () => {
    const at = 1_000_000 + 300_000;
    expect(readiness(RUNNING, settings({ startDelayMs: 300_000 }), at).status).toBe('running');
  });

  it('treats pausing as more important than the start delay', () => {
    const state: RunState = { paused: true, resumedAt: 1_000_000 };
    expect(readiness(state, settings({ startDelayMs: 300_000 }), 1_000_000).status).toBe('paused');
  });

  it('treats detection being off as more important than pausing', () => {
    const state: RunState = { paused: true, resumedAt: 0 };
    expect(readiness(state, settings({ autoDetect: false }), 1).status).toBe('disabled');
  });
});

describe('pacer', () => {
  let now = 0;
  const waits: number[] = [];

  const sleep = (ms: number) => {
    waits.push(ms);
    now += ms;
    return Promise.resolve();
  };

  beforeEach(() => {
    now = 1_000;
    waits.length = 0;
  });

  it('lets the first caller straight through', async () => {
    const pacer = createPacer(() => now, sleep);
    await pacer.take(3000);
    expect(waits).toEqual([]);
  });

  it('spaces consecutive callers by the delay', async () => {
    const pacer = createPacer(() => now, sleep);

    await pacer.take(3000);
    await pacer.take(3000);
    await pacer.take(3000);

    expect(waits).toEqual([3000, 3000]);
  });

  it('reserves slots so concurrent callers do not collide', async () => {
    const pacer = createPacer(() => now, sleep);

    // Started together, the way three tabs would. Each has to claim its own
    // slot; sharing one would let all three fire at once.
    await Promise.all([pacer.take(5000), pacer.take(5000), pacer.take(5000)]);

    // Three slots handed out from t=1000, one interval apart.
    expect(pacer.nextAvailableAt()).toBe(1000 + 3 * 5000);
    expect(waits).toHaveLength(2); // the first caller never waits
  });

  it('holds the next turn back when a provider asks for a wait', async () => {
    const pacer = createPacer(() => now, sleep);
    await pacer.take(1200);

    pacer.defer(23_000);
    await pacer.take(1200);

    expect(waits).toEqual([23_000]);
  });

  it('never brings a turn forward', () => {
    const pacer = createPacer(() => now, sleep);
    void pacer.take(60_000);
    pacer.defer(1_000);
    expect(pacer.nextAvailableAt()).toBe(1_000 + 60_000);
  });

  it('does not wait when the delay is zero', async () => {
    const pacer = createPacer(() => now, sleep);
    await pacer.take(0);
    await pacer.take(0);
    expect(waits).toEqual([]);
  });

  it('does not make a caller wait for a slot that has already passed', async () => {
    const pacer = createPacer(() => now, sleep);

    await pacer.take(1000);
    now += 60_000; // A long quiet period.
    await pacer.take(1000);

    expect(waits).toEqual([]);
  });

  it('forgets its schedule when reset', async () => {
    const pacer = createPacer(() => now, sleep);

    await pacer.take(5000);
    pacer.reset();
    await pacer.take(5000);

    expect(waits).toEqual([]);
  });
});

describe('activity log', () => {
  let local: Record<string, unknown> = {};

  beforeEach(() => {
    local = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: (key: string) => Promise.resolve({ [key]: local[key] }),
          set: (items: Record<string, unknown>) => {
            Object.assign(local, items);
            return Promise.resolve();
          },
          remove: (key: string) => {
            delete local[key];
            return Promise.resolve();
          },
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load() {
    vi.resetModules();
    return import('../src/background/activity-log');
  }

  function entry(overrides: Record<string, unknown> = {}) {
    return {
      at: Date.now(),
      origin: 'https://practice.example',
      url: 'https://practice.example/quiz/1',
      title: 'Practice quiz',
      fingerprint: 'fp1',
      type: 'multiple_choice' as const,
      optionCount: 4,
      question: 'What is the time complexity of binary search?',
      answer: 'O(log n)',
      provider: 'openai',
      model: 'gpt-4o-mini',
      latencyMs: 812,
      outcome: 'answered' as const,
      ...overrides,
    };
  }

  it('stores newest first', async () => {
    const log = await load();
    await log.append(entry({ question: 'first question here', fingerprint: 'a' }), 100);
    await log.append(entry({ question: 'second question here', fingerprint: 'b' }), 100);

    const entries = await log.list();
    expect(entries.map((item) => item.fingerprint)).toEqual(['b', 'a']);
  });

  it('drops the oldest beyond the limit', async () => {
    const log = await load();
    for (let i = 0; i < 60; i += 1) {
      await log.append(entry({ fingerprint: `fp${i}` }), 50);
    }

    const entries = await log.list();
    expect(entries).toHaveLength(50);
    expect(entries[0]?.fingerprint).toBe('fp59');
    expect(entries.at(-1)?.fingerprint).toBe('fp10');
  });

  it('refuses a limit below the supported minimum', async () => {
    const log = await load();
    // A corrupt or hand-edited setting must not shrink the log to nothing.
    for (let i = 0; i < 60; i += 1) await log.append(entry({ fingerprint: `fp${i}` }), 1);
    expect(await log.list()).toHaveLength(50);
  });

  it('honours a requested page size', async () => {
    const log = await load();
    for (let i = 0; i < 6; i += 1) await log.append(entry({ fingerprint: `fp${i}` }), 100);
    expect(await log.list(2)).toHaveLength(2);
  });

  it('caps very long question and answer text', async () => {
    const log = await load();
    await log.append(entry({ question: 'q'.repeat(2000), answer: 'a'.repeat(2000) }), 100);

    const [stored] = await log.list();
    expect(stored?.question.length).toBeLessThanOrEqual(501);
    expect(stored?.answer.length).toBeLessThanOrEqual(501);
  });

  it('updates the outcome once the page reports back', async () => {
    const log = await load();
    await log.append(entry({ fingerprint: 'fp-x', outcome: 'answered' }), 100);
    await log.recordOutcome('fp-x', 'filled');

    expect((await log.list())[0]?.outcome).toBe('filled');
  });

  it('ignores an outcome for a question it never saw', async () => {
    const log = await load();
    await log.append(entry({ fingerprint: 'fp-x' }), 100);
    await log.recordOutcome('unknown-fingerprint', 'filled');

    expect((await log.list())[0]?.outcome).toBe('answered');
  });

  it('summarises counts, errors and busiest sites', async () => {
    const log = await load();
    const now = Date.now();

    await log.append(entry({ fingerprint: 'a', origin: 'https://a.test' }), 100);
    await log.append(entry({ fingerprint: 'b', origin: 'https://a.test', outcome: 'cached' }), 100);
    await log.append(entry({ fingerprint: 'c', origin: 'https://b.test' }), 100);
    await log.append(entry({ fingerprint: 'd', origin: 'https://b.test', outcome: 'error' }), 100);
    await log.append(entry({ fingerprint: 'e', origin: 'https://a.test', at: now - 3 * 86_400_000 }), 100);

    const stats = await log.stats(now);
    expect(stats.total).toBe(4);
    expect(stats.today).toBe(3);
    expect(stats.errors).toBe(1);
    expect(stats.cached).toBe(1);
    expect(stats.byOrigin[0]).toEqual({ origin: 'https://a.test', count: 3 });
  });

  it('empties on request', async () => {
    const log = await load();
    await log.append(entry(), 100);
    await log.clear();
    expect(await log.list()).toEqual([]);
  });

  it('starts empty rather than throwing on a fresh profile', async () => {
    const log = await load();
    expect(await log.list()).toEqual([]);
    expect((await log.stats()).total).toBe(0);
  });
});
