/**
 * Questions built from component libraries rather than plain form markup:
 * options wrapped in layers of components, ARIA widgets with no input at all,
 * controls inside shadow roots, and checkbox questions with several answers.
 *
 * Each of these used to be found but not filled, filled into the wrong
 * place, or not found at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { detectQuestions } from '../src/content/detector';
import { applyAnswer } from '../src/content/interaction';
import type { DetectedQuestion, QuestionAnswer } from '../src/shared/types';

const detect = (): DetectedQuestion[] => detectQuestions(document, { maxContextLength: 0 });

function answer(text: string, answers?: string[]): QuestionAnswer {
  return { answer: text, ...(answers ? { answers } : {}), explanation: 'x', provider: 'p', model: 'm' };
}

/** Fill the only question on the page, the way the content script does. */
async function fillOnly(value: QuestionAnswer) {
  const [question] = detect();
  expect(question).toBeDefined();
  return applyAnswer(question!.container, value, question!.controls);
}

afterEach(() => {
  document.body.innerHTML = '';
});

/** An option as a component library renders it: input, decoration and text in separate layers. */
function nestedOption(text: string, type = 'radio'): string {
  return `<div class="opt-row"><div class="opt-control"><span class="ripple">
      <input type="${type}" class="sr-only" style="opacity:0;position:absolute" />
      <span class="dot"></span>
    </span></div><div class="opt-text"><p><span>${text}</span></p></div></div>`;
}

describe('options nested in component wrappers', () => {
  const page = (type = 'radio') => `<main><section class="card">
      <h3 class="title">Which planet is known as the Red Planet?</h3>
      <div class="body"><div class="list"><div class="list-inner">
        ${['Venus', 'Mars', 'Jupiter'].map((text) => nestedOption(text, type)).join('')}
      </div></div></div>
    </section></main>`;

  it('groups unnamed inputs that are not siblings into one question', () => {
    document.body.innerHTML = page();
    const found = detect();

    expect(found).toHaveLength(1);
    expect(found[0]!.request).toMatchObject({
      question: 'Which planet is known as the Red Planet?',
      type: 'multiple_choice',
      options: ['Venus', 'Mars', 'Jupiter'],
    });
    expect(found[0]!.request.multiSelect).toBeUndefined();
    expect(found[0]!.controls).toHaveLength(3);
  });

  it('reads option text from the component around the input, not its value', () => {
    document.body.innerHTML = page();
    expect(detect()[0]!.request.options).not.toContain('on');
  });

  it('selects the option', async () => {
    document.body.innerHTML = page();
    expect(await fillOnly(answer('Mars'))).toBe('filled');

    const checked = [...document.querySelectorAll<HTMLInputElement>('input')].map((input) => input.checked);
    expect(checked).toEqual([false, true, false]);
  });

  it('finds the title however many wrappers sit between it and the options', () => {
    const deep = (inner: string, levels: number): string =>
      levels === 0 ? inner : `<div class="layer-${levels}">${deep(inner, levels - 1)}</div>`;
    document.body.innerHTML = `<main><article>
        <h3>Which gas do plants absorb from the air?</h3>
        ${deep(['Oxygen', 'Carbon dioxide', 'Nitrogen'].map((text) => nestedOption(text)).join(''), 9)}
      </article></main>`;

    expect(detect().map((question) => question.request.question)).toEqual([
      'Which gas do plants absorb from the air?',
    ]);
  });

  it('does not climb into a neighbouring question when looking that far', () => {
    const deep = (inner: string, levels: number): string =>
      levels === 0 ? inner : `<div>${deep(inner, levels - 1)}</div>`;
    // The second question has no prompt of its own; borrowing the first's
    // would answer it with the wrong question.
    document.body.innerHTML = `<main>
        <section><h3>Which gas do plants absorb from the air?</h3>
          <label><input type="radio" name="a" /> Oxygen</label>
          <label><input type="radio" name="a" /> Carbon dioxide</label>
        </section>
        ${deep('<label><input type="radio" name="b" /> Yes</label><label><input type="radio" name="b" /> No</label>', 8)}
      </main>`;

    expect(detect().map((question) => question.request.options)).toEqual([['Oxygen', 'Carbon dioxide']]);
  });

  it('keeps two adjacent unnamed questions apart', () => {
    document.body.innerHTML = `<main>
        <div class="q"><p>What is the capital of France?</p>
          <div><span><input type="radio" /></span><span>Paris</span></div>
          <div><span><input type="radio" /></span><span>Lyon</span></div>
        </div>
        <div class="q"><p>What is the capital of Italy?</p>
          <div><span><input type="radio" /></span><span>Rome</span></div>
          <div><span><input type="radio" /></span><span>Milan</span></div>
        </div>
      </main>`;

    expect(detect().map((question) => question.request.options)).toEqual([
      ['Paris', 'Lyon'],
      ['Rome', 'Milan'],
    ]);
  });
});

describe('the page ignores a click on the hidden input', () => {
  /**
   * A controlled component: the input's own click is cancelled, and the
   * option is selected by a `mousedown` handler on the row - the way several
   * UI kits wire their custom radios.
   */
  function controlledPage(): void {
    document.body.innerHTML = `<main><section>
        <h3>Which planet is known as the Red Planet?</h3>
        ${['Venus', 'Mars', 'Jupiter'].map((text) => nestedOption(text)).join('')}
      </section></main>`;
    for (const row of document.querySelectorAll<HTMLElement>('.opt-row')) {
      const input = row.querySelector('input')!;
      input.addEventListener('click', (event) => event.preventDefault());
      row.addEventListener('mousedown', () => {
        for (const other of document.querySelectorAll('input')) other.checked = false;
        input.checked = true;
      });
    }
  }

  it('clicks the option the way a user would instead', async () => {
    controlledPage();
    expect(await fillOnly(answer('Mars'))).toBe('filled');
    expect(document.querySelectorAll<HTMLInputElement>('input')[1]!.checked).toBe(true);
  });

  it('reports the answer as not applied when nothing takes', async () => {
    controlledPage();
    for (const row of document.querySelectorAll<HTMLElement>('.opt-row')) {
      row.replaceWith(row.cloneNode(true));
    }
    for (const input of document.querySelectorAll('input')) {
      input.addEventListener('click', (event) => event.preventDefault());
    }

    expect(await fillOnly(answer('Mars'))).toBe('not-applied');
  });
});

describe('ARIA widgets with no input', () => {
  /** Google Forms' shape: `role="radio"` divs labelled by `aria-label`, in a radiogroup. */
  function formsPage(role: 'radio' | 'checkbox', respond: (widget: HTMLElement) => void): void {
    const group = role === 'radio' ? 'role="radiogroup"' : 'role="list"';
    document.body.innerHTML = `<form><div class="question">
        <div class="title" id="t1">Which of these are primary colours?</div>
        <div ${group} aria-labelledby="t1">
          ${['Red', 'Green', 'Blue', 'Purple']
            .map(
              (text) => `<div role="listitem"><label><div class="box">
                <div role="${role}" aria-label="${text}" aria-checked="false" tabindex="0"><div class="inner"></div></div>
              </div><div><span>${text}</span></div></label></div>`,
            )
            .join('')}
        </div></div></form>`;
    for (const widget of document.querySelectorAll<HTMLElement>(`[role="${role}"]`)) respond(widget);
  }

  const toggleOnClick = (widget: HTMLElement) =>
    widget.addEventListener('click', () => {
      // Like a framework re-render: the state lands a moment later.
      setTimeout(() => {
        const next = widget.getAttribute('aria-checked') === 'true' ? 'false' : 'true';
        if (widget.getAttribute('role') === 'radio') {
          for (const other of document.querySelectorAll('[role="radio"]')) other.setAttribute('aria-checked', 'false');
        }
        widget.setAttribute('aria-checked', next);
      }, 10);
    });

  it('detects a radio group of widgets', () => {
    formsPage('radio', toggleOnClick);
    const [question] = detect();

    expect(question!.request).toMatchObject({
      question: 'Which of these are primary colours?',
      options: ['Red', 'Green', 'Blue', 'Purple'],
    });
    expect(question!.request.multiSelect).toBeUndefined();
  });

  it('selects a widget and waits for the page to show it', async () => {
    formsPage('radio', toggleOnClick);
    expect(await fillOnly(answer('Blue'))).toBe('filled');

    const states = [...document.querySelectorAll('[role="radio"]')].map((widget) => widget.getAttribute('aria-checked'));
    expect(states).toEqual(['false', 'false', 'true', 'false']);
  });

  it('marks a checkbox group as multi-select and ticks every answer', async () => {
    formsPage('checkbox', toggleOnClick);
    const [question] = detect();
    expect(question!.request.multiSelect).toBe(true);

    expect(await fillOnly(answer('Red; Blue', ['Red', 'Blue']))).toBe('filled');
    const states = [...document.querySelectorAll('[role="checkbox"]')].map((widget) => widget.getAttribute('aria-checked'));
    expect(states).toEqual(['true', 'false', 'true', 'false']);
  });

  it('falls back to the keyboard for a widget that only answers to Space', async () => {
    formsPage('radio', (widget) =>
      widget.addEventListener('keydown', (event) => {
        if (event.key !== ' ') return;
        for (const other of document.querySelectorAll('[role="radio"]')) other.setAttribute('aria-checked', 'false');
        widget.setAttribute('aria-checked', 'true');
      }),
    );

    expect(await fillOnly(answer('Green'))).toBe('filled');
    expect(document.querySelectorAll('[role="radio"]')[1]!.getAttribute('aria-checked')).toBe('true');
  });

  it('counts a widget that decorates a real input once, as the input', () => {
    document.body.innerHTML = `<main><section><h3>Which planet is known as the Red Planet?</h3>
        ${['Venus', 'Mars']
          .map((text) => `<label><span role="radio" aria-checked="false"><input type="radio" name="p" /></span> ${text}</label>`)
          .join('')}
      </section></main>`;

    const found = detect();
    expect(found).toHaveLength(1);
    expect(found[0]!.controls!.every((control) => control.tagName === 'INPUT')).toBe(true);
  });

  it('uses a button widget beside a hidden native input (Radix)', () => {
    document.body.innerHTML = `<main><section><h3>Which planet is known as the Red Planet?</h3>
        <div role="radiogroup">
          ${['Venus', 'Mars']
            .map(
              (text, i) => `<div><button type="button" role="radio" id="r${i}" aria-checked="false" data-state="unchecked"></button>
              <input type="radio" aria-hidden="true" tabindex="-1" style="position:absolute;opacity:0" />
              <label for="r${i}">${text}</label></div>`,
            )
            .join('')}
        </div></section></main>`;

    const found = detect();
    expect(found).toHaveLength(1);
    expect(found[0]!.request.options).toEqual(['Venus', 'Mars']);
    expect(found[0]!.controls!.every((control) => control.tagName === 'BUTTON')).toBe(true);
  });
});

describe('shadow DOM', () => {
  /** A custom element that renders a native radio in its own shadow root. */
  class ShadowRadio extends HTMLElement {
    connectedCallback(): void {
      if (this.shadowRoot) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<span class="ring"><input type="radio" part="input" /></span><slot></slot>';
    }
  }
  if (!customElements.get('x-radio')) customElements.define('x-radio', ShadowRadio);

  it('finds and fills options whose inputs live in shadow roots', async () => {
    document.body.innerHTML = `<main><section><h3>Which planet is known as the Red Planet?</h3>
        <div class="choices"><x-radio>Venus</x-radio><x-radio>Mars</x-radio><x-radio>Jupiter</x-radio></div>
      </section></main>`;

    const [question] = detect();
    expect(question!.request).toMatchObject({
      question: 'Which planet is known as the Red Planet?',
      options: ['Venus', 'Mars', 'Jupiter'],
    });

    expect(await applyAnswer(question!.container, answer('Jupiter'), question!.controls)).toBe('filled');
    const inputs = [...document.querySelectorAll('x-radio')].map(
      (host) => host.shadowRoot!.querySelector('input')!.checked,
    );
    expect(inputs).toEqual([false, false, true]);
  });

  it('finds a whole question rendered inside a shadow root', () => {
    document.body.innerHTML = '<main><quiz-card></quiz-card></main>';
    const host = document.querySelector('quiz-card')!;
    host.attachShadow({ mode: 'open' }).innerHTML = `<section><h3>What is the boiling point of water at sea level?</h3>
        <label><input type="radio" name="b" /> 90 °C</label>
        <label><input type="radio" name="b" /> 100 °C</label></section>`;

    expect(detect().map((question) => question.request.options)).toEqual([['90 °C', '100 °C']]);
  });
});

describe('several correct answers', () => {
  it('groups checkboxes that each carry their own name', () => {
    document.body.innerHTML = `<main><section><p>Which of these are prime numbers?</p>
        ${['2', '4', '5', '9']
          .map((text, i) => `<label><input type="checkbox" name="q1_opt${i}" /> ${text}</label>`)
          .join('')}
      </section></main>`;

    const [question] = detect();
    expect(question!.request).toMatchObject({ options: ['2', '4', '5', '9'], multiSelect: true });
  });

  it('ticks each answer and never unticks a box', async () => {
    document.body.innerHTML = `<main><section><p>Which of these are prime numbers?</p>
        ${['2', '4', '5', '9']
          .map((text) => `<label><input type="checkbox" name="primes" /> ${text}</label>`)
          .join('')}
      </section></main>`;
    // Ticked by the user before the answer arrived.
    document.querySelectorAll<HTMLInputElement>('input')[3]!.checked = true;

    expect(await fillOnly(answer('2; 5', ['2', '5']))).toBe('filled');
    const checked = [...document.querySelectorAll<HTMLInputElement>('input')].map((input) => input.checked);
    expect(checked).toEqual([true, false, true, true]);
  });

  it('reads the picks from the joined answer when no list came back', async () => {
    document.body.innerHTML = `<main><section><p>Which of these are prime numbers?</p>
        ${['2', '4', '5', '9']
          .map((text) => `<label><input type="checkbox" name="primes" /> ${text}</label>`)
          .join('')}
      </section></main>`;

    expect(await fillOnly(answer('2; 5'))).toBe('filled');
    const checked = [...document.querySelectorAll<HTMLInputElement>('input')].map((input) => input.checked);
    expect(checked).toEqual([true, false, true, false]);
  });

  it('does not tick a box twice when a rescan fills again', async () => {
    document.body.innerHTML = `<main><section><p>Which of these are prime numbers?</p>
        ${['2', '4', '5']
          .map((text) => `<label><input type="checkbox" name="primes" /> ${text}</label>`)
          .join('')}
      </section></main>`;

    await fillOnly(answer('2; 5', ['2', '5']));
    await fillOnly(answer('2; 5', ['2', '5']));
    const checked = [...document.querySelectorAll<HTMLInputElement>('input')].map((input) => input.checked);
    expect(checked).toEqual([true, false, true]);
  });

  it('flags a text-only question that asks for every correct option', () => {
    document.body.innerHTML = `<main><div class="question">
        <p>Which of the following are mammals? Select all that apply.</p>
        <p>A. Whale</p><p>B. Shark</p><p>C. Bat</p>
      </div></main>`;

    expect(detect()[0]!.request.multiSelect).toBe(true);
  });

  it('never flags a radio question, whatever its wording', () => {
    document.body.innerHTML = `<main><section><p>Select all that apply: which is the odd one out?</p>
        <label><input type="radio" name="o" /> Red</label><label><input type="radio" name="o" /> Car</label>
      </section></main>`;

    expect(detect()[0]!.request.multiSelect).toBeUndefined();
  });
});

describe('layouts that used to split or hide a question', () => {
  it('keeps options laid out in columns together as one question', () => {
    document.body.innerHTML = `<main><div class="q"><p>Which of these are noble gases?</p>
        <div class="row">
          <div class="col">${['Neon', 'Oxygen'].map((text) => nestedOption(text, 'checkbox')).join('')}</div>
          <div class="col">${['Argon', 'Nitrogen'].map((text) => nestedOption(text, 'checkbox')).join('')}</div>
        </div></div></main>`;

    const found = detect();
    expect(found).toHaveLength(1);
    expect(found[0]!.request.options).toEqual(['Neon', 'Oxygen', 'Argon', 'Nitrogen']);
  });

  it("reads a prompt written in a Bootstrap card's header", () => {
    document.body.innerHTML = `<main><div class="card">
        <div class="card-header">Which keyword declares a constant in JavaScript?</div>
        <div class="card-body">
          <label><input type="radio" name="k" /> var</label>
          <label><input type="radio" name="k" /> const</label>
        </div></div></main>`;

    expect(detect()[0]!.request.question).toBe('Which keyword declares a constant in JavaScript?');
  });

  it('still treats a page header as furniture', () => {
    document.body.innerHTML = `<div class="site-header">Which course would you like to take today?</div>
      <main><section><p>Which keyword declares a constant in JavaScript?</p>
        <label><input type="radio" name="k" /> var</label>
        <label><input type="radio" name="k" /> const</label></section></main>`;

    expect(detect().map((question) => question.request.question)).toEqual([
      'Which keyword declares a constant in JavaScript?',
    ]);
  });
});
