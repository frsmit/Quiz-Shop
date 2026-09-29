/**
 * WatuPRO, the WordPress quiz plugin behind sites such as testfellow.com.
 *
 * Rebuilt from a live page (testfellow.com, preposition MCQs). Two things
 * about its markup broke detection, and both are common well beyond WatuPRO:
 *
 * - each checkbox is labelled by a *sibling* `<label for>`, not a wrapping one;
 * - every question is in the DOM from the start, and a stylesheet rule hides
 *   all but the current one, which **Next** reveals by changing `style`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectQuestions } from '../src/content/detector';
import { applyAnswer } from '../src/content/interaction';
import { createPageObserver } from '../src/content/observer';

function question(n: number, prompt: string, options: string[], shown: boolean): string {
  const choices = options
    .map(
      (text, i) => `<div class="watupro-question-choice">
        <input type="checkbox" name="answer-${n}[]" id="answer-id-${n}${i}" class="answer   answerof-${n}" value="${i}">
        <label for="answer-id-${n}${i}" id="answer-label-${n}${i}" class=" answer"><span>${text}</span></label>
      </div>`,
    )
    .join('');
  return `<div class="watu-question " id="question-${n}" style="${shown ? 'display:block;' : ''}">
    <div id="questionWrap-${n}" class="watupro-question-id-${n}">
      <div class="question-content"><div><span class="watupro_num">${n}. </span>${prompt}</div>
        <input type="hidden" name="question_id[]" value="${n}" class="watupro-question-id">
        <input type="hidden" class="answerTypeCnt${n}" value="checkbox">
      </div>
      <div class="question-choices watupro-choices-columns">${choices}</div>
    </div>
    <div id="liveResult-${n}" style="display:none;">Loading...</div>
  </div>`;
}

const Q1 = 'Sign your name..........the dotted line at the end of the admission form.';
const Q2 = 'He was angry ..........me for being late.';

function renderQuiz(): void {
  // The plugin's own rule: every question hidden unless shown inline.
  document.head.innerHTML = '<style>.watu-question { display: none; }</style>';
  // GeneratePress, the theme on testfellow.com, puts layout classes on <body>.
  // `right-sidebar` once made the detector discard the whole page as furniture.
  document.body.className =
    'post-template-default single single-post single-format-standard right-sidebar nav-float-right separate-containers header-aligned-left dropdown-hover';
  document.body.innerHTML = `<div class="site grid-container container hfeed" id="page"><div class="site-content" id="content">
    <div class="content-area has-sidebar" id="primary">
    <main id="main" class="site-main"><article><div class="entry-content">
    <div class="quiz-area " id="watupro_quiz"><form class="quiz-form" id="quiz-1">
      <div class="watupro-paginator-wrap watupro-question-paginator-wrap"><ul><li>1</li><li>2</li></ul></div>
      <div class="watupro-progress-container"><div class="watupro-progress-bar" style="width:0%">0%</div></div>
      ${question(1, Q1, ['in', 'on', 'onto', 'into'], true)}
      ${question(2, Q2, ['at', 'with', 'on', 'for'], false)}
      ${question(3, 'The book is ..........the table.', ['on', 'in', 'at', 'over'], false)}
      <input type="button" value="Next >"><input type="button" value="See Answer">
    </form></div></div></article></main></div>
    <div class="widget-area sidebar is-right-sidebar" id="right-sidebar"><p>Trending Quizzes: which one will you try next?</p></div>
    </div></div>`;
}

/** What WatuPRO's **Next** button does. */
function next(from: number, to: number): void {
  (document.getElementById(`question-${from}`) as HTMLElement).style.display = 'none';
  (document.getElementById(`question-${to}`) as HTMLElement).style.display = 'block';
}

const detect = () => detectQuestions(document, { maxContextLength: 2000 });

beforeEach(renderQuiz);

afterEach(() => {
  document.head.innerHTML = '';
  document.body.className = '';
  vi.useRealTimers();
});

describe('WatuPRO quizzes', () => {
  it('detects the question whose options are linked by <label for>', () => {
    const found = detect();

    expect(found.map((q) => q.request)).toEqual([
      { question: Q1, type: 'multiple_choice', options: ['in', 'on', 'onto', 'into'] },
    ]);
  });

  it('still skips the real sidebar next to the quiz', () => {
    expect(detect().some((q) => q.request.question.includes('Trending Quizzes'))).toBe(false);
  });

  it('skips questions the stylesheet hides, so none is answered unseen', () => {
    expect(detect().map((q) => q.request.question)).not.toContain(Q2);
  });

  it('ticks the matching checkbox, and only that one', () => {
    const [first] = detect();
    expect(applyAnswer(first!.container, { answer: 'on', explanation: 'x', provider: 'p', model: 'm' })).toBe(
      'filled',
    );

    const checked = [...document.querySelectorAll<HTMLInputElement>('input.answer')].filter((box) => box.checked);
    expect(checked.map((box) => box.id)).toEqual(['answer-id-11']);
  });

  it('finds the next question once Next reveals it', () => {
    next(1, 2);
    expect(detect().map((q) => q.request.question)).toEqual([Q2]);
  });

  it('rescans when Next reveals a question by changing its style', async () => {
    vi.useFakeTimers();
    const onScan = vi.fn();
    const observer = createPageObserver({ onScan, debounceMs: 400 });
    observer.start();
    vi.advanceTimersByTime(400);
    onScan.mockClear();

    next(1, 2);
    await Promise.resolve();
    vi.advanceTimersByTime(400);
    expect(onScan).toHaveBeenCalledTimes(1);

    observer.stop();
  });

  it('ignores style churn on elements without answer controls, such as the progress bar', async () => {
    vi.useFakeTimers();
    const onScan = vi.fn();
    const observer = createPageObserver({ onScan, debounceMs: 400 });
    observer.start();
    vi.advanceTimersByTime(400);
    onScan.mockClear();

    const bar = document.querySelector<HTMLElement>('.watupro-progress-bar')!;
    for (let width = 1; width <= 20; width += 1) bar.style.width = `${width}%`;
    bar.className = 'watupro-progress-bar animating';
    await Promise.resolve();
    vi.advanceTimersByTime(400);
    expect(onScan).not.toHaveBeenCalled();

    observer.stop();
  });
});
