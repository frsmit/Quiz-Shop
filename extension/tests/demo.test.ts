/**
 * Exercises the demo page's own behaviour together with the detector, which
 * is the closest thing to an end-to-end check that does not need a browser:
 * questions that arrive late must be found, and questions that are rebuilt
 * must not be treated as new.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectQuestions } from '../src/content/detector';

const DEMO_HTML = readFileSync(resolve(process.cwd(), '..', 'demo', 'index.html'), 'utf8');
const DEMO_JS = readFileSync(resolve(process.cwd(), '..', 'demo', 'quiz.js'), 'utf8');

const OPTIONS = { maxContextLength: 2000, url: 'http://localhost:5173/', title: 'Practice quiz' };

function fingerprints(): string[] {
  return detectQuestions(document, OPTIONS).map((question) => question.fingerprint);
}

describe('demo page behaviour', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    document.documentElement.innerHTML = DEMO_HTML;

    // The demo ships as a module script; evaluating the source directly
    // attaches its listeners to the freshly rendered document.
    const run = new Function(DEMO_JS) as () => void;
    run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects the questions that arrive after the initial render', () => {
    const before = fingerprints();

    (document.getElementById('load-more') as HTMLButtonElement).click();
    expect(fingerprints()).toHaveLength(before.length); // nothing yet - still loading

    vi.advanceTimersByTime(1000);

    const after = detectQuestions(document, OPTIONS);
    expect(after).toHaveLength(before.length + 2);

    const git = after.find((question) => question.request.question.includes('Git command'));
    expect(git?.request.options).toEqual([
      'git branch new-feature',
      'git checkout -b new-feature',
      'git merge new-feature',
      'git switch --merge',
    ]);
  });

  it('does not see a rebuilt question as a new one', () => {
    const before = fingerprints();

    (document.getElementById('rerender') as HTMLButtonElement).click();

    expect(fingerprints()).toEqual(before);
    expect(document.getElementById('controls-status')?.textContent).toMatch(/Rebuilt \d+ question/);
  });

  it('keeps working after both interactions', () => {
    (document.getElementById('load-more') as HTMLButtonElement).click();
    vi.advanceTimersByTime(1000);
    const afterLoad = fingerprints();

    (document.getElementById('rerender') as HTMLButtonElement).click();

    expect(fingerprints()).toEqual(afterLoad);
    expect(new Set(afterLoad).size).toBe(afterLoad.length); // all distinct
  });
});
