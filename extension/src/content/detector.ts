/**
 * Locates questions in a DOM tree.
 *
 * The strategy is bottom-up: find the answer controls first (radio groups,
 * selects, text fields), then walk outwards to the smallest ancestor that also
 * contains prompt text. Pages that show questions as plain text with lettered
 * options - common in static practice sets - are picked up by a second pass.
 *
 * Working outwards from controls rather than scanning every element keeps the
 * cost proportional to the number of answerable things on the page, not to the
 * size of the page.
 */
import { LIMITS } from '../shared/constants';
import type { DetectedQuestion, QuestionRequest } from '../shared/types';
import {
  INLINE_MEDIA_SELECTOR,
  OPTION_CONTROL_SELECTOR,
  TEXT_CONTROL_SELECTOR,
  classifyQuestion,
  extractContext,
  extractOptions,
  extractSelectOptions,
  isIgnorable,
  visibleText,
} from './extractor';
import {
  escapeAttributeValue,
  fingerprint,
  looksLikeQuestion,
  stripOptionPrefix,
  truncate,
} from './normalize';

export interface DetectOptions {
  /** Upper bound on the context string attached to each question. */
  maxContextLength: number;
  /** Page URL recorded as the question's source. */
  url?: string;
  /** Page title recorded as the question's source. */
  title?: string;
}

/** How far outwards from a control we will look for the prompt text. */
const MAX_ASCENT = 6;

/** Matches a text line that is itself a lettered or numbered option. */
const OPTION_LINE = /^\s*\(?\s*(?:[a-z]|[ivx]{1,4}|\d{1,2})\s*[).:\]]\s+\S/i;

/** Matches a leading "Question 7" / "Q3." / "12)" numbering label. */
const QUESTION_LABEL = /^(?:question|q(?:uestion)?\s*no\.?|q)?\s*\d{1,3}\s*[.):\-]?\s+/i;

type Candidate = {
  container: HTMLElement;
  optionControls: HTMLInputElement[];
  select?: HTMLSelectElement;
  textControl?: HTMLElement;
  /** Elements holding plain-text options, excluded from the prompt text. */
  optionElements?: Element[];
};

/**
 * Detect every distinct question inside `root`.
 * The result is de-duplicated by fingerprint and ordered by document position.
 */
export function detectQuestions(root: ParentNode, options: DetectOptions): DetectedQuestion[] {
  const candidates = [...collectControlCandidates(root), ...collectTextOnlyCandidates(root)];
  const detected: DetectedQuestion[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const question = buildQuestion(candidate, options);
    if (!question) continue;
    if (seen.has(question.fingerprint)) continue;
    seen.add(question.fingerprint);
    detected.push(question);
  }

  return detected;
}

/** Group answer controls into candidate question containers. */
function collectControlCandidates(root: ParentNode): Candidate[] {
  const candidates: Candidate[] = [];
  const claimed = new Set<Element>();

  // Radio and checkbox groups, keyed by `name` where the page provides one.
  const groups = new Map<string, HTMLInputElement[]>();
  for (const control of queryAll<HTMLInputElement>(root, OPTION_CONTROL_SELECTOR)) {
    if (isIgnorable(control)) continue;
    const key = control.name
      ? `name:${control.name}`
      : `dom:${indexOfElement(control.parentElement ?? control)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(control);
    else groups.set(key, [control]);
  }

  for (const controls of groups.values()) {
    if (controls.length < 2) continue;
    const anchor = lowestCommonAncestor(controls);
    if (!anchor) continue;
    const container = ascendToPrompt(anchor, controls);
    if (!container || claimed.has(container)) continue;
    claimed.add(container);
    candidates.push({ container, optionControls: controls });
  }

  // Dropdown questions.
  for (const select of queryAll<HTMLSelectElement>(root, 'select')) {
    if (isIgnorable(select) || select.options.length < 2) continue;
    const container = ascendToPrompt(select.parentElement ?? select, [select]);
    if (!container || claimed.has(container)) continue;
    claimed.add(container);
    candidates.push({ container, optionControls: [], select });
  }

  // Free-text questions.
  for (const control of queryAll<HTMLElement>(root, TEXT_CONTROL_SELECTOR)) {
    if (isIgnorable(control)) continue;
    if (control instanceof HTMLInputElement && control.type === 'hidden') continue;
    const container = ascendToPrompt(control.parentElement ?? control, [control]);
    if (!container || claimed.has(container)) continue;
    claimed.add(container);
    candidates.push({ container, optionControls: [], textControl: control });
  }

  return candidates;
}

/**
 * Questions rendered as static text ("1. What is X?" followed by "A. ...").
 * Only containers that hold no answer controls are considered, so this never
 * competes with the control-driven pass above.
 */
function collectTextOnlyCandidates(root: ParentNode): Candidate[] {
  const candidates: Candidate[] = [];

  for (const element of queryAll<HTMLElement>(
    root,
    '[data-question], .question, li, article, section, div',
  )) {
    if (isIgnorable(element)) continue;
    if (element.querySelector(`${OPTION_CONTROL_SELECTOR}, ${TEXT_CONTROL_SELECTOR}, select`)) continue;
    if (element.querySelector('[data-question], .question')) continue;

    const optionElements = letteredOptionElements(element);
    const text = stripQuestionLabel(visibleText(element, optionElements));
    if (text.length < LIMITS.minQuestionLength || text.length > LIMITS.maxQuestionLength) continue;
    if (!looksLikeQuestion(text)) continue;

    // Prefer the innermost element that still carries the whole question.
    const inner = Array.from(element.children).find(
      (child) => stripQuestionLabel(visibleText(child, optionElements)).length === text.length,
    );
    if (inner && optionElements.length === 0) continue;

    candidates.push({ container: element, optionControls: [], optionElements });
  }

  return candidates;
}

/** Leaf elements whose text is a lettered or numbered option line. */
function letteredOptionElements(container: Element): Element[] {
  return Array.from(container.querySelectorAll('li, p, div, span'))
    .filter((element) => element.children.length === 0 && !isIgnorable(element))
    .filter((element) => OPTION_LINE.test(visibleText(element)));
}

/** Drop a leading "Question 4" style label so it never reaches the model. */
function stripQuestionLabel(text: string): string {
  const stripped = text.replace(QUESTION_LABEL, '').trim();
  return stripped.length >= LIMITS.minQuestionLength ? stripped : text;
}

/** Assemble a `DetectedQuestion`, or `null` when the candidate is not usable. */
function buildQuestion(candidate: Candidate, options: DetectOptions): DetectedQuestion | null {
  const { container, optionControls, select, textControl, optionElements = [] } = candidate;

  const excluded: Element[] = [...optionControls, ...optionElements];
  for (const control of optionControls) {
    const label = control.closest('label') ?? labelElementFor(control);
    if (label) excluded.push(label);
  }
  if (select) excluded.push(select);
  if (textControl) {
    excluded.push(textControl);
    const label = textControl.closest('label') ?? labelElementFor(textControl);
    if (label) excluded.push(label);
  }

  const context = extractContext(container, options.maxContextLength);

  // Code listings and maths live in `context` when there is room for them;
  // with context switched off they stay in the prompt so nothing is lost.
  const inlineMedia = context ? Array.from(container.querySelectorAll(INLINE_MEDIA_SELECTOR)) : [];

  const questionText = extractQuestionText(container, [...excluded, ...inlineMedia]);
  if (!questionText) return null;

  const optionList = select
    ? extractSelectOptions(select)
    : optionControls.length > 0
      ? extractOptions(optionControls)
      : extractTextOptions(optionElements);

  const request: QuestionRequest = {
    question: questionText,
    type: classifyQuestion({
      container,
      questionText,
      options: optionList,
      hasTextControl: Boolean(textControl),
      context,
    }),
  };

  if (optionList.length >= 2) request.options = optionList;
  if (context) request.context = context;
  if (options.url || options.title) {
    request.source = {
      ...(options.url ? { url: options.url } : {}),
      ...(options.title ? { title: options.title } : {}),
    };
  }

  return {
    fingerprint: fingerprint([request.question, ...(request.options ?? [])]),
    request,
    container,
  };
}

/** Prompt text of the container with option labels and controls removed. */
function extractQuestionText(container: Element, excluded: readonly Element[]): string | null {
  const text = truncate(
    stripQuestionLabel(visibleText(container, excluded)),
    LIMITS.maxQuestionLength,
  );
  if (text.length < LIMITS.minQuestionLength) return null;
  if (!looksLikeQuestion(text) && text.length < 25) return null;
  return text;
}

/** Lettered options written as plain text rather than as form controls. */
function extractTextOptions(optionElements: readonly Element[]): string[] {
  const options = optionElements
    .map((element) => stripOptionPrefix(visibleText(element)))
    .filter((text) => text.length > 0 && text.length <= LIMITS.maxOptionLength);

  return options.length >= 2 ? options.slice(0, LIMITS.maxOptions) : [];
}

/**
 * Walk up from `start` until the subtree contains prompt text that is not part
 * of the answer controls themselves. Stops early rather than swallowing a
 * sibling question.
 */
function ascendToPrompt(start: Element, controls: readonly Element[]): HTMLElement | null {
  let node: Element | null = start;

  for (let depth = 0; node && depth < MAX_ASCENT; depth += 1) {
    if (!(node instanceof HTMLElement) || node.tagName === 'BODY') {
      node = node.parentElement;
      continue;
    }

    const labels = controls.flatMap((control) => {
      const label = control.closest('label');
      return label ? [label] : [];
    });

    const prompt = visibleText(node, [...controls, ...labels]);
    if (prompt.length >= LIMITS.minQuestionLength) return node;

    const parent: HTMLElement | null = node.parentElement;
    if (!parent || parent.tagName === 'BODY' || parent.tagName === 'HTML') {
      return node;
    }
    node = parent;
  }

  return node instanceof HTMLElement ? node : null;
}

function lowestCommonAncestor(elements: readonly Element[]): Element | null {
  const [first, ...rest] = elements;
  if (!first) return null;

  let ancestor: Element | null = first.parentElement;
  while (ancestor) {
    if (rest.every((element) => ancestor?.contains(element))) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return null;
}

function labelElementFor(control: Element): Element | null {
  const id = control.getAttribute('id');
  if (!id) return null;
  return control.ownerDocument.querySelector(`label[for="${escapeAttributeValue(id)}"]`);
}

/** Position among siblings, used to key control groups that lack a `name`. */
function indexOfElement(element: Element): string {
  const parent = element.parentElement;
  if (!parent) return element.tagName;
  return `${parent.tagName}:${Array.prototype.indexOf.call(parent.children, element)}`;
}

function queryAll<T extends Element>(root: ParentNode, selector: string): T[] {
  return Array.from(root.querySelectorAll(selector)) as T[];
}
