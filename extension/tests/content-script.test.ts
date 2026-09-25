/**
 * The content script itself, driven end to end in a fake page.
 *
 * `content.ts` is a side-effect module: importing it is what starts it, the
 * same as Chrome injecting it. These tests fake `chrome.runtime`, let it run
 * against a real DOM, and assert on what it sends, what it fills in, and -
 * just as importantly - what it declines to do twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_SOURCE } from '../src/shared/messages';
import { DEFAULT_SETTINGS } from '../src/shared/constants';
import type { ExtensionSettings, QuestionAnswer, QuestionRequest } from '../src/shared/types';

type Sent = { kind: string; fingerprint?: string; request?: QuestionRequest };

const ANSWER: QuestionAnswer = {
  answer: 'O(log n)',
  explanation: 'Binary search halves the range each step.',
  provider: 'openai',
  model: 'gpt-4o-mini',
};

/** One question, so the content script's inter-request throttle never fires. */
const ONE_QUESTION = `
  <main>
    <section class="question">
      <p class="prompt">What is the time complexity of binary search?</p>
      <label><input type="radio" name="q1" value="a" /> O(n)</label>
      <label><input type="radio" name="q1" value="b" /> O(log n)</label>
    </section>
  </main>`;

let sent: Sent[] = [];
let settings: ExtensionSettings;
let respond: (message: Sent) => unknown;
let pageListener: ((message: unknown) => unknown) | undefined;

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/**
 * Let the script load settings, run its debounced scan, and work through the
 * throttle it puts between consecutive questions.
 */
async function boot(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await flush();
    vi.advanceTimersByTime(500);
  }
  await flush();
}

function installChrome(): void {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async (envelope: { source: string; payload: Sent }) => {
        expect(envelope.source).toBe(MESSAGE_SOURCE);
        sent.push(envelope.payload);
        return respond(envelope.payload);
      }),
      onMessage: {
        addListener: vi.fn((listener: (message: unknown) => unknown) => {
          pageListener = listener;
        }),
      },
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  pageListener = undefined;
  settings = { ...DEFAULT_SETTINGS, autoFill: false };

  respond = (message) => {
    if (message.kind === 'settings:get') return { ok: true, kind: 'settings', settings };
    if (message.kind === 'question:detected') {
      return { ok: true, kind: 'answer', answer: ANSWER, cached: false };
    }
    return { ok: false, code: 'bad_request', error: 'unsupported' };
  };

  // Each test gets a brand new document element. A content script from an
  // earlier test keeps its observer attached to the old one, which is then
  // detached and inert - otherwise two instances would scan the same page.
  document.replaceChild(document.createElement('html'), document.documentElement);
  document.documentElement.innerHTML = `<head></head><body>${ONE_QUESTION}</body>`;
  installChrome();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('content script', () => {
  it('asks the worker for settings before doing anything else', async () => {
    await import('../src/content/content');
    await flush();

    expect(sent[0]).toEqual({ kind: 'settings:get' });
  });

  it('sends each detected question to the worker', async () => {
    await import('../src/content/content');
    await boot();

    const questions = sent.filter((message) => message.kind === 'question:detected');
    expect(questions).toHaveLength(1);
    expect(questions[0]?.request).toMatchObject({
      question: 'What is the time complexity of binary search?',
      type: 'multiple_choice',
      options: ['O(n)', 'O(log n)'],
    });
    expect(questions[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('records the page as the source', async () => {
    document.title = 'Practice quiz';
    await import('../src/content/content');
    await boot();

    expect(sent[1]?.request?.source).toMatchObject({ title: 'Practice quiz' });
  });

  it('does not ask about the same question twice', async () => {
    await import('../src/content/content');
    await boot();

    // A re-render: same question, brand new DOM nodes.
    const section = document.querySelector('.question') as HTMLElement;
    section.replaceWith(section.cloneNode(true));
    await boot();

    expect(sent.filter((message) => message.kind === 'question:detected')).toHaveLength(1);
  });

  it('picks up a question added after the first scan', async () => {
    await import('../src/content/content');
    await boot();

    const extra = document.createElement('section');
    extra.className = 'question';
    extra.innerHTML = `
      <p class="prompt">Which keyword declares a block-scoped constant?</p>
      <label><input type="radio" name="q2" value="a" /> var</label>
      <label><input type="radio" name="q2" value="b" /> const</label>`;
    document.querySelector('main')?.append(extra);

    await boot();

    const questions = sent.filter((message) => message.kind === 'question:detected');
    expect(questions).toHaveLength(2);
    expect(questions[1]?.request?.question).toContain('block-scoped constant');
  });

  it('leaves the page alone when auto-fill is off', async () => {
    await import('../src/content/content');
    await boot();

    expect(document.querySelectorAll('input:checked')).toHaveLength(0);
  });

  it('fills the answer in when auto-fill is on', async () => {
    settings = { ...DEFAULT_SETTINGS, autoFill: true };
    await import('../src/content/content');
    await boot();

    const chosen = document.querySelector<HTMLInputElement>('input[value="b"]');
    expect(chosen?.checked).toBe(true);
  });

  it('adds no UI of its own to the page', async () => {
    settings = { ...DEFAULT_SETTINGS, autoFill: true };
    const before = document.body.querySelectorAll('*').length;

    await import('../src/content/content');
    await boot();

    expect(document.body.querySelectorAll('*').length).toBe(before);
    // Nothing of ours in the markup: no wrapper, badge, panel or data hook.
    expect(document.body.innerHTML).not.toMatch(/ai-|assistant|data-ai|aria-live/i);
    expect(document.querySelectorAll('[class*="ai" i], [id*="ai" i]')).toHaveLength(0);
  });

  it('stays idle when automatic detection is switched off', async () => {
    settings = { ...DEFAULT_SETTINGS, autoDetect: false };
    await import('../src/content/content');
    await boot();

    expect(sent.filter((message) => message.kind === 'question:detected')).toHaveLength(0);
  });

  it('retries a question the backend could not be reached for', async () => {
    let attempt = 0;
    respond = (message) => {
      if (message.kind === 'settings:get') return { ok: true, kind: 'settings', settings };
      attempt += 1;
      if (attempt === 1) return { ok: false, code: 'network', error: 'unreachable' };
      return { ok: true, kind: 'answer', answer: ANSWER, cached: false };
    };

    await import('../src/content/content');
    await boot();
    expect(attempt).toBe(1);

    // A later scan should try the same question again.
    document.querySelector('main')?.append(document.createTextNode('tick'));
    await boot();

    expect(attempt).toBe(2);
  });

  it('does not retry a question the backend rejected', async () => {
    let attempt = 0;
    respond = (message) => {
      if (message.kind === 'settings:get') return { ok: true, kind: 'settings', settings };
      attempt += 1;
      return { ok: false, code: 'bad_request', error: 'no' };
    };

    await import('../src/content/content');
    await boot();
    document.querySelector('main')?.append(document.createTextNode('tick'));
    await boot();

    expect(attempt).toBe(1);
  });

  it('survives the worker being asleep', async () => {
    respond = () => {
      throw new Error('Could not establish connection.');
    };

    await expect(import('../src/content/content')).resolves.toBeDefined();
    await boot();

    // No settings means no scanning, and no unhandled rejection either.
    expect(sent.filter((message) => message.kind === 'question:detected')).toHaveLength(0);
  });

  it('rescans when the options page changes settings', async () => {
    settings = { ...DEFAULT_SETTINGS, autoDetect: false };
    await import('../src/content/content');
    await boot();
    expect(sent.filter((message) => message.kind === 'question:detected')).toHaveLength(0);

    settings = { ...DEFAULT_SETTINGS, autoDetect: true };
    pageListener?.({
      source: MESSAGE_SOURCE,
      payload: { kind: 'settings:changed', settings },
    });
    await boot();

    expect(sent.filter((message) => message.kind === 'question:detected')).toHaveLength(1);
  });

  it('ignores a message that did not come from the extension', async () => {
    await import('../src/content/content');
    await boot();
    const before = sent.length;

    // Page script trying to impersonate the worker.
    pageListener?.({ kind: 'settings:changed', settings: { ...DEFAULT_SETTINGS, autoFill: true } });
    await boot();

    expect(sent).toHaveLength(before);
    expect(document.querySelectorAll('input:checked')).toHaveLength(0);
  });
});
