/**
 * The message-passing round trip, end to end through the real service worker:
 *
 *   content script → service worker → backend
 *   backend response → service worker → content script
 *
 * The `chrome` API is faked rather than the worker's own modules, so the code
 * under test is the shipped service worker, including its validation,
 * caching, request coalescing and settings broadcasting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from '../src/shared/constants';
import { MESSAGE_SOURCE, envelope } from '../src/shared/messages';
import type { WorkerResponse } from '../src/shared/messages';
import type { ExtensionSettings, QuestionAnswer } from '../src/shared/types';

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

const ANSWER: QuestionAnswer = {
  answer: 'O(log n)',
  explanation: 'Binary search halves the range each step.',
  confidence: 0.9,
  provider: 'openai',
  model: 'gpt-4o-mini',
};

const REQUEST = {
  question: 'What is the time complexity of binary search?',
  type: 'multiple_choice' as const,
  options: ['O(n)', 'O(log n)'],
  source: { url: 'http://localhost:5173/', title: 'Practice quiz' },
};

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/** Messages the worker pushed out to tabs, i.e. worker → content script. */
let sentToTabs: Array<{ tabId: number; message: unknown }> = [];
let messageListener: Listener | undefined;
let storage: Record<string, unknown> = {};
let local: Record<string, unknown> = {};

function fakeChrome() {
  return {
    runtime: {
      id: EXTENSION_ID,
      getURL: vi.fn((path: string) => `chrome-extension://${EXTENSION_ID}/${path}`),
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((listener: Listener) => {
          messageListener = listener;
        }),
      },
    },
    storage: {
      sync: {
        get: vi.fn((key: string) => Promise.resolve({ [key]: storage[key] })),
        set: vi.fn((items: Record<string, unknown>) => {
          Object.assign(storage, items);
          return Promise.resolve();
        }),
      },
      // Run state and the activity log are per-device, so they live here.
      local: {
        get: vi.fn((key: string) => Promise.resolve({ [key]: local[key] })),
        set: vi.fn((items: Record<string, unknown>) => {
          Object.assign(local, items);
          return Promise.resolve();
        }),
        remove: vi.fn((key: string) => {
          delete local[key];
          return Promise.resolve();
        }),
      },
    },
    action: {
      setBadgeText: vi.fn(() => Promise.resolve()),
      setBadgeBackgroundColor: vi.fn(() => Promise.resolve()),
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(() => Promise.resolve([])),
      registerContentScripts: vi.fn(() => Promise.resolve()),
      updateContentScripts: vi.fn(() => Promise.resolve()),
      unregisterContentScripts: vi.fn(() => Promise.resolve()),
    },
    permissions: {
      contains: vi.fn(() => Promise.resolve(true)),
    },
    tabs: {
      query: vi.fn(() => Promise.resolve([{ id: 1 }, { id: 2 }])),
      sendMessage: vi.fn((tabId: number, message: unknown) => {
        sentToTabs.push({ tabId, message });
        return Promise.resolve();
      }),
    },
  };
}

/** Deliver a message the way `chrome.runtime.sendMessage` would. */
function send(
  payload: unknown,
  sender: chrome.runtime.MessageSender = FROM_OPTIONS,
): Promise<WorkerResponse> {
  return new Promise((resolve) => {
    const handled = messageListener?.(
      { source: MESSAGE_SOURCE, payload },
      sender,
      resolve as (response: unknown) => void,
    );
    // The worker must keep the channel open for its async reply.
    expect(handled).toBe(true);
  });
}

/** A content script: its origin is the host page's, not the extension's. */
const FROM_TAB: chrome.runtime.MessageSender = {
  id: EXTENSION_ID,
  tab: { id: 1 } as chrome.tabs.Tab,
  url: 'http://localhost:5173/quiz',
  origin: 'http://localhost:5173',
};

/**
 * The options page. It carries a `tab` too, because `open_in_tab` puts it in
 * one - which is why the sender check has to look at the origin instead.
 */
const FROM_OPTIONS: chrome.runtime.MessageSender = {
  id: EXTENSION_ID,
  tab: { id: 9 } as chrome.tabs.Tab,
  url: `chrome-extension://${EXTENSION_ID}/options.html`,
  origin: `chrome-extension://${EXTENSION_ID}`,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(async () => {
  sentToTabs = [];
  messageListener = undefined;
  storage = {};
  local = {};
  vi.stubGlobal('chrome', fakeChrome());
  vi.resetModules();
  await import('../src/background/service-worker');
  expect(messageListener).toBeTypeOf('function');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('content script → service worker → backend → content script', () => {
  it('answers a detected question and returns it to the content script', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return Promise.resolve(jsonResponse({ data: ANSWER, meta: { cached: false } }));
      }),
    );

    const response = await send(
      { kind: 'question:detected', fingerprint: 'abc123', request: REQUEST },
      FROM_TAB,
    );

    expect(response).toEqual({ ok: true, kind: 'answer', answer: ANSWER, cached: false });
    expect(calls[0]?.url).toBe(`${DEFAULT_SETTINGS.backendUrl}/api/questions/answer`);
    expect(calls[0]?.body).toMatchObject({
      question: REQUEST.question,
      type: 'multiple_choice',
      options: REQUEST.options,
    });
  });

  it('serves the second identical question from the worker cache', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ data: ANSWER })));
    vi.stubGlobal('fetch', fetchMock);

    const message = { kind: 'question:detected', fingerprint: 'abc123', request: REQUEST };
    const first = await send(message, FROM_TAB);
    const second = await send(message, FROM_TAB);

    expect(first).toMatchObject({ cached: false });
    expect(second).toMatchObject({ cached: true, answer: ANSWER });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces two tabs asking the same question into one backend call', async () => {
    let release: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const message = { kind: 'question:detected', fingerprint: 'abc123', request: REQUEST };
    const both = Promise.all([
      send(message, FROM_TAB),
      send(message, { ...FROM_TAB, tab: { id: 2 } as chrome.tabs.Tab }),
    ]);

    // Both messages have to reach the in-flight map before the call resolves,
    // which is the condition the coalescing is supposed to handle.
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    release(jsonResponse({ data: ANSWER }));
    const [a, b] = await both;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ ok: true, answer: ANSWER });
    expect(b).toMatchObject({ ok: true, answer: ANSWER });
  });

  it('passes a backend failure back to the content script as a code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({ error: { code: 'rate_limited', message: 'Too many requests.' } }, 429),
        ),
      ),
    );

    const response = await send(
      { kind: 'question:detected', fingerprint: 'abc123', request: REQUEST },
      FROM_TAB,
    );

    expect(response).toEqual({ ok: false, code: 'rate_limited', error: 'Too many requests.' });
  });

  it('reports an unreachable backend without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

    const response = await send(
      { kind: 'question:detected', fingerprint: 'abc123', request: REQUEST },
      FROM_TAB,
    );

    expect(response).toMatchObject({ ok: false, code: 'network' });
  });
});

describe('the worker does not trust the content script', () => {
  it('rejects a question that fails re-validation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await send(
      { kind: 'question:detected', fingerprint: 'x', request: { question: 'hi' } },
      FROM_TAB,
    );

    expect(response).toMatchObject({ ok: false, code: 'bad_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops fields the content script should not be sending', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(jsonResponse({ data: ANSWER }));
      }),
    );

    await send(
      {
        kind: 'question:detected',
        fingerprint: 'abc123',
        request: { ...REQUEST, backendApiKey: 'stolen', options: ['O(n)', 'O(log n)', 42] },
      },
      FROM_TAB,
    );

    expect(bodies[0]).not.toHaveProperty('backendApiKey');
    expect(bodies[0]?.options).toEqual(['O(n)', 'O(log n)']);
  });

  it('refuses a settings change that arrives from a content script', async () => {
    const response = await send(
      { kind: 'settings:save', settings: { ...DEFAULT_SETTINGS, backendUrl: 'http://evil.test' } },
      FROM_TAB,
    );

    expect(response).toMatchObject({ ok: false, code: 'bad_request' });
    expect(storage[SETTINGS_STORAGE_KEY]).toBeUndefined();
  });

  it('accepts a settings change from the options page even though it is in a tab', async () => {
    const response = await send({
      kind: 'settings:save',
      settings: { ...DEFAULT_SETTINGS, autoFill: true },
    });

    expect(response).toMatchObject({ ok: true, kind: 'settings' });
    expect(storage[SETTINGS_STORAGE_KEY]).toMatchObject({ autoFill: true });
  });

  it('ignores a message that is not in our envelope', () => {
    const sendResponse = vi.fn();
    const handled = messageListener?.({ kind: 'question:detected' }, FROM_TAB, sendResponse);

    expect(handled).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('rejects an unsupported message kind', async () => {
    await expect(send({ kind: 'definitely:not:a:thing' }, FROM_TAB)).resolves.toMatchObject({
      ok: false,
      code: 'bad_request',
    });
  });
});

describe('options page → service worker → content scripts', () => {
  it('returns the current settings', async () => {
    const response = await send({ kind: 'settings:get' });
    expect(response).toEqual({ ok: true, kind: 'settings', settings: DEFAULT_SETTINGS });
  });

  it('saves settings and broadcasts them to every tab', async () => {
    const updated: ExtensionSettings = {
      ...DEFAULT_SETTINGS,
      provider: 'anthropic',
      autoFill: true,
      backendUrl: 'http://127.0.0.1:4000/',
    };

    const response = await send({ kind: 'settings:save', settings: updated });

    expect(response).toMatchObject({
      ok: true,
      kind: 'settings',
      // Sanitisation runs on the way in: the trailing slash is dropped.
      settings: { provider: 'anthropic', autoFill: true, backendUrl: 'http://127.0.0.1:4000' },
    });

    expect(sentToTabs.map((entry) => entry.tabId)).toEqual([1, 2]);
    expect(sentToTabs[0]?.message).toMatchObject(
      envelope({ kind: 'settings:changed', settings: expect.objectContaining({ provider: 'anthropic' }) }),
    );
  });

  it('registers content scripts for the origins the user opted in to', async () => {
    const chromeApi = globalThis.chrome as unknown as ReturnType<typeof fakeChrome>;

    await send({
      kind: 'settings:save',
      settings: { ...DEFAULT_SETTINGS, enabledOrigins: ['https://practice.example'] },
    });

    expect(chromeApi.scripting.registerContentScripts).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'user-origins',
        js: ['content.js'],
        matches: ['https://practice.example/*'],
      }),
    ]);
  });

  it('does not register a content script for an origin Chrome has not granted', async () => {
    const chromeApi = globalThis.chrome as unknown as ReturnType<typeof fakeChrome>;
    chromeApi.permissions.contains.mockResolvedValue(false);

    await send({
      kind: 'settings:save',
      settings: { ...DEFAULT_SETTINGS, enabledOrigins: ['https://practice.example'] },
    });

    expect(chromeApi.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it('stops answering when automatic detection is switched off', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await send({ kind: 'settings:save', settings: { ...DEFAULT_SETTINGS, autoDetect: false } });
    const response = await send(
      { kind: 'question:detected', fingerprint: 'abc123', request: REQUEST },
      FROM_TAB,
    );

    expect(response).toMatchObject({ ok: false, code: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the cache on request', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ data: ANSWER })));
    vi.stubGlobal('fetch', fetchMock);

    const message = { kind: 'question:detected', fingerprint: 'abc123', request: REQUEST };
    await send(message, FROM_TAB);
    await expect(send({ kind: 'cache:clear' })).resolves.toEqual({ ok: true, kind: 'ack' });
    await send(message, FROM_TAB);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports backend health for the options page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({ status: 'ok', activeProvider: 'openai', providers: ['openai', 'anthropic'] }),
        ),
      ),
    );

    await expect(send({ kind: 'backend:health' })).resolves.toEqual({
      ok: true,
      kind: 'health',
      activeProvider: 'openai',
      providers: ['openai', 'anthropic'],
    });
  });
});

describe('dynamic registration never doubles up on the manifest', () => {
  it('skips localhost, which the manifest already injects into', async () => {
    const chromeApi = globalThis.chrome as unknown as ReturnType<typeof fakeChrome>;

    await send({
      kind: 'settings:save',
      settings: {
        ...DEFAULT_SETTINGS,
        enabledOrigins: ['http://localhost:5173', 'http://127.0.0.1:8080'],
      },
    });

    // Both are covered by `http://localhost/*` and `http://127.0.0.1/*`;
    // registering them again would run the content script twice per page.
    expect(chromeApi.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it('registers only the origins the manifest does not cover', async () => {
    const chromeApi = globalThis.chrome as unknown as ReturnType<typeof fakeChrome>;

    await send({
      kind: 'settings:save',
      settings: {
        ...DEFAULT_SETTINGS,
        enabledOrigins: ['http://localhost:5173', 'https://practice.example'],
      },
    });

    expect(chromeApi.scripting.registerContentScripts).toHaveBeenCalledWith([
      expect.objectContaining({ matches: ['https://practice.example/*'] }),
    ]);
  });

  it('enables no site by default', async () => {
    const response = await send({ kind: 'settings:get' });
    expect(response).toMatchObject({ ok: true, settings: { enabledOrigins: [] } });
  });
});

describe('the backend keeps control of the provider by default', () => {
  it('sends no provider or model when the user has not chosen one', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(jsonResponse({ data: ANSWER }));
      }),
    );

    await send({ kind: 'question:detected', fingerprint: 'abc', request: REQUEST }, FROM_TAB);

    // Omitting them is what lets AI_PROVIDER / AI_MODEL on the server apply.
    expect(bodies[0]).not.toHaveProperty('provider');
    expect(bodies[0]).not.toHaveProperty('model');
  });

  it('sends the override once the user picks a provider', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(jsonResponse({ data: ANSWER }));
      }),
    );

    await send({
      kind: 'settings:save',
      settings: { ...DEFAULT_SETTINGS, provider: 'anthropic', model: 'claude-opus-5' },
    });
    await send({ kind: 'question:detected', fingerprint: 'abc', request: REQUEST }, FROM_TAB);

    expect(bodies[0]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' });
  });
});

describe('options page → service worker → server history', () => {
  const ENTRY = {
    id: '6ab6379dfa5d4668c71ca91d',
    createdAt: '2026-09-25T08:58:05.596Z',
    question: 'Which data structure uses FIFO ordering?',
    type: 'multiple_choice',
    options: ['Stack', 'Queue'],
    answer: 'Queue',
    explanation: 'First in, first out.',
    provider: 'openai',
    model: 'gpt-4o-mini',
    cached: false,
    latencyMs: 640,
    origin: 'https://quiz.example.com',
  };

  it('fetches a page of history, passing the cursor through', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url);
        return Promise.resolve(
          jsonResponse({ data: { entries: [ENTRY], nextBefore: ENTRY.createdAt }, meta: { enabled: true } }),
        );
      }),
    );

    const response = await send({ kind: 'history:list', limit: 25, before: '2026-09-26T00:00:00.000Z' });

    expect(response).toEqual({
      ok: true,
      kind: 'history',
      page: { enabled: true, entries: [ENTRY], nextBefore: ENTRY.createdAt },
    });
    expect(urls[0]).toBe(
      'http://127.0.0.1:3000/api/history?limit=25&before=2026-09-26T00%3A00%3A00.000Z',
    );
  });

  it('clamps the limit and drops a cursor that is not a date', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url);
        return Promise.resolve(jsonResponse({ data: { entries: [] }, meta: { enabled: true } }));
      }),
    );

    await send({ kind: 'history:list', limit: 5000, before: 'yesterday' });
    expect(urls[0]).toBe('http://127.0.0.1:3000/api/history?limit=100');
  });

  it('reports when the backend keeps no history', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ data: { entries: [] }, meta: { enabled: false } }))),
    );

    await expect(send({ kind: 'history:list' })).resolves.toMatchObject({
      ok: true,
      page: { enabled: false, entries: [] },
    });
  });

  it('fetches server statistics', async () => {
    const stats = {
      total: 3,
      today: 2,
      cached: 1,
      averageLatencyMs: 400,
      byProvider: [],
      byType: [],
      topOrigins: [{ origin: 'https://quiz.example.com', count: 3 }],
    };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ data: stats, meta: { enabled: true } }))));

    await expect(send({ kind: 'history:stats' })).resolves.toEqual({
      ok: true,
      kind: 'server-stats',
      stats: { ...stats, enabled: true },
    });
  });

  it('clears server history', async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        methods.push(init.method ?? 'GET');
        return Promise.resolve(jsonResponse({ data: { cleared: true, deleted: 4 } }));
      }),
    );

    await expect(send({ kind: 'history:clear' })).resolves.toEqual({
      ok: true,
      kind: 'history-cleared',
      deleted: 4,
    });
    expect(methods).toEqual(['POST']);
  });

  it('passes the backend API key message through when it is wrong', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({ error: { code: 'unauthorized', message: 'A valid x-api-key is required.' } }, 401),
        ),
      ),
    );

    await expect(send({ kind: 'history:list' })).resolves.toMatchObject({
      ok: false,
      error: 'A valid x-api-key is required.',
    });
  });

  it('never serves or clears server history for a content script', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const kind of ['history:list', 'history:stats', 'history:clear']) {
      await expect(send({ kind }, FROM_TAB)).resolves.toMatchObject({ ok: false, code: 'bad_request' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('includes the backend storage status in the health report', async () => {
    const persistence = { database: 'connected', cache: 'mongodb', history: true };
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(jsonResponse({ status: 'ok', activeProvider: 'openai', providers: ['openai'], persistence })),
      ),
    );

    await expect(send({ kind: 'backend:health' })).resolves.toMatchObject({ persistence });
  });
});
