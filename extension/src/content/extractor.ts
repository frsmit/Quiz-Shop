/**
 * Turns a candidate DOM subtree into the fields of a `QuestionRequest`.
 *
 * Everything here is deliberately read-only and side-effect free so it can be
 * unit tested against fixture markup, and so the content script never has to
 * ship the whole page to the backend to work out what the question is.
 */
import { LIMITS } from '../shared/constants';
import type { QuestionType } from '../shared/types';
import { escapeAttributeValue, normalizeWhitespace, stripOptionPrefix, truncate } from './normalize';
import { composedContains, composedParent } from './dom';

/** Structural elements whose text is never part of a question. */
const IGNORED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'NAV',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'IFRAME',
  'SVG',
  'BUTTON',
]);

const IGNORED_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search']);

/**
 * Ids and classes that mark page furniture. The lookbehind exempts layout
 * modifiers (`right-sidebar`, `has-sidebar`, `sticky-header`): those describe
 * the page's shape and sit on the wrapper that holds the content itself. It
 * also exempts the parts of a content block (`card-header`, `panel-footer`,
 * `question-header`): Bootstrap-built quiz sites put the question itself in
 * the card's header.
 */
const IGNORED_NAME =
  /(^|[-_\s])(?<!(?:^|[\s_])(?:has|no|with|without|left|right|both|full|sticky|fixed|transparent|card|panel|question|quiz)-)(nav|navbar|menu|breadcrumb|sidebar|footer|header|advert|ads?|banner|promo|cookie|consent|toolbar|pagination|progress|timer|score)([-_\s]|$)/i;

/**
 * `<body>` and `<html>` never count as furniture. Themes put layout classes on
 * them - WordPress's GeneratePress sets `right-sidebar nav-float-right
 * header-aligned-left` on `<body>` - and matching those would discard the
 * whole page.
 */
const DOCUMENT_ROOTS = new Set(['BODY', 'HTML']);

const CODE_HINT =
  /(\b(function|const|let|var|class|def|public\s+static|#include|import|return|console\.log|System\.out|printf)\b|=>|;\s*$)/m;

const MATH_HINT = /(\\frac|\\sqrt|\\sum|\\int|\\pi|\^\d|\b\d+\s*[+\-*/^]\s*\d+|[∫∑√π≤≥≠±×÷])/;

/** Elements that carry maths in an accessible form (MathML, KaTeX, MathJax). */
const MATH_SELECTOR =
  'math, .katex, .MathJax, mjx-container, [data-latex], annotation[encoding*="tex" i]';

/**
 * Content that belongs in `context` rather than in the prompt text: the same
 * listing appearing in both wastes tokens and reads badly.
 */
export const INLINE_MEDIA_SELECTOR = `pre, code, [data-code], ${MATH_SELECTOR}`;

export const OPTION_CONTROL_SELECTOR = 'input[type="radio"], input[type="checkbox"]';

/**
 * Option widgets with no native input behind them: `<div role="radio"
 * aria-checked>` (Google Forms), `<button role="checkbox">` (Radix, shadcn),
 * `<ion-radio>` hosts. They carry their state in `aria-checked`.
 */
export const OPTION_WIDGET_SELECTOR =
  '[role="radio"], [role="checkbox"], [role="menuitemradio"], [role="menuitemcheckbox"]';
export const TEXT_CONTROL_SELECTOR =
  'textarea, input[type="text"], input[type="number"], input[type="search"], input:not([type])';

/** True when the element sits in page furniture rather than page content. */
export function isIgnorable(element: Element | null): boolean {
  for (let node: Element | null = element; node; node = composedParent(node)) {
    if (DOCUMENT_ROOTS.has(node.tagName)) break;
    if (IGNORED_TAGS.has(node.tagName)) return true;

    const role = node.getAttribute('role');
    if (role && IGNORED_ROLES.has(role.toLowerCase())) return true;

    if (node.getAttribute('aria-hidden') === 'true') return true;
    if (node.hasAttribute('hidden')) return true;

    if (typeof node.className === 'string' && IGNORED_NAME.test(`${node.id} ${node.className}`)) {
      return true;
    }

    const style = (node as HTMLElement).style;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
  }
  return false;
}

/**
 * True when the element is actually rendered, stylesheet rules included.
 *
 * `isIgnorable` only sees inline styles, which is cheap enough to run per text
 * node. This is the stylesheet-aware check, run once per question container:
 * quiz plugins such as WatuPRO render every question up front and hide all but
 * the current one with a CSS class, and those must not be answered unseen.
 * Checked on the container rather than the input, because many sites hide
 * the real checkbox and draw a styled one in its place.
 */
export function isRendered(element: Element): boolean {
  const probe = element as Element & { checkVisibility?: (options?: object) => boolean };
  if (typeof probe.checkVisibility === 'function') {
    return probe.checkVisibility({ visibilityProperty: true });
  }

  // Fallback for engines without `checkVisibility` (jsdom in tests).
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  for (let node: Element | null = element; node; node = composedParent(node)) {
    const style = view.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

/**
 * True when the stylesheet hides this element itself. Ancestors are not
 * checked: the text walk below visits elements top-down and prunes at the
 * first hidden one, so its descendants are never reached.
 *
 * Opacity counts here, unlike in `isRendered`: quiz sites collapse the
 * "Answer & Solution" panel with `opacity: 0` (ExamVeda), and reading it would
 * hand the site's own answer to the model as part of the question.
 *
 * So does screen-reader-only text: Moodle and Bootstrap pages label each
 * answer group with a `visually-hidden` legend ("Select one:"), which would
 * otherwise stand in for the visible prompt above it.
 */
function hiddenByStyle(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  try {
    const style = view.getComputedStyle(element);
    return (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      screenReaderOnly(style)
    );
  } catch {
    // Some engines (jsdom) cannot compute styles for MathML; count it as shown.
    return false;
  }
}

/** The `sr-only` / `visually-hidden` recipe: taken out of flow and clipped to nothing. */
function screenReaderOnly(style: CSSStyleDeclaration): boolean {
  if (style.position !== 'absolute' && style.position !== 'fixed') return false;
  const clipped =
    /^rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)$/.test(style.clip) ||
    /^inset\(\s*50%\s*\)$/.test(style.clipPath);
  const squeezed =
    style.overflow === 'hidden' && parseFloat(style.width) <= 1 && parseFloat(style.height) <= 1;
  return clipped || squeezed;
}

/** Visible text of a subtree, skipping furniture, hidden and excluded elements. */
export function visibleText(root: Element, excluded: readonly Element[] = []): string {
  const parts: string[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        // REJECT prunes the whole subtree; SKIP carries on into the children.
        if (node !== root && hiddenByStyle(node as Element)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }

      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (excluded.some((element) => element === parent || element.contains(parent))) {
        return NodeFilter.FILTER_REJECT;
      }
      if (isIgnorable(parent)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    parts.push(node.nodeValue ?? '');
  }
  return normalizeWhitespace(parts.join(' '));
}

/** A native `<input type="radio">` or `<input type="checkbox">`. */
export function isNativeOption(control: Element): control is HTMLInputElement {
  if (control.tagName !== 'INPUT') return false;
  const type = (control as HTMLInputElement).type;
  return type === 'radio' || type === 'checkbox';
}

/** A control that allows several picks: a checkbox, native or ARIA. */
export function isMultiSelectControl(control: Element): boolean {
  if (isNativeOption(control)) return control.type === 'checkbox';
  const role = control.getAttribute('role');
  return role === 'checkbox' || role === 'menuitemcheckbox';
}

/** Whether an option control is selected, read the way assistive tech reads it. */
export function isChecked(control: Element): boolean {
  if (isNativeOption(control)) return control.checked;
  const state = control.getAttribute('aria-checked') ?? control.getAttribute('aria-selected');
  if (state !== null) return state === 'true';
  // Radix-style widgets mirror their state here as well.
  return control.getAttribute('data-state') === 'checked';
}

export function isDisabled(control: Element): boolean {
  if ((control as HTMLInputElement | HTMLButtonElement).disabled === true) return true;
  return control.getAttribute('aria-disabled') === 'true';
}

/**
 * `isIgnorable` for an option control. A widget is judged by where it sits,
 * not by its own tag: `<button role="radio">` is an answer option, even
 * though a plain `<button>`'s text is never part of a question.
 */
export function isOptionIgnorable(control: Element): boolean {
  if (isNativeOption(control)) return isIgnorable(control);
  if (control.getAttribute('aria-hidden') === 'true' || control.hasAttribute('hidden')) return true;
  return isIgnorable(composedParent(control));
}

/**
 * The element that is one whole option on screen: the outermost ancestor of
 * `control` that holds no other option of the same question. In a component
 * library that is the row the user would click - a wrapper around a hidden
 * input, a styled dot and the option's text, often several layers deep.
 */
export function optionRoot(control: Element, group: readonly Element[]): Element {
  let root = control;
  if (group.length < 2) return root;

  for (let depth = 0; depth < 8; depth += 1) {
    const parent = composedParent(root);
    if (!parent || DOCUMENT_ROOTS.has(parent.tagName)) break;
    if (group.some((other) => other !== control && composedContains(parent, other))) break;
    root = parent;
  }
  return root;
}

/**
 * The user-visible label for an option control - native radio or checkbox,
 * or ARIA widget - in order of reliability. `group` is every option of the
 * question; with it, a control whose text sits in a sibling component rather
 * than in a `<label>` still reads as its text, not as its `value`.
 */
export function labelFor(control: Element, group: readonly Element[] = []): string {
  // Every label of the control, wrapping and `for=` alike. Sites often give an
  // option two - a letter badge (`A)`) and the text - so the most informative
  // wins rather than whichever comes first in the document.
  const texts = labelsOf(control)
    .map((label) => stripOptionPrefix(visibleText(label, [control])))
    .filter((text) => text.length > 0 && !BARE_MARKER.test(text));
  if (texts.length > 0) return texts.reduce((best, text) => (text.length > best.length ? text : best));

  const ariaLabel = control.getAttribute('aria-label');
  if (ariaLabel?.trim()) return stripOptionPrefix(ariaLabel);

  const labelledBy = labelledByText(control);
  if (labelledBy) return stripOptionPrefix(labelledBy);

  // A widget usually holds its own text. `<button role="radio">` counts as
  // furniture to `visibleText`, hence the raw text as a fallback.
  if (!isNativeOption(control)) {
    const own = visibleText(control) || normalizeWhitespace(control.textContent ?? '');
    if (own) return stripOptionPrefix(own);
  }

  const sibling = control.nextElementSibling;
  if (sibling) {
    const text = visibleText(sibling);
    if (text) return stripOptionPrefix(text);
  }

  if (group.length > 1) {
    const text = visibleText(optionRoot(control, group), [control]);
    if (text) return stripOptionPrefix(text);
  }

  return stripOptionPrefix((control as HTMLInputElement).value ?? '');
}

/** The text of every element `aria-labelledby` names, in order. */
function labelledByText(control: Element): string {
  const ids = control.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? [];
  return normalizeWhitespace(
    labelledByElements(control, ids)
      .map((element) => visibleText(element))
      .join(' '),
  );
}

/** Elements named by `aria-labelledby`, looked up in the control's own tree first. */
export function labelledByElements(control: Element, ids?: string[]): Element[] {
  const names = ids ?? control.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? [];
  const root = control.getRootNode() as Document | ShadowRoot;
  return names
    .map((id) => root.getElementById?.(id) ?? control.ownerDocument.getElementById(id))
    .filter((element): element is HTMLElement => element !== null && element !== control);
}

/** A label that is only an option marker: `A`, `A)`, `(b)`, `3.`. */
const BARE_MARKER = /^\(?\s*(?:[a-z]|[ivx]{1,4}|\d{1,2})\s*[).:\]]?$/i;

/** All labels of a control: `control.labels`, with a fallback for engines without it. */
export function labelsOf(control: Element): Element[] {
  const native = (control as HTMLInputElement).labels;
  if (native && native.length > 0) return Array.from(native);

  const found: Element[] = [];
  const wrapping = control.closest('label');
  if (wrapping) found.push(wrapping);
  const id = control.getAttribute('id');
  if (id) {
    const root = control.getRootNode() as Document | ShadowRoot;
    const scope = typeof root.querySelectorAll === 'function' ? root : control.ownerDocument;
    for (const label of scope.querySelectorAll(`label[for="${escapeAttributeValue(id)}"]`)) {
      if (!found.includes(label)) found.push(label);
    }
  }
  return found;
}

/**
 * Everything that is an option's own text rather than the question's: the
 * controls, their labels, the elements `aria-labelledby` points at, and -
 * for an unlabelled control - the whole option row around it.
 */
export function optionElements(controls: readonly Element[]): Element[] {
  const elements: Element[] = [];
  for (const control of controls) {
    elements.push(control);
    const labels = labelsOf(control);
    elements.push(...labels, ...labelledByElements(control));
    if (labels.length === 0) {
      const root = optionRoot(control, controls);
      if (root !== control) elements.push(root);
    }
  }
  return elements;
}

/** Option texts for a group of option controls, de-duplicated. */
export function extractOptions(controls: readonly Element[]): string[] {
  const options: string[] = [];
  const seen = new Set<string>();

  for (const control of controls) {
    const raw = labelFor(control, controls);
    if (!raw) continue;
    const value = truncate(raw, LIMITS.maxOptionLength);
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(value);
  }

  return options.slice(0, LIMITS.maxOptions);
}

/** Option texts of a `<select>`, ignoring the usual empty placeholder. */
export function extractSelectOptions(select: HTMLSelectElement): string[] {
  return Array.from(select.options)
    .filter((option, index) => !(index === 0 && option.value === ''))
    .map((option) => truncate(stripOptionPrefix(option.textContent ?? ''), LIMITS.maxOptionLength))
    .filter((text) => text.length > 0)
    .slice(0, LIMITS.maxOptions);
}

/**
 * Supporting material for the question: code listings and maths inside the
 * container, plus a preceding passage when the question refers to one.
 * Capped so a long page can never be smuggled out as "context".
 */
export function extractContext(container: Element, maxLength: number): string | undefined {
  if (maxLength <= 0) return undefined;
  const pieces: string[] = [];

  const passage = precedingPassage(container);
  if (passage) pieces.push(passage);

  for (const code of Array.from(container.querySelectorAll('pre, code, [data-code]'))) {
    if (isIgnorable(code)) continue;
    const text = normalizeWhitespace(code.textContent ?? '');
    if (text.length > 8 && !pieces.includes(text)) pieces.push(text);
  }

  for (const math of Array.from(container.querySelectorAll(MATH_SELECTOR))) {
    const text = readMath(math);
    if (text && !pieces.includes(text)) pieces.push(text);
  }

  if (pieces.length === 0) return undefined;
  return truncate(pieces.join('\n\n'), maxLength);
}

/**
 * A substantial paragraph immediately before the question, if there is one -
 * the shared extract that several questions refer to. Neighbouring questions
 * are skipped rather than absorbed: pulling the previous question's code
 * listing in as "context" would both mislead the model and leak more of the
 * page than the user asked to send.
 */
function precedingPassage(container: Element): string | undefined {
  let sibling = container.previousElementSibling;
  let hops = 0;

  while (sibling && hops < 3) {
    hops += 1;

    if (isIgnorable(sibling) || isQuestionLike(sibling)) {
      sibling = sibling.previousElementSibling;
      continue;
    }

    const text = visibleText(sibling);
    if (text.length >= 80) return truncate(text, 1200);
    return undefined;
  }
  return undefined;
}

/**
 * Read a maths element as linear text.
 *
 * LaTeX is preferred wherever the page exposes it - `data-latex`, or the
 * `<annotation encoding="application/x-tex">` that MathJax and KaTeX emit.
 * Bare MathML is converted structurally, because its flattened `textContent`
 * loses exactly the information that matters: `3x²` reads as "3 x 2".
 */
export function readMath(element: Element): string {
  const latex = element.getAttribute('data-latex');
  if (latex) return normalizeWhitespace(latex);

  const annotation = element.querySelector('annotation[encoding*="tex" i]');
  if (annotation?.textContent) return normalizeWhitespace(annotation.textContent);

  if (element.tagName.toLowerCase() === 'math') return normalizeWhitespace(mathmlToText(element));

  return normalizeWhitespace(element.textContent ?? '');
}

/** Structural MathML to a linear, unambiguous string. */
function mathmlToText(node: Element): string {
  const children = Array.from(node.children);
  const part = (index: number) => (children[index] ? mathmlToText(children[index] as Element) : '');

  switch (node.tagName.toLowerCase()) {
    case 'mi':
    case 'mn':
    case 'mo':
    case 'mtext':
      return (node.textContent ?? '').trim();
    case 'msup':
      return `${part(0)}^${wrap(part(1))}`;
    case 'msub':
      return `${part(0)}_${wrap(part(1))}`;
    case 'msubsup':
      return `${part(0)}_${wrap(part(1))}^${wrap(part(2))}`;
    case 'mfrac':
      return `(${part(0)})/(${part(1)})`;
    case 'msqrt':
      return `sqrt(${children.map((_, index) => part(index)).join('')})`;
    case 'mroot':
      return `root(${part(1)})(${part(0)})`;
    default:
      return children.map((_, index) => part(index)).join('');
  }
}

/** Parenthesise a multi-character exponent or subscript. */
function wrap(value: string): string {
  return value.length > 1 ? `(${value})` : value;
}

/** Does this element look like a question of its own rather than a passage? */
function isQuestionLike(element: Element): boolean {
  return (
    element.matches('[data-question], .question') ||
    element.querySelector('input, select, textarea, [data-question], .question') !== null
  );
}

export interface ClassifyInput {
  container: Element;
  questionText: string;
  options: readonly string[];
  hasTextControl: boolean;
  context?: string | undefined;
}

/**
 * Picks the transport type. Option-bearing questions are `multiple_choice`
 * whatever their subject, because the answer has to be one of the options -
 * any code or maths that came with them travels in `context` instead.
 */
export function classifyQuestion(input: ClassifyInput): QuestionType {
  if (input.options.length >= 2) return 'multiple_choice';

  const haystack = `${input.questionText}\n${input.context ?? ''}`;
  if (input.container.querySelector('pre, code') || CODE_HINT.test(haystack)) {
    return 'programming';
  }
  if (input.container.querySelector(MATH_SELECTOR) || MATH_HINT.test(haystack)) {
    return 'mathematical';
  }
  if (input.hasTextControl) return 'short_answer';
  return 'unknown';
}
