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

const IGNORED_NAME =
  /(^|[-_\s])(nav|navbar|menu|breadcrumb|sidebar|footer|header|advert|ads?|banner|promo|cookie|consent|toolbar|pagination|progress|timer|score)([-_\s]|$)/i;

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
export const TEXT_CONTROL_SELECTOR =
  'textarea, input[type="text"], input[type="number"], input[type="search"], input:not([type])';

/** True when the element sits in page furniture rather than page content. */
export function isIgnorable(element: Element | null): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
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

/** Visible text of a subtree, skipping furniture and any excluded elements. */
export function visibleText(root: Element, excluded: readonly Element[] = []): string {
  const parts: string[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
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

/** The user-visible label for a checkbox or radio, in order of reliability. */
export function labelFor(control: HTMLInputElement): string {
  const doc = control.ownerDocument;

  const id = control.getAttribute('id');
  if (id) {
    const explicit = doc.querySelector(`label[for="${escapeAttributeValue(id)}"]`);
    if (explicit) {
      const text = visibleText(explicit);
      if (text) return stripOptionPrefix(text);
    }
  }

  const wrapping = control.closest('label');
  if (wrapping) {
    const text = visibleText(wrapping, [control]);
    if (text) return stripOptionPrefix(text);
  }

  const ariaLabel = control.getAttribute('aria-label');
  if (ariaLabel) return stripOptionPrefix(ariaLabel);

  const labelledBy = control.getAttribute('aria-labelledby');
  if (labelledBy) {
    const target = doc.getElementById(labelledBy);
    if (target) return stripOptionPrefix(visibleText(target));
  }

  const sibling = control.nextElementSibling;
  if (sibling) {
    const text = visibleText(sibling);
    if (text) return stripOptionPrefix(text);
  }

  return stripOptionPrefix(control.value ?? '');
}

/** Option texts for a group of radio/checkbox controls, de-duplicated. */
export function extractOptions(controls: readonly HTMLInputElement[]): string[] {
  const options: string[] = [];
  const seen = new Set<string>();

  for (const control of controls) {
    const raw = labelFor(control);
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
