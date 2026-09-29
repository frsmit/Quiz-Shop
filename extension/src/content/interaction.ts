/**
 * Applies an answer to the page's own controls.
 *
 * Only ordinary DOM APIs are used - `click()` on the real control, and the
 * native value setter plus bubbling `input`/`change` events for text fields so
 * that React, Vue and Angular see the update through their normal listeners.
 * There is no synthetic OS-level input and nothing here tries to work around a
 * site's own validation or controls.
 */
import type { QuestionAnswer } from '../shared/types';
import { canonicalize, stripOptionPrefix } from './normalize';
import { OPTION_CONTROL_SELECTOR, TEXT_CONTROL_SELECTOR, isIgnorable, labelFor } from './extractor';

export type FillOutcome = 'filled' | 'no-control' | 'no-match';

/** Letter answers such as "B", "b)", "Option C". */
const LETTER_ANSWER = /^(?:option\s+)?\(?([a-z])\)?[).:]?$/i;

/** Write `answer` into whatever control the container offers. */
export function applyAnswer(container: HTMLElement, answer: QuestionAnswer): FillOutcome {
  const radios = Array.from(
    container.querySelectorAll<HTMLInputElement>(OPTION_CONTROL_SELECTOR),
  ).filter((control) => !control.disabled && !isIgnorable(control));

  if (radios.length > 0) {
    const match = matchOption(radios.map(labelFor), answer.answer);
    if (match === null) return 'no-match';
    const control = radios[match];
    if (!control) return 'no-match';
    if (!control.checked) control.click();
    return 'filled';
  }

  const select = container.querySelector<HTMLSelectElement>('select');
  if (select && !select.disabled) {
    const labels = Array.from(select.options).map((option) => option.textContent ?? '');
    const match = matchOption(labels, answer.answer);
    if (match === null) return 'no-match';
    select.selectedIndex = match;
    dispatchInputEvents(select);
    return 'filled';
  }

  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(TEXT_CONTROL_SELECTOR);
  if (field && !field.disabled && !field.readOnly) {
    setNativeValue(field, answer.answer);
    dispatchInputEvents(field);
    return 'filled';
  }

  return 'no-control';
}

/**
 * Index of the option the answer refers to.
 * Tries exact text, then a letter reference, then prefix and containment -
 * an ambiguous containment match is rejected rather than guessed.
 */
export function matchOption(optionLabels: readonly string[], answer: string): number | null {
  const target = canonicalize(answer);
  if (!target) return null;

  const canonical = optionLabels.map((label) => canonicalize(label));

  const exact = canonical.indexOf(target);
  if (exact !== -1) return exact;

  // `B. on` for the option `on`: models copy the label the prompt put on the
  // option. The text after the label is what they wrote out, so it is matched
  // before the letter itself is trusted.
  const unlabelled = canonicalize(stripOptionPrefix(answer));
  if (unlabelled && unlabelled !== target) {
    const index = canonical.indexOf(unlabelled);
    if (index !== -1) return index;
  }

  const letter = LETTER_ANSWER.exec(answer.trim());
  if (letter?.[1]) {
    const index = letter[1].toLowerCase().charCodeAt(0) - 97;
    if (index >= 0 && index < optionLabels.length) return index;
  }

  const prefixed = canonical.findIndex(
    (label) => label.length > 0 && (target.startsWith(label) || label.startsWith(target)),
  );
  if (prefixed !== -1) return prefixed;

  const contained = canonical.reduce<number[]>((matches, label, index) => {
    if (label.length > 2 && target.includes(label)) matches.push(index);
    return matches;
  }, []);
  return contained.length === 1 ? (contained[0] as number) : null;
}

/**
 * Framework-safe value assignment: React tracks the last value it wrote on the
 * element, so assigning `.value` directly is swallowed. Going through the
 * prototype's setter updates the node and lets the framework observe it.
 */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

function dispatchInputEvents(element: Element): void {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}
