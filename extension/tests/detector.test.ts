import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { detectQuestions } from '../src/content/detector';
import type { QuestionRequest } from '../src/shared/types';

// Vitest runs with the extension workspace as the working directory.
const DEMO_HTML = readFileSync(resolve(process.cwd(), '..', 'demo', 'index.html'), 'utf8');

const OPTIONS = { maxContextLength: 2000, url: 'http://localhost:5173/', title: 'Practice quiz' };

function load(html: string): void {
  document.documentElement.innerHTML = html;
}

function detect(): QuestionRequest[] {
  return detectQuestions(document, OPTIONS).map((question) => question.request);
}

/** Find the detected question whose text contains `needle`. */
function find(requests: QuestionRequest[], needle: string): QuestionRequest | undefined {
  return requests.find((request) => request.question.toLowerCase().includes(needle.toLowerCase()));
}

describe('detectQuestions on the demo page', () => {
  beforeEach(() => {
    load(DEMO_HTML);
  });

  it('finds every question on the page', () => {
    const requests = detect();
    for (const needle of [
      'binary search',
      'status code',
      'print to the console',
      'polymorphism',
      'aggregation',
      'Differentiate',
      'O(1) average-case lookup',
    ]) {
      expect(find(requests, needle), `expected to detect: ${needle}`).toBeDefined();
    }
  });

  it('reads options from a fieldset with explicit labels', () => {
    const question = find(detect(), 'binary search');
    expect(question?.type).toBe('multiple_choice');
    expect(question?.options).toEqual(['O(n)', 'O(log n)', 'O(n log n)', 'O(1)']);
  });

  it('reads options from label-wrapped inputs without a fieldset', () => {
    const question = find(detect(), 'status code');
    expect(question?.options).toContain('404 Not Found');
    expect(question?.options).toHaveLength(4);
  });

  it('reads options from a select element', () => {
    const question = find(detect(), 'aggregation');
    expect(question?.type).toBe('multiple_choice');
    expect(question?.options).toEqual(['WHERE', 'HAVING', 'GROUP BY', 'ORDER BY']);
    expect(question?.options).not.toContain('Choose an answer…');
  });

  it('classifies a code question as programming and keeps the listing as context', () => {
    const question = find(detect(), 'print to the console');
    expect(question?.type).toBe('programming');
    expect(question?.context).toContain('items.map');
  });

  it('classifies a textarea question as a short answer', () => {
    const question = find(detect(), 'polymorphism');
    expect(question?.type).toBe('short_answer');
    expect(question?.options).toBeUndefined();
  });

  it('classifies a MathML question as mathematical', () => {
    const question = find(detect(), 'Differentiate');
    expect(question?.type).toBe('mathematical');
  });

  it('reads lettered options from a question with no form controls', () => {
    const question = find(detect(), 'O(1) average-case lookup');
    expect(question?.options).toEqual([
      'Linked list',
      'Hash table',
      'Binary search tree',
      'Array',
    ]);
  });

  it('records the page as the source', () => {
    const question = find(detect(), 'binary search');
    expect(question?.source).toEqual({ url: OPTIONS.url, title: OPTIONS.title });
  });

  it('ignores navigation, adverts and the footer', () => {
    const requests = detect();
    expect(find(requests, 'recursion hard to learn')).toBeUndefined();
    expect(find(requests, 'premium plan')).toBeUndefined();
    expect(find(requests, 'meaning of this footer')).toBeUndefined();
  });

  it('produces a stable fingerprint across a re-render', () => {
    const before = detectQuestions(document, OPTIONS).map((question) => question.fingerprint);

    for (const section of Array.from(document.querySelectorAll('.question'))) {
      section.replaceWith(section.cloneNode(true));
    }

    const after = detectQuestions(document, OPTIONS).map((question) => question.fingerprint);
    expect(after).toEqual(before);
  });

  it('detects questions inserted after the initial scan', () => {
    const before = detect().length;

    const section = document.createElement('section');
    section.className = 'question';
    section.innerHTML = `
      <p class="prompt">Which keyword declares a block-scoped constant in JavaScript?</p>
      <label><input type="radio" name="late" value="a" /> var</label>
      <label><input type="radio" name="late" value="b" /> let</label>
      <label><input type="radio" name="late" value="c" /> const</label>`;
    document.querySelector('.page')?.append(section);

    const after = detect();
    expect(after).toHaveLength(before + 1);
    expect(find(after, 'block-scoped constant')?.options).toEqual(['var', 'let', 'const']);
  });
});

describe('detectQuestions on pages without questions', () => {
  it('returns nothing for a page of prose', () => {
    load('<body><main><h1>About us</h1><p>We build learning tools for students.</p></main></body>');
    expect(detect()).toEqual([]);
  });

  it('returns nothing for a login form', () => {
    load(`<body><main><form>
      <label for="u">Username</label><input type="text" id="u" name="u" />
      <label for="p">Password</label><input type="password" id="p" name="p" />
    </form></main></body>`);
    expect(detect()).toEqual([]);
  });

  it('returns nothing for an empty document', () => {
    load('<body></body>');
    expect(detect()).toEqual([]);
  });
});
