/**
 * The options page.
 *
 * Rendered for real against a faked `chrome`, so these cover what matters
 * about this screen: that it round-trips settings through the service worker
 * rather than touching storage itself, that host access is requested from a
 * genuine click, and that the monitor and log read what the worker reports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/options/App';
import { DEFAULT_SETTINGS } from '../src/shared/constants';
import { MESSAGE_SOURCE } from '../src/shared/messages';
import type { ActivityEntry, ExtensionSettings } from '../src/shared/types';

type Sent = { kind: string; settings?: ExtensionSettings };
type TabName = 'Monitor' | 'Settings' | 'Sites' | 'Activity log';

let sent: Sent[] = [];
let stored: ExtensionSettings;
let log: ActivityEntry[] = [];
let respond: (message: Sent) => unknown;
let permissionGranted = true;
let permissionRequests: unknown[] = [];
let permissionRemovals: unknown[] = [];

function logEntry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: `e${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    origin: 'https://practice.example',
    url: 'https://practice.example/quiz/1',
    title: 'Practice quiz',
    fingerprint: 'fp1',
    type: 'multiple_choice',
    optionCount: 4,
    question: 'What is the time complexity of binary search?',
    answer: 'O(log n)',
    provider: 'openai',
    model: 'gpt-4o-mini',
    latencyMs: 812,
    outcome: 'answered',
    ...overrides,
  };
}

function defaultRespond(message: Sent): unknown {
  switch (message.kind) {
    case 'settings:get':
      return { ok: true, kind: 'settings', settings: stored };
    case 'settings:save':
      stored = message.settings as ExtensionSettings;
      return { ok: true, kind: 'settings', settings: stored };
    case 'backend:health':
      return { ok: true, kind: 'health', activeProvider: 'openai', providers: ['openai'] };
    case 'run:get':
    case 'run:pause':
    case 'run:resume':
      return {
        ok: true,
        kind: 'run',
        status: {
          status: message.kind === 'run:pause' ? 'paused' : 'running',
          startsInMs: 0,
          answeredTotal: 7,
          answeredToday: 3,
          lastActivityAt: Date.now() - 20_000,
        },
      };
    case 'log:list':
      return { ok: true, kind: 'log', entries: log };
    case 'log:stats':
      return {
        ok: true,
        kind: 'stats',
        stats: {
          total: 7,
          today: 3,
          errors: 1,
          cached: 1,
          lastAt: Date.now() - 20_000,
          byOrigin: [{ origin: 'https://practice.example', count: 7 }],
        },
      };
    case 'log:clear':
      log = [];
      return { ok: true, kind: 'ack' };
    default:
      return { ok: true, kind: 'ack' };
  }
}

function installChrome(): void {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async (env: { source: string; payload: Sent }) => {
        expect(env.source).toBe(MESSAGE_SOURCE);
        sent.push(env.payload);
        return respond(env.payload);
      }),
    },
    permissions: {
      contains: vi.fn(() => Promise.resolve(true)),
      request: vi.fn((request: unknown) => {
        permissionRequests.push(request);
        return Promise.resolve(permissionGranted);
      }),
      remove: vi.fn((request: unknown) => {
        permissionRemovals.push(request);
        return Promise.resolve(true);
      }),
    },
  });
}

beforeEach(() => {
  sent = [];
  permissionRequests = [];
  permissionRemovals = [];
  permissionGranted = true;
  stored = { ...DEFAULT_SETTINGS };
  log = [logEntry()];
  respond = defaultRespond;
  // Node 25's own experimental `localStorage` global shadows jsdom's, so
  // give each test a fresh, working one.
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, String(value)),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  });
  installChrome();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Render, wait for the initial load, then switch to `tab`. */
async function open(tab: TabName = 'Monitor') {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('button', { name: 'Settings' });

  if (tab !== 'Monitor') {
    await user.click(screen.getByRole('button', { name: tab }));
  }
  if (tab === 'Settings') await screen.findByLabelText('Provider');
  return user;
}

describe('shell', () => {
  it('opens on the monitor and offers every section', async () => {
    await open();
    for (const tab of ['Monitor', 'Settings', 'Sites', 'Activity log']) {
      expect(screen.getByRole('button', { name: tab })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Monitor' }).getAttribute('aria-current')).toBe('page');
  });

  it('loads the stored settings once', async () => {
    await open();
    expect(sent.filter((message) => message.kind === 'settings:get')).toHaveLength(1);
  });
});

describe('monitor', () => {
  it('shows the run state and the counters', async () => {
    await open();
    expect(await screen.findByText('Running')).toBeTruthy();
    expect(screen.getByText('answered today')).toBeTruthy();
    expect(screen.getByText('errors')).toBeTruthy();
  });

  it('pauses from the monitor', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Pause' }));

    expect(sent.some((message) => message.kind === 'run:pause')).toBe(true);
    expect(await screen.findByText('Paused')).toBeTruthy();
  });

  it('reports a successful backend check', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByText(/Reachable/)).toBeTruthy();
  });

  it('shows the error when the backend cannot be reached', async () => {
    respond = (message) =>
      message.kind === 'backend:health'
        ? { ok: false, code: 'network', error: 'Could not reach the backend at http://localhost:3000.' }
        : defaultRespond(message);

    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByText(/Could not reach the backend/)).toBeTruthy();
  });

  it('lists recent activity', async () => {
    await open();
    expect(await screen.findByText(/time complexity of binary search/)).toBeTruthy();
  });
});

describe('settings', () => {
  it('loads the current values', async () => {
    stored = { ...DEFAULT_SETTINGS, provider: 'anthropic', backendUrl: 'http://127.0.0.1:4000' };
    await open('Settings');

    expect(screen.getByLabelText<HTMLSelectElement>('Provider').value).toBe('anthropic');
    expect(screen.getByLabelText<HTMLInputElement>('Backend URL').value).toBe('http://127.0.0.1:4000');
  });

  it('offers every provider, defaulting to the backend', async () => {
    await open('Settings');
    const options = within(screen.getByLabelText('Provider')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      "Use the backend's configured provider",
      'OpenAI',
      'Google Gemini',
      'Anthropic Claude',
      'OpenAI-compatible endpoint',
    ]);
  });

  it('saves edited settings through the worker', async () => {
    const user = await open('Settings');

    await user.selectOptions(screen.getByLabelText('Provider'), 'gemini');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Settings saved.');
    expect(stored.provider).toBe('gemini');
  });

  it('keeps the save button inert until something changes', async () => {
    await open('Settings');
    expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(true);
  });

  it('warns about unsaved changes and can revert them', async () => {
    const user = await open('Settings');

    await user.click(screen.getByRole('checkbox', { name: /Fill answers into the page/ }));
    expect(await screen.findByText('Unsaved changes')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Revert' }));
    expect(await screen.findByText('All changes saved')).toBeTruthy();
    expect(sent.some((message) => message.kind === 'settings:save')).toBe(false);
  });

  it('toggles behaviour switches', async () => {
    const user = await open('Settings');

    await user.click(screen.getByRole('checkbox', { name: /Fill answers into the page/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Settings saved.');
    expect(stored.autoFill).toBe(true);
  });

  it('sets the start delay from a preset', async () => {
    const user = await open('Settings');

    await user.click(screen.getByRole('button', { name: 'After 5 minutes' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Settings saved.');
    expect(stored.startDelayMs).toBe(300_000);
  });

  it('sets the delay between answers from a preset', async () => {
    const user = await open('Settings');

    await user.click(screen.getByRole('button', { name: '10 seconds' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Settings saved.');
    expect(stored.answerDelayMs).toBe(10_000);
  });

  it('never renders the backend key as readable text', async () => {
    stored = { ...DEFAULT_SETTINGS, backendApiKey: 'super-secret' };
    await open('Settings');

    expect(screen.getByLabelText('Backend access key').getAttribute('type')).toBe('password');
    expect(document.body.textContent).not.toContain('super-secret');
  });

  describe('own API key', () => {
    const health = (configured: boolean, clientCredentials = true) => ({
      ok: true,
      kind: 'health',
      activeProvider: 'openai',
      providers: configured ? ['gemini'] : [],
      clientCredentials,
      allProviders: [
        { id: 'openai', label: 'OpenAI', configured: false, defaultModel: 'gpt-4o-mini' },
        { id: 'gemini', label: 'Google Gemini', configured, defaultModel: 'gemini-3.5-flash' },
        { id: 'openai-compatible', label: 'OpenAI-compatible endpoint', configured: false, defaultModel: '' },
      ],
    });

    it("asks for no key while the backend's provider is selected", async () => {
      await open('Settings');
      expect(screen.queryByLabelText('API key')).toBeNull();
    });

    it('takes a key for the chosen provider and saves it', async () => {
      respond = (message) => (message.kind === 'backend:health' ? health(false) : defaultRespond(message));
      const user = await open('Settings');

      await user.selectOptions(screen.getByLabelText('Provider'), 'gemini');
      expect(await screen.findByText(/Required: the backend has no key for this provider/)).toBeTruthy();
      expect(screen.getByLabelText<HTMLInputElement>('Model').placeholder).toBe('gemini-3.5-flash');

      const key = screen.getByLabelText<HTMLInputElement>('API key');
      expect(key.type).toBe('password');
      await user.type(key, 'g-user-key');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      await screen.findByText('Settings saved.');
      expect(stored).toMatchObject({ provider: 'gemini', aiApiKey: 'g-user-key' });
    });

    it('shows the key only on request', async () => {
      stored = { ...DEFAULT_SETTINGS, provider: 'gemini', aiApiKey: 'g-user-key' };
      const user = await open('Settings');

      const key = screen.getByLabelText<HTMLInputElement>('API key');
      expect(key.type).toBe('password');
      await user.click(screen.getByRole('button', { name: 'Show' }));
      expect(key.type).toBe('text');
    });

    it('asks for an endpoint and model with a key for an OpenAI-compatible provider', async () => {
      const user = await open('Settings');
      await user.selectOptions(screen.getByLabelText('Provider'), 'openai-compatible');
      await user.type(screen.getByLabelText('API key'), 'k');

      expect(screen.getByText('Enter the endpoint base URL to use your own key.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Test provider' }).hasAttribute('disabled')).toBe(true);

      await user.type(screen.getByLabelText('Endpoint base URL'), 'not a url');
      expect(screen.getByText('Not a valid http(s) URL.')).toBeTruthy();
    });

    it('tests the unsaved settings and reports the result', async () => {
      respond = (message) =>
        message.kind === 'provider:test'
          ? {
              ok: true,
              kind: 'provider-test',
              result: { provider: 'gemini', model: 'gemini-3.5-flash', answer: '4', latencyMs: 1400 },
            }
          : defaultRespond(message);
      const user = await open('Settings');

      await user.selectOptions(screen.getByLabelText('Provider'), 'gemini');
      await user.type(screen.getByLabelText('API key'), 'g-user-key');
      await user.click(screen.getByRole('button', { name: 'Test provider' }));

      expect(await screen.findByText('gemini · gemini-3.5-flash answered "4" in 1.4s.')).toBeTruthy();
      const test = sent.find((message) => message.kind === 'provider:test');
      expect(test?.settings).toMatchObject({ provider: 'gemini', aiApiKey: 'g-user-key' });
      expect(sent.some((message) => message.kind === 'settings:save')).toBe(false);
    });

    it('shows why a test failed', async () => {
      respond = (message) =>
        message.kind === 'provider:test'
          ? { ok: false, code: 'provider_error', error: 'API key not valid. Please pass a valid API key.' }
          : defaultRespond(message);
      const user = await open('Settings');

      await user.selectOptions(screen.getByLabelText('Provider'), 'gemini');
      await user.click(screen.getByRole('button', { name: 'Test provider' }));

      expect(await screen.findByText('API key not valid. Please pass a valid API key.')).toBeTruthy();
    });

    it('warns when the backend will refuse the key', async () => {
      respond = (message) => (message.kind === 'backend:health' ? health(true, false) : defaultRespond(message));
      stored = { ...DEFAULT_SETTINGS, provider: 'gemini', aiApiKey: 'g-user-key' };
      await open('Settings');

      expect(await screen.findByText(/This backend does not accept keys from the extension/)).toBeTruthy();
    });
  });

  it('clears the cached answers', async () => {
    const user = await open('Settings');
    await user.click(screen.getByRole('button', { name: 'Clear cached answers' }));

    await screen.findByText('Cached answers cleared.');
    expect(sent.some((message) => message.kind === 'cache:clear')).toBe(true);
  });
});

describe('sites', () => {
  it('requests host permission when a site is added', async () => {
    stored = { ...DEFAULT_SETTINGS, enabledOrigins: [] };
    const user = await open('Sites');

    await user.type(screen.getByLabelText('Site to enable'), 'https://practice.example.com');
    await user.click(screen.getByRole('button', { name: 'Add site' }));

    await screen.findByText('https://practice.example.com');
    expect(permissionRequests).toEqual([{ origins: ['https://practice.example.com/*'] }]);
  });

  it('normalises a pasted URL down to its origin', async () => {
    stored = { ...DEFAULT_SETTINGS, enabledOrigins: [] };
    const user = await open('Sites');

    await user.type(
      screen.getByLabelText('Site to enable'),
      'https://practice.example.com/quiz/12?x=1',
    );
    await user.click(screen.getByRole('button', { name: 'Add site' }));

    await screen.findByText('https://practice.example.com');
  });

  it('does not add the site when Chrome denies access', async () => {
    permissionGranted = false;
    stored = { ...DEFAULT_SETTINGS, enabledOrigins: [] };
    const user = await open('Sites');

    await user.type(screen.getByLabelText('Site to enable'), 'https://practice.example.com');
    await user.click(screen.getByRole('button', { name: 'Add site' }));

    await screen.findByText('Chrome denied access to that site.');
    expect(screen.queryByText('https://practice.example.com')).toBeNull();
  });

  it('rejects something that is not a site', async () => {
    const user = await open('Sites');

    await user.type(screen.getByLabelText('Site to enable'), 'not a url at all');
    await user.click(screen.getByRole('button', { name: 'Add site' }));

    await screen.findByText(/Enter a site address/);
    expect(permissionRequests).toHaveLength(0);
  });

  it('revokes the permission when a site is removed', async () => {
    stored = { ...DEFAULT_SETTINGS, enabledOrigins: ['https://practice.example.com'] };
    const user = await open('Sites');

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByText('https://practice.example.com')).toBeNull());
    expect(permissionRemovals).toEqual([{ origins: ['https://practice.example.com/*'] }]);
  });
});

describe('activity log', () => {
  it('lists entries with their outcome', async () => {
    log = [
      logEntry({ question: 'First logged question about arrays', outcome: 'answered' }),
      logEntry({ question: 'Second logged question about trees', outcome: 'cached' }),
    ];

    await open('Activity log');

    expect(await screen.findByText(/First logged question/)).toBeTruthy();
    expect(screen.getByText(/Second logged question/)).toBeTruthy();
    expect(screen.getByText('cached')).toBeTruthy();
  });

  it('filters down to errors', async () => {
    log = [
      logEntry({ question: 'A question that worked fine', outcome: 'answered' }),
      logEntry({ question: 'A question that failed badly', outcome: 'error', error: 'rate limited' }),
    ];

    const user = await open('Activity log');
    await user.click(screen.getByRole('button', { name: 'Errors' }));

    expect(screen.queryByText(/worked fine/)).toBeNull();
    expect(screen.getByText(/failed badly/)).toBeTruthy();
  });

  it('searches across questions and answers', async () => {
    log = [
      logEntry({ question: 'Something about polymorphism here', answer: 'A' }),
      logEntry({ question: 'Something about recursion here', answer: 'B' }),
    ];

    const user = await open('Activity log');
    await user.type(screen.getByLabelText('Search the log'), 'recursion');

    expect(screen.queryByText(/polymorphism/)).toBeNull();
    expect(screen.getByText(/recursion/)).toBeTruthy();
  });

  it('expands an entry to show the detail', async () => {
    log = [logEntry({ question: 'A question with detail behind it', model: 'gpt-4o-mini' })];

    const user = await open('Activity log');
    await user.click(screen.getByText(/A question with detail/));

    expect(await screen.findByText(/gpt-4o-mini/)).toBeTruthy();
  });

  it('clears the log', async () => {
    const user = await open('Activity log');
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(sent.some((message) => message.kind === 'log:clear')).toBe(true);
    await waitFor(() => expect(screen.getByText(/The log is empty/)).toBeTruthy());
  });

  it('says so when nothing has happened yet', async () => {
    log = [];
    await open('Activity log');
    expect(await screen.findByText(/The log is empty/)).toBeTruthy();
  });
});

describe('server history', () => {
  const SERVER_ENTRY = {
    id: '6ab6379dfa5d4668c71ca91d',
    createdAt: new Date().toISOString(),
    question: 'Which data structure uses FIFO ordering?',
    type: 'multiple_choice',
    options: ['Stack', 'Queue'],
    answer: 'Queue',
    explanation: 'First in, first out.',
    provider: 'openai',
    model: 'gpt-4o-mini',
    cached: true,
    latencyMs: 12,
    origin: 'https://quiz.example.com',
  };

  function withServer(options: { enabled?: boolean; error?: string } = {}) {
    respond = (message) => {
      if (options.error && message.kind.startsWith('history:')) {
        return { ok: false, code: 'bad_request', error: options.error };
      }
      switch (message.kind) {
        case 'history:list':
          return {
            ok: true,
            kind: 'history',
            page: { enabled: options.enabled ?? true, entries: options.enabled === false ? [] : [SERVER_ENTRY] },
          };
        case 'history:stats':
          return {
            ok: true,
            kind: 'server-stats',
            stats: {
              enabled: options.enabled ?? true,
              total: 42,
              today: 5,
              cached: 9,
              averageLatencyMs: 640,
              byProvider: [],
              byType: [],
              topOrigins: [{ origin: 'https://quiz.example.com', count: 42 }],
            },
          };
        case 'history:clear':
          return { ok: true, kind: 'history-cleared', deleted: 42 };
        default:
          return defaultRespond(message);
      }
    };
  }

  it('shows server counters and recent questions on the monitor', async () => {
    withServer();
    const user = await open('Monitor');
    await user.click(await screen.findByRole('button', { name: 'Server' }));

    expect(await screen.findByText('answered in total')).toBeTruthy();
    expect(screen.getAllByText('42').length).toBeGreaterThan(0);
    expect(screen.getByText('640 ms')).toBeTruthy();
    expect(screen.getByText('average response')).toBeTruthy();
    expect(screen.getByText(/Which data structure uses FIFO/)).toBeTruthy();
  });

  it('lists server history in the activity log, with the explanation in the detail', async () => {
    withServer();
    const user = await open('Activity log');
    await user.click(screen.getByRole('button', { name: 'Server' }));

    await user.click(await screen.findByText(/Which data structure uses FIFO/));
    expect(await screen.findByText('First in, first out.')).toBeTruthy();
    expect(screen.getByText(/1 of 1 entry on the server/)).toBeTruthy();
  });

  it('offers only the filters the server can answer', async () => {
    withServer();
    const user = await open('Activity log');
    await user.click(screen.getByRole('button', { name: 'Server' }));
    await screen.findByText(/Which data structure uses FIFO/);

    expect(screen.queryByRole('button', { name: 'Errors' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'No match' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cached' })).toBeTruthy();
  });

  it('asks twice before deleting server history', async () => {
    withServer();
    const user = await open('Activity log');
    await user.click(screen.getByRole('button', { name: 'Server' }));
    await screen.findByText(/Which data structure uses FIFO/);

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(sent.some((message) => message.kind === 'history:clear')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Delete from server?' }));
    expect(sent.some((message) => message.kind === 'history:clear')).toBe(true);
    expect(await screen.findByText(/Deleted 42 entries from the server/)).toBeTruthy();
  });

  it('explains when the backend keeps no history', async () => {
    withServer({ enabled: false });
    const user = await open('Activity log');
    await user.click(screen.getByRole('button', { name: 'Server' }));

    expect(await screen.findByText(/not keeping history/)).toBeTruthy();
  });

  it('shows the backend error, such as a wrong API key', async () => {
    withServer({ error: 'A valid x-api-key is required.' });
    const user = await open('Activity log');
    await user.click(screen.getByRole('button', { name: 'Server' }));

    expect(await screen.findByText('A valid x-api-key is required.')).toBeTruthy();
  });

  it('remembers the chosen source', async () => {
    withServer();
    const user = await open('Activity log');
    await user.click(screen.getByRole('button', { name: 'Server' }));
    await screen.findByText(/Which data structure uses FIFO/);
    cleanup();

    await open('Activity log');
    expect(await screen.findByText(/on the server/)).toBeTruthy();
  });
});
