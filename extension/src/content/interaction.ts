/**
 * Applies an answer to the page's own controls.
 *
 * Only ordinary DOM APIs are used - `click()` on the real control, the
 * pointer and mouse events a click is made of, and the native value setter
 * plus bubbling `input`/`change` events for text fields - so that React, Vue,
 * Angular and component libraries see the update through their normal
 * listeners. There is no synthetic OS-level input and nothing here tries to
 * work around a site's own validation or controls.
 *
 * Every selection is verified. Component libraries hide the real input and
 * listen on a wrapper, or have no input at all and keep their state in
 * `aria-checked`, so a click that the page ignored is retried the way a user
 * would click - on the option they can see - before it is reported as not
 * applied.
 */
import type { QuestionAnswer } from '../shared/types';
import { canonicalize, stripOptionPrefix } from './normalize';
import {
  OPTION_CONTROL_SELECTOR,
  OPTION_WIDGET_SELECTOR,
  TEXT_CONTROL_SELECTOR,
  isChecked,
  isDisabled,
  isMultiSelectControl,
  isNativeOption,
  isOptionIgnorable,
  labelFor,
  labelsOf,
  optionRoot,
} from './extractor';
import { composedContains } from './dom';

export type FillOutcome = 'filled' | 'no-control' | 'no-match' | 'not-applied';

/** Letter answers such as "B", "b)", "Option C". */
const LETTER_ANSWER = /^(?:option\s+)?\(?([a-z])\)?[).:]?$/i;

/** How long a framework gets to reflect a click before the next approach is tried. */
const SETTLE_MS = 250;
const POLL_MS = 25;

/**
 * Write `answer` into whatever control the container offers.
 *
 * `controls` are the option controls the detector found for this question;
 * passing them reaches controls a plain query of `container` cannot (inside a
 * shadow root, or grouped across component wrappers). Without them the
 * container is searched.
 */
export async function applyAnswer(
  container: HTMLElement,
  answer: QuestionAnswer,
  controls?: readonly Element[],
): Promise<FillOutcome> {
  const options = (controls?.length ? [...controls] : findOptionControls(container)).filter(
    (control) => control.isConnected && !isDisabled(control) && !isOptionIgnorable(control),
  );

  if (options.length > 0) {
    const labels = options.map((control) => labelFor(control, options));
    return options.some(isMultiSelectControl)
      ? selectSeveral(options, labels, answer)
      : selectOne(options, labels, answer);
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

/** A radio group: select the one option the answer names. */
async function selectOne(
  options: readonly Element[],
  labels: readonly string[],
  answer: QuestionAnswer,
): Promise<FillOutcome> {
  const match = matchOption(labels, answer.answer) ?? firstMatch(labels, answer.answers);
  const control = match === null ? undefined : options[match];
  if (!control) return 'no-match';
  if (isChecked(control)) return 'filled';
  return (await activate(control, options)) ? 'filled' : 'not-applied';
}

/**
 * A checkbox group: tick every option the answer names. Boxes already ticked
 * are left alone, and none is ever unticked - the group may hold the user's
 * own choices, or a "flag for review" box that only looks like an option.
 */
async function selectSeveral(
  options: readonly Element[],
  labels: readonly string[],
  answer: QuestionAnswer,
): Promise<FillOutcome> {
  const picks = answer.answers?.length ? answer.answers : splitAnswer(answer.answer);
  const indices = new Set<number>();
  for (const pick of picks) {
    const index = matchOption(labels, pick);
    if (index !== null) indices.add(index);
  }
  // A model that wrote one option in prose, rather than a list.
  if (indices.size === 0) {
    const index = matchOption(labels, answer.answer);
    if (index !== null) indices.add(index);
  }
  if (indices.size === 0) return 'no-match';

  let applied = true;
  for (const index of [...indices].sort((a, b) => a - b)) {
    const control = options[index];
    if (!control || isChecked(control)) continue;
    if (!(await activate(control, options))) applied = false;
  }
  return applied ? 'filled' : 'not-applied';
}

/** The parts of a multi-select answer joined with "; " or new lines. */
function splitAnswer(answer: string): string[] {
  return answer
    .split(/\s*;\s*|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function firstMatch(labels: readonly string[], answers: readonly string[] | undefined): number | null {
  for (const candidate of answers ?? []) {
    const index = matchOption(labels, candidate);
    if (index !== null) return index;
  }
  return null;
}

/** Native option inputs plus ARIA option widgets inside `container`. */
function findOptionControls(container: HTMLElement): Element[] {
  const native = Array.from(container.querySelectorAll(OPTION_CONTROL_SELECTOR));
  if (native.length > 0) return native;
  return Array.from(container.querySelectorAll(OPTION_WIDGET_SELECTOR)).filter(
    (widget) => !isNativeOption(widget),
  );
}

/**
 * Select one option and confirm the page took it.
 *
 * Tried in turn until the control reads as selected:
 *   1. the control itself - `click()` on a native input, the full pointer
 *      and mouse sequence on a widget, since many listen on `pointerdown` or
 *      `mousedown` rather than `click`;
 *   2. what the user would actually click: the topmost element at the
 *      centre of the visible option - a styled dot drawn over a hidden input,
 *      or the row a library put its handler on;
 *   3. the option's label;
 *   4. for a widget, Space with it focused - the keyboard contract of
 *      `role="radio"` and `role="checkbox"`.
 *
 * Each step gets a moment to show its effect before the next is tried, so a
 * framework that re-renders asynchronously is not clicked twice - for a
 * checkbox, a second click would undo the first.
 */
async function activate(control: Element, group: readonly Element[]): Promise<boolean> {
  const root = optionRoot(control, group);
  const tried = new Set<Element>();
  const attempts: Array<() => boolean> = [
    () => {
      tried.add(control);
      if (isNativeOption(control)) control.click();
      else pointerClick(control);
      return true;
    },
    () => {
      const target = hitTarget(control, root);
      if (!target || tried.has(target)) return false;
      tried.add(target);
      pointerClick(target);
      return true;
    },
    () => {
      const label = labelsOf(control).find((element) => !tried.has(element));
      if (!label) return false;
      tried.add(label);
      pointerClick(label);
      return true;
    },
    () => {
      if (isNativeOption(control) || !(control instanceof HTMLElement)) return false;
      pressSpace(control);
      return true;
    },
  ];

  for (const attempt of attempts) {
    if (!attempt()) continue;
    if (await settles(() => isChecked(control))) return true;
  }
  return false;
}

/**
 * The element a user's click on this option would land on: whatever is
 * topmost at the centre of the visible control, or of the option row when
 * the control itself is hidden. Only an element belonging to the option
 * counts, so an overlay or a neighbouring option is never clicked.
 */
function hitTarget(control: Element, root: Element): Element | null {
  const box = visibleBox(control) ?? visibleBox(root);
  if (!box) return root !== control ? root : null;

  const scope = control.getRootNode() as Document | ShadowRoot;
  const probe = typeof scope.elementFromPoint === 'function' ? scope : control.ownerDocument;
  const hit = probe.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  if (hit && !leadsElsewhere(hit, control) && (composedContains(root, hit) || composedContains(hit, control))) {
    return hit;
  }
  return root !== control ? root : null;
}

/**
 * A link or button inside the option row - "show hint", "zoom image" - whose
 * own action is not selecting the option, and which must never be clicked.
 */
function leadsElsewhere(hit: Element, control: Element): boolean {
  const action = hit.closest('a[href], button, input[type="submit"], input[type="button"], input[type="image"]');
  if (!action || action === control || composedContains(action, control)) return false;
  return !OPTION_WIDGET_ROLES.has(action.getAttribute('role') ?? '');
}

const OPTION_WIDGET_ROLES = new Set(['radio', 'checkbox', 'menuitemradio', 'menuitemcheckbox']);

/** The on-screen box of an element, or null when it occupies none. */
function visibleBox(element: Element): DOMRect | null {
  const box = element.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return null;
  const view = element.ownerDocument.defaultView;
  if (view && view.getComputedStyle(element).opacity === '0') return null;
  return box;
}

/**
 * Everything a mouse click delivers, in order: pointer and mouse down/up at
 * the element's centre, then `click()` - which also runs the browser's own
 * activation, so a label still forwards to its input.
 */
function pointerClick(element: Element): void {
  const box = element.getBoundingClientRect();
  const position = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
    button: 0,
  };
  const view = element.ownerDocument.defaultView;
  const Pointer = view?.PointerEvent ?? view?.MouseEvent ?? MouseEvent;
  const Mouse = view?.MouseEvent ?? MouseEvent;
  const pointer = { ...position, pointerId: 1, pointerType: 'mouse', isPrimary: true };

  element.dispatchEvent(new Pointer('pointerover', pointer));
  element.dispatchEvent(new Pointer('pointerdown', { ...pointer, buttons: 1 }));
  element.dispatchEvent(new Mouse('mousedown', { ...position, buttons: 1 }));
  if (element instanceof HTMLElement) element.focus({ preventScroll: true });
  element.dispatchEvent(new Pointer('pointerup', pointer));
  element.dispatchEvent(new Mouse('mouseup', position));

  if (element instanceof HTMLElement) element.click();
  else element.dispatchEvent(new Mouse('click', position));
}

/** Space on a focused widget: how a keyboard user ticks a radio or checkbox. */
function pressSpace(element: HTMLElement): void {
  const Keyboard = element.ownerDocument.defaultView?.KeyboardEvent ?? KeyboardEvent;
  const key = { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true, composed: true };
  element.focus({ preventScroll: true });
  element.dispatchEvent(new Keyboard('keydown', key));
  element.dispatchEvent(new Keyboard('keyup', key));
}

/** Resolve true as soon as `condition` holds, or false after SETTLE_MS. */
async function settles(condition: () => boolean): Promise<boolean> {
  if (condition()) return true;
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (condition()) return true;
  }
  return false;
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
