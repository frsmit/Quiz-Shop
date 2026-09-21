import { describe, expect, it } from 'vitest';
import { applyAnswer, matchOption } from '../src/content/interaction';
import {
  canonicalize,
  fingerprint,
  looksLikeQuestion,
  stripOptionPrefix,
  truncate,
} from '../src/content/normalize';
import { readMath } from '../src/content/extractor';
import type { QuestionAnswer } from '../src/shared/types';

function answer(text: string): QuestionAnswer {
  return {
    answer: text,
    explanation: 'because',
    provider: 'stub',
    model: 'stub-model',
  };
}

function render(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe('normalisation', () => {
  it('strips lettered, numbered and bulleted option prefixes', () => {
    expect(stripOptionPrefix('A. Hash table')).toBe('Hash table');
    expect(stripOptionPrefix('(b) Linked list')).toBe('Linked list');
    expect(stripOptionPrefix('3) Array')).toBe('Array');
    expect(stripOptionPrefix('• Binary tree')).toBe('Binary tree');
    expect(stripOptionPrefix('O(log n)')).toBe('O(log n)');
  });

  it('folds case and whitespace when comparing', () => {
    expect(canonicalize('  The   ANSWER   is  42 ')).toBe('the answer is 42');
    expect(canonicalize('What is 2 + 2?')).toBe('what is 2 + 2');
  });

  it('keeps the punctuation that changes an answer', () => {
    // O(n) and O(n!) are different answers, so brackets and ! must survive.
    expect(canonicalize('O(n!)')).not.toBe(canonicalize('O(n)'));
    expect(canonicalize('arr[0]')).toBe('arr[0]');
  });

  it('gives equal fingerprints to the same question rendered differently', () => {
    const a = fingerprint(['What is 2 + 2?', 'Three', 'Four']);
    const b = fingerprint(['what is  2 + 2 ?', 'three', 'four']);
    expect(a).toBe(b);
  });

  it('gives different fingerprints when the options differ', () => {
    expect(fingerprint(['Q', 'a', 'b'])).not.toBe(fingerprint(['Q', 'a', 'c']));
  });

  it('truncates on a word boundary where one is close to the limit', () => {
    expect(truncate('alpha beta gamma delta', 20)).toBe('alpha beta gamma');
    expect(truncate('short', 16)).toBe('short');
    expect(truncate('supercalifragilistic', 8)).toBe('supercal');
  });

  it('recognises questions and ignores prose', () => {
    expect(looksLikeQuestion('Which one is correct?')).toBe(true);
    expect(looksLikeQuestion('Explain polymorphism in Java.')).toBe(true);
    expect(looksLikeQuestion('We build learning tools.')).toBe(false);
  });
});

describe('maths extraction', () => {
  it('prefers LaTeX when the page exposes it', () => {
    const element = render('<div data-latex="x^2 + 1">x2 + 1</div>');
    expect(readMath(element)).toBe('x^2 + 1');
  });

  it('converts MathML superscripts rather than flattening them', () => {
    const element = render(
      '<math><mrow><mn>3</mn><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mn>5</mn></mrow></math>',
    );
    expect(readMath(element)).toBe('3x^2+5');
  });

  it('converts fractions and roots', () => {
    const fraction = render('<math><mfrac><mn>1</mn><mn>2</mn></mfrac></math>');
    expect(readMath(fraction)).toBe('(1)/(2)');

    const root = render('<math><msqrt><mn>16</mn></msqrt></math>');
    expect(readMath(root)).toBe('sqrt(16)');
  });
});

describe('matchOption', () => {
  const options = ['O(n)', 'O(log n)', 'O(n log n)', 'O(1)'];

  it('matches the exact option text', () => {
    expect(matchOption(options, 'O(log n)')).toBe(1);
  });

  it('matches regardless of case and spacing', () => {
    expect(matchOption(options, '  o(LOG n) ')).toBe(1);
  });

  it('matches a letter reference', () => {
    expect(matchOption(options, 'C')).toBe(2);
    expect(matchOption(options, 'b)')).toBe(1);
    expect(matchOption(options, 'Option D')).toBe(3);
  });

  it('matches an answer that restates the option', () => {
    expect(matchOption(['Hash table', 'Array'], 'Hash table, because lookup is constant time')).toBe(0);
  });

  it('refuses an ambiguous match', () => {
    expect(matchOption(['Paris', 'Paris, Texas'], 'Somewhere else entirely')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(matchOption(options, 'O(n!)')).toBeNull();
  });
});

describe('applyAnswer', () => {
  it('selects the matching radio button', () => {
    const container = render(`<div>
      <label><input type="radio" name="q" value="a" /> O(n)</label>
      <label><input type="radio" name="q" value="b" /> O(log n)</label>
    </div>`);

    expect(applyAnswer(container, answer('O(log n)'))).toBe('filled');
    expect(container.querySelector<HTMLInputElement>('input[value="b"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[value="a"]')?.checked).toBe(false);
  });

  it('fires a change event the page can listen for', () => {
    const container = render(`<div>
      <label><input type="radio" name="q" value="a" /> Yes</label>
      <label><input type="radio" name="q" value="b" /> No</label>
    </div>`);

    let changes = 0;
    container.addEventListener('change', () => {
      changes += 1;
    });

    applyAnswer(container, answer('No'));
    expect(changes).toBe(1);
  });

  it('selects the matching option in a dropdown', () => {
    const container = render(`<div>
      <select><option value="">Pick</option><option>WHERE</option><option>HAVING</option></select>
    </div>`);

    expect(applyAnswer(container, answer('HAVING'))).toBe('filled');
    expect(container.querySelector('select')?.value).toBe('HAVING');
  });

  it('types into a free-text field and notifies listeners', () => {
    const container = render('<div><textarea></textarea></div>');
    const field = container.querySelector('textarea') as HTMLTextAreaElement;

    const events: string[] = [];
    field.addEventListener('input', () => events.push('input'));
    field.addEventListener('change', () => events.push('change'));

    expect(applyAnswer(container, answer('Polymorphism is …'))).toBe('filled');
    expect(field.value).toBe('Polymorphism is …');
    expect(events).toEqual(['input', 'change']);
  });

  it('leaves a disabled control alone', () => {
    const container = render(`<div>
      <label><input type="radio" name="q" value="a" disabled /> Yes</label>
      <label><input type="radio" name="q" value="b" disabled /> No</label>
    </div>`);

    expect(applyAnswer(container, answer('No'))).toBe('no-control');
    expect(container.querySelector<HTMLInputElement>('input[value="b"]')?.checked).toBe(false);
  });

  it('reports when no option matches rather than guessing', () => {
    const container = render(`<div>
      <label><input type="radio" name="q" value="a" /> Yes</label>
      <label><input type="radio" name="q" value="b" /> No</label>
    </div>`);

    expect(applyAnswer(container, answer('Maybe'))).toBe('no-match');
    expect(container.querySelectorAll(':checked')).toHaveLength(0);
  });

  it('reports when there is nothing to fill', () => {
    const container = render('<div><p>Just a question, no controls.</p></div>');
    expect(applyAnswer(container, answer('anything'))).toBe('no-control');
  });
});
