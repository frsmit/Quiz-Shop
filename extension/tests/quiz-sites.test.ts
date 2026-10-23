/**
 * Markup patterns from live MCQ sites, rebuilt from what the detector met on
 * them. Each case was a real miss or a real leak before its fix.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { detectQuestions } from '../src/content/detector';
import { applyAnswer } from '../src/content/interaction';

const detect = () => detectQuestions(document, { maxContextLength: 2000 }).map((q) => q.request);

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('ExamVeda: answer panels collapsed with opacity', () => {
  function examveda(prompt: string, options: string[], answer: string): string {
    const choices = options
      .map(
        (text, i) => `<p><input type="radio" name="q-${prompt.length}" id="o-${prompt.length}-${i}">
          <label for="o-${prompt.length}-${i}">${String.fromCharCode(65 + i)})</label>
          <label for="o-${prompt.length}-${i}">${text}</label></p>`,
      )
      .join('');
    return `<article class="question-box">
      <div class="question-main">${prompt}</div>
      <div class="question-options">${choices}</div>
      <div class="question-actions"><a class="question-action-btn"><span>Discuss</span></a></div>
      <div class="question-solution"><div class="question-solution-inner">
        <div class="question-solution-heading"><span>Answer &amp; Solution</span></div>
        <div class="question-solution-content">Answer: ${answer} Solution: the full worked answer.</div>
      </div></div>
    </article>`;
  }

  function render(): void {
    // The site's own rule: the solution is a zero-height, transparent grid row.
    document.head.innerHTML =
      '<style>.question-solution { display: grid; opacity: 0; } .question-solution-inner { overflow: hidden; height: 0; }</style>';
    document.body.innerHTML = `<main>
      ${examveda('Entomology is the science that studies', ['Behavior of human beings', 'Insects', 'The formation of rocks'], 'Option B')}
      ${examveda('FFC stands for', ['Federation of Football Council', 'Film Finance Corporation', 'None of the above'], 'Option B')}
    </main>`;
  }

  it('never reads the hidden answer into the question', () => {
    render();
    const questions = detect();

    expect(questions).toHaveLength(2);
    for (const question of questions) {
      expect(question.question).not.toMatch(/Answer|Solution|Option B/);
    }
  });

  it('keeps a short stem that comes with real answer controls', () => {
    render();
    expect(detect().map((q) => q.options)).toContainEqual([
      'Federation of Football Council',
      'Film Finance Corporation',
      'None of the above',
    ]);
  });

  it('does not report a question a second time without its options', () => {
    render();
    expect(detect().every((q) => (q.options?.length ?? 0) >= 2)).toBe(true);
  });
});

describe('IndiaBix: collapsed workspace and report textareas', () => {
  it('ignores text controls inside a panel the stylesheet collapses', () => {
    document.head.innerHTML = '<style>.collapse:not(.show) { display: none; }</style>';
    document.body.innerHTML = `<main><div class="bix-div-container">
      <div class="bix-td-qtxt">Which of the following disciplines is the Nobel Prize awarded for?</div>
      <div class="bix-tbl-options">
        <label><input type="radio" name="q5" value="a"> Physics and Chemistry</label>
        <label><input type="radio" name="q5" value="b"> All of the above</label>
      </div>
      <div class="bix-div-workspace collapse"><textarea></textarea></div>
      <div class="bix-div-report collapse"><textarea class="bix-report-txt"></textarea></div>
    </div></main>`;

    const questions = detect();
    expect(questions).toHaveLength(1);
    expect(questions[0]?.type).toBe('multiple_choice');
  });

  it('still reads a styled option whose real radio is hidden', () => {
    document.head.innerHTML = '<style>.pretty input { display: none; }</style>';
    document.body.innerHTML = `<main><div class="q">
      <p>Which planet is known as the Red Planet?</p>
      <label class="pretty"><input type="radio" name="p" value="a"> Venus</label>
      <label class="pretty"><input type="radio" name="p" value="b"> Mars</label>
    </div></main>`;

    expect(detect()[0]?.options).toEqual(['Venus', 'Mars']);
  });
});

describe('W3Schools: "Question 1 of 40:" numbering', () => {
  it('strips the whole label, not just "Question 1"', () => {
    document.body.innerHTML = `<main><form>
      <h3>Question 1 of 40:</h3>
      <p>What does HTML stand for?</p>
      <label><input type="radio" name="quiz" value="1"> Hyperlinks and Text Markup Language</label>
      <label><input type="radio" name="quiz" value="2"> Hyper Text Markup Language</label>
      <label><input type="radio" name="quiz" value="3"> Home Tool Markup Language</label>
    </form></main>`;

    expect(detect()[0]?.question).toBe('What does HTML stand for?');
  });
});

describe('Moodle: screen-reader-only legend on the answer group', () => {
  function render(): void {
    // Bootstrap's recipe, plus the message drawer Moodle keeps in every page.
    document.head.innerHTML = `<style>
      .visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important;
        overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; }
      .drawer.hidden { display: none; }
    </style>`;
    document.body.innerHTML = `<div role="main"><section class="card"><div class="card-body">
      <h2>Docker image fundamentals</h2>
      <div class="practice-prompt">
        <h3>Which component contains the instructions used to build a Docker image?</h3>
        <fieldset class="ablock">
          <legend class="visually-hidden">Choose a practice answer</legend>
          <div class="answer">
            <div class="r0"><label><input type="radio" name="a" value="1"><span><strong>a.</strong> Dockerfile</span></label></div>
            <div class="r1"><label><input type="radio" name="a" value="2"><span><strong>b.</strong> package.json</span></label></div>
            <div class="r0"><label><input type="radio" name="a" value="3"><span><strong>c.</strong> docker-compose.yml</span></label></div>
          </div>
        </fieldset>
      </div>
    </div></section></div>
    <div class="drawer hidden"><fieldset>
      <legend class="visually-hidden">Accept messages from:</legend>
      <input type="radio" name="block" id="b1"><label for="b1">My contacts only</label>
      <input type="radio" name="block" id="b0"><label for="b0">My contacts and anyone in my courses</label>
    </fieldset></div>`;
  }

  it('takes the visible prompt rather than the hidden legend', () => {
    render();
    expect(detect()).toEqual([
      {
        question: 'Which component contains the instructions used to build a Docker image?',
        type: 'multiple_choice',
        options: ['Dockerfile', 'package.json', 'docker-compose.yml'],
      },
    ]);
  });

  it('selects the matching radio', async () => {
    render();
    const [question] = detectQuestions(document, { maxContextLength: 2000 });
    expect(
      await applyAnswer(question!.container, { answer: 'Dockerfile', explanation: 'x', provider: 'p', model: 'm' }, question!.controls),
    ).toBe('filled');
    expect(document.querySelector<HTMLInputElement>('input[name="a"]:checked')?.value).toBe('1');
  });
});
