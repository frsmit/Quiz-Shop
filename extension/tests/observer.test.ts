/**
 * The MutationObserver wrapper.
 *
 * What matters here is what it *doesn't* do: a re-rendering SPA produces a
 * continuous stream of mutation records, and every one of them that reaches
 * a scan costs a full DOM walk. These tests pin the filtering and the
 * debouncing that keep that cost bounded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageObserver } from '../src/content/observer';

/** MutationObserver delivers its records in a microtask, which fake timers
 *  do not hold back - so a flush is needed before advancing the clock. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function settle(ms = 500): Promise<void> {
  await flush();
  vi.advanceTimersByTime(ms);
  await flush();
}

/** Every observer built by a test, so none is left connected at teardown. */
const observers: Array<{ stop: () => void }> = [];

function makeObserver(onScan: () => void) {
  const observer = createPageObserver({ onScan, debounceMs: 400 });
  observers.push(observer);
  return observer;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<main id="root"></main>';
});

afterEach(() => {
  while (observers.length) observers.pop()?.stop();
  vi.useRealTimers();
});

function root(): HTMLElement {
  return document.getElementById('root') as HTMLElement;
}

describe('createPageObserver', () => {
  it('scans once shortly after starting', async () => {
    const onScan = vi.fn();
    const observer = makeObserver(onScan);

    observer.start();
    expect(onScan).not.toHaveBeenCalled(); // debounced, not immediate

    vi.advanceTimersByTime(400);
    expect(onScan).toHaveBeenCalledTimes(1);

    observer.stop();
  });

  it('coalesces a burst of mutations into a single scan', async () => {
    const onScan = vi.fn();
    const observer = makeObserver(onScan);
    observer.start();
    await settle();
    onScan.mockClear();

    for (let i = 0; i < 50; i += 1) {
      const node = document.createElement('div');
      node.textContent = `question ${i}`;
      root().append(node);
    }

    await settle();
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('restarts the debounce while mutations keep arriving', async () => {
    const onScan = vi.fn();
    const observer = makeObserver(onScan);
    observer.start();
    await settle();
    onScan.mockClear();

    for (let i = 0; i < 4; i += 1) {
      const node = document.createElement('p');
      node.textContent = `chunk ${i}`;
      root().append(node);
      await flush();
      vi.advanceTimersByTime(300); // always shorter than the debounce
    }
    expect(onScan).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('ignores mutations that cannot have introduced a question', async () => {
    const onScan = vi.fn();
    const observer = makeObserver(onScan);
    observer.start();
    await settle();
    onScan.mockClear();

    // Empty wrappers: no text, no controls, nothing to detect.
    for (let i = 0; i < 10; i += 1) {
      root().append(document.createElement('div'));
    }

    await settle();
    expect(onScan).not.toHaveBeenCalled();
  });

  it('reacts to an inserted answer control even with no text', async () => {
    const onScan = vi.fn();
    const observer = makeObserver(onScan);
    observer.start();
    await settle();
    onScan.mockClear();

    const wrapper = document.createElement('div');
    wrapper.append(document.createElement('input'));
    root().append(wrapper);

    await settle();
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('reacts to a removed question', async () => {
    const question = document.createElement('div');
    question.textContent = 'Which one is correct?';
    root().append(question);

    const onScan = vi.fn();
    const observer = makeObserver(onScan);
    observer.start();
    await settle();
    onScan.mockClear();

    question.remove();

    await settle();
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('reacts to text changing in place', async () => {
    const question = document.createElement('p');
    question.textContent = 'Question one';
    root().append(question);

    const onScan = vi.fn();
    const observer = makeObserver(onScan);
    observer.start();
    await settle();
    onScan.mockClear();

    (question.firstChild as Text).data = 'Question two';

    await settle();
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('watches only the attributes it cares about', async () => {
    const node = document.createElement('div');
    node.textContent = 'Which one is correct?';
    root().append(node);

    const onScan = vi.fn();
    const observer = makeObserver(onScan);
    observer.start();
    await settle();
    onScan.mockClear();

    node.setAttribute('style', 'color: red');
    node.setAttribute('class', 'highlighted');
    await settle();
    expect(onScan).not.toHaveBeenCalled();

    node.setAttribute('hidden', '');
    await settle();
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('stops scanning once stopped, including a pending scan', async () => {
    const onScan = vi.fn();
    const observer = makeObserver(onScan);
    observer.start();
    await settle();
    onScan.mockClear();

    const node = document.createElement('div');
    node.textContent = 'Which one is correct?';
    root().append(node);
    await flush();

    observer.stop();
    await settle();
    expect(onScan).not.toHaveBeenCalled();
  });

  it('can be scanned on demand without a mutation', async () => {
    const onScan = vi.fn();
    const observer = makeObserver(onScan);
    observer.start();
    await settle();
    onScan.mockClear();

    observer.schedule();
    vi.advanceTimersByTime(400);
    expect(onScan).toHaveBeenCalledTimes(1);

    observer.stop();
  });

  it('is safe to start twice', async () => {
    const onScan = vi.fn();
    const observer = makeObserver(onScan);

    observer.start();
    observer.start();
    vi.advanceTimersByTime(400);

    expect(onScan).toHaveBeenCalledTimes(1);
    observer.stop();
  });
});
