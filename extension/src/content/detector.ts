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
  OPTION_WIDGET_SELECTOR,
  TEXT_CONTROL_SELECTOR,
  classifyQuestion,
  extractContext,
  extractOptions,
  extractSelectOptions,
  isIgnorable,
  isMultiSelectControl,
  isNativeOption,
  isOptionIgnorable,
  isRendered,
  labelsOf,
  optionElements,
  visibleText,
} from './extractor';
import {
  composedContains,
  composedParent,
  lowestCommonAncestor,
  queryAllDeep,
  searchRoots,
} from './dom';
import {
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

/**
 * How far for deeply nested components, where each option list sits inside
 * many layers of wrappers before the question's title appears. Levels past
 * MAX_ASCENT stop at anything that holds another question's controls.
 *
 * Option groups only: two or more options are a question in their own right,
 * while a lone text field that far from any prompt is more likely a search
 * box or a comment field, and climbing would sweep up page text to send.
 */
const MAX_ASCENT_DEEP = 12;

const ANY_CONTROL_SELECTOR = `${OPTION_CONTROL_SELECTOR}, ${OPTION_WIDGET_SELECTOR}, select, textarea`;

/** Prompts that say several options may be right, for options shown as plain text. */
const MULTI_SELECT_HINT =
  /\b(?:select|choose|pick|mark|tick|check)\s+(?:all|every|each|two|three|four|2|3|4)\b|\ball\s+that\s+apply\b|\bmore\s+than\s+one\s+(?:answer|option|correct)\b|\bmultiple\s+(?:correct\s+)?answers\b/i;

/** Matches a text line that is itself a lettered or numbered option. */
const OPTION_LINE = /^\s*\(?\s*(?:[a-z]|[ivx]{1,4}|\d{1,2})\s*[).:\]]\s+\S/i;

/** Matches a leading "Question 7" / "Q3." / "12)" / "Question 1 of 40:" label. */
const QUESTION_LABEL =
  /^(?:question|q(?:uestion)?\s*no\.?|q)?\s*\d{1,3}(?:\s*(?:of|\/)\s*\d{1,4})?\s*[.):\-]?\s+/i;

type Candidate = {
  container: HTMLElement;
  /** Native radios/checkboxes or ARIA widgets, in option order. */
  optionControls: Element[];
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
  const controlCandidates = collectControlCandidates(root);
  // A prompt inside a question already found through its controls is that
  // question again, minus its options - one more request with nothing to fill.
  const textOnly = collectTextOnlyCandidates(root).filter(
    (candidate) => !controlCandidates.some(({ container }) => container.contains(candidate.container)),
  );
  const candidates = [...controlCandidates, ...textOnly];
  const detected: DetectedQuestion[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    // Last, and once per candidate: the stylesheet-aware visibility check is
    // the one step here that forces style resolution.
    if (!isRendered(candidate.container)) continue;
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
  // Walked once per scan: every query below covers open shadow roots too.
  const scopes = searchRoots(root);

  const groups = groupOptionControls(scopes);
  for (const controls of groups) {
    const anchor = lowestCommonAncestor(controls);
    if (!anchor) continue;
    const others = groups.filter((group) => group !== controls).flat();
    const container = ascendToPrompt(anchor, controls, optionElements(controls), MAX_ASCENT_DEEP, others);
    if (!container || claimed.has(container)) continue;
    claimed.add(container);
    candidates.push({ container, optionControls: controls });
  }

  // Dropdown questions.
  for (const select of queryAllDeep<HTMLSelectElement>(scopes, 'select')) {
    if (isIgnorable(select) || !controlShown(select) || select.options.length < 2) continue;
    const container = ascendToPrompt(composedParent(select) ?? select, [select], [select, ...labelsOf(select)]);
    if (!container || claimed.has(container)) continue;
    claimed.add(container);
    candidates.push({ container, optionControls: [], select });
  }

  // Free-text questions.
  for (const control of queryAllDeep<HTMLElement>(scopes, TEXT_CONTROL_SELECTOR)) {
    if (isIgnorable(control) || !controlShown(control)) continue;
    if (control instanceof HTMLInputElement && control.type === 'hidden') continue;
    const container = ascendToPrompt(
      composedParent(control) ?? control,
      [control],
      [control, ...labelsOf(control)],
    );
    if (!container || claimed.has(container)) continue;
    claimed.add(container);
    candidates.push({ container, optionControls: [], textControl: control });
  }

  return candidates;
}

/**
 * Every option control on the page - native radios and checkboxes, and ARIA
 * radio/checkbox widgets - in groups of one question each.
 *
 * A shared `name` is the page saying which controls belong together, so it
 * wins (scoped to the form, as browsers scope it). Component libraries often
 * leave it out, or give every checkbox a name of its own, and wrap each
 * option in layers of markup so the options are not siblings; those controls
 * are grouped by structure instead - see `clusterByAncestor`.
 */
function groupOptionControls(scopes: readonly ParentNode[]): Element[][] {
  const native = queryAllDeep<HTMLInputElement>(scopes, OPTION_CONTROL_SELECTOR);
  const widgets = queryAllDeep<Element>(scopes, OPTION_WIDGET_SELECTOR).filter(
    (widget) => !isNativeOption(widget) && !standsInForNative(widget),
  );
  const controls = [...native, ...widgets].filter(
    (control) => !isOptionIgnorable(control) && controlShown(control),
  );

  const groups = new Map<unknown, Element[]>();
  const loose: Element[] = [];
  const add = (key: unknown, control: Element) => {
    const bucket = groups.get(key);
    if (bucket) bucket.push(control);
    else groups.set(key, [control]);
  };

  for (const control of controls) {
    if (isNativeOption(control) && control.name) {
      add(`name:${scopeId(control.form ?? control.getRootNode())}:${control.name}`, control);
      continue;
    }
    const group = isNativeOption(control) ? null : control.closest(WIDGET_GROUP_SELECTOR);
    if (group) add(group, control);
    else loose.push(control);
  }

  // A name used once groups nothing: the page named each checkbox separately.
  for (const [key, bucket] of groups) {
    if (bucket.length >= 2) continue;
    groups.delete(key);
    loose.push(...bucket);
  }

  return [...groups.values(), ...clusterByAncestor(loose)];
}

/** ARIA containers that hold exactly one question's options. */
const WIDGET_GROUP_SELECTOR = '[role="radiogroup"], [role="group"], [role="listbox"], [role="menu"]';

/** How far up from an unnamed control to look for the rest of its options. */
const MAX_GROUP_ASCENT = 8;

/**
 * Group controls that carry no usable name by structure: each joins the
 * nearest ancestor that also holds another control of its kind (radio or
 * checkbox). Siblings meet at their parent; options wrapped in components
 * meet at the list that holds the components, however deep each wrapper is.
 *
 * An option left alone - its wrapper reaches a neighbour's list before any
 * neighbour reaches it - joins the one group inside the ancestor it found,
 * when there is exactly one. A stray checkbox near two questions joins
 * neither.
 */
function clusterByAncestor(controls: readonly Element[]): Element[][] {
  const byKey = new Map<Element, Element[]>();

  for (const control of controls) {
    const multi = isMultiSelectControl(control);
    let node = composedParent(control);
    for (let depth = 0; node && depth < MAX_GROUP_ASCENT; depth += 1) {
      if (node.tagName === 'BODY' || node.tagName === 'HTML') break;
      const ancestor = node;
      const partnered = controls.some(
        (other) =>
          other !== control &&
          isMultiSelectControl(other) === multi &&
          composedContains(ancestor, other),
      );
      if (partnered) {
        const bucket = byKey.get(ancestor);
        if (bucket) bucket.push(control);
        else byKey.set(ancestor, [control]);
        break;
      }
      node = composedParent(node);
    }
  }

  const entries = [...byKey.entries()];
  for (const [key, members] of entries) {
    if (members.length !== 1) continue;
    const inside = entries.filter(
      ([other, others]) => other !== key && others.length > 0 && composedContains(key, other),
    );
    if (inside.length !== 1) continue;
    const target = inside[0]![1];
    target.push(...members.splice(0));
    target.sort(documentOrder);
  }

  return mergeColumns(entries.map(([, members]) => members).filter((members) => members.length >= 2));
}

/**
 * Options laid out in columns meet at each column rather than at the list,
 * so one question arrives as several clusters. Two clusters of one kind with
 * nothing but options between them - no prompt of another question - are
 * one question again.
 */
function mergeColumns(clusters: Element[][]): Element[][] {
  if (clusters.length < 2) return clusters;
  const allOptions = optionElements(clusters.flat());

  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) {
      const a = clusters[i]!;
      const b = clusters[j]!;
      if (isMultiSelectControl(a[0]!) !== isMultiSelectControl(b[0]!)) continue;
      const shared = lowestCommonAncestor([...a, ...b]);
      if (!shared || visibleText(shared, [...allOptions, ...optionElements([...a, ...b])])) continue;
      a.push(...b);
      a.sort(documentOrder);
      clusters.splice(j, 1);
      j -= 1;
    }
  }
  return clusters;
}

/**
 * A widget that only decorates a native input - `<span role="radio">` around
 * or beside a real radio in the same label. The input stands for the option,
 * so it is not counted twice.
 */
function standsInForNative(widget: Element): boolean {
  const inner = widget.querySelector<HTMLInputElement>(OPTION_CONTROL_SELECTOR);
  if (inner && !isOptionIgnorable(inner)) return true;
  const labelled = widget.closest('label')?.querySelector<HTMLInputElement>(OPTION_CONTROL_SELECTOR);
  return Boolean(labelled && !isOptionIgnorable(labelled));
}

/** Stable small ids for forms and roots, so they can key a name group. */
const scopeIds = new WeakMap<object, number>();
let nextScopeId = 0;

function scopeId(scope: object): number {
  let id = scopeIds.get(scope);
  if (id === undefined) {
    id = (nextScopeId += 1);
    scopeIds.set(scope, id);
  }
  return id;
}

/** Document order for two nodes of one tree; nodes of different trees keep their order. */
function documentOrder(a: Element, b: Element): number {
  if (a === b || a.getRootNode() !== b.getRootNode()) return 0;
  // 4 is Node.DOCUMENT_POSITION_FOLLOWING, as a literal for the same reason
  // the observer avoids the `Node` global.
  return a.compareDocumentPosition(b) & 4 ? -1 : 1;
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
  const { container, optionControls, select, textControl, optionElements: textOptions = [] } = candidate;

  const excluded: Element[] = [...optionElements(optionControls), ...textOptions];
  if (select) excluded.push(select);
  if (textControl) {
    excluded.push(textControl);
    excluded.push(...labelsOf(textControl));
  }

  const context = extractContext(container, options.maxContextLength);

  // Code listings and maths live in `context` when there is room for them;
  // with context switched off they stay in the prompt so nothing is lost.
  const inlineMedia = context ? Array.from(container.querySelectorAll(INLINE_MEDIA_SELECTOR)) : [];

  const questionText = extractQuestionText(
    container,
    [...excluded, ...inlineMedia],
    optionControls.length >= 2 || Boolean(select),
  );
  if (!questionText) return null;

  const optionList = select
    ? extractSelectOptions(select)
    : optionControls.length > 0
      ? extractOptions(optionControls)
      : extractTextOptions(textOptions);

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

  if (optionList.length >= 2) {
    request.options = optionList;
    // Checkboxes say it outright; options printed as text can only say so in
    // the prompt. Radio buttons never allow more than one.
    const multiSelect =
      optionControls.length > 0
        ? optionControls.some(isMultiSelectControl)
        : !select && MULTI_SELECT_HINT.test(questionText);
    if (multiSelect) request.multiSelect = true;
  }
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
    ...(optionControls.length > 0 ? { controls: optionControls } : {}),
  };
}

/** Prompt text of the container with option labels and controls removed. */
/**
 * `hasChoices`: the prompt comes with a real group of answer controls. Short
 * stems like "FFC stands for" are then questions whatever their wording; the
 * looks-like-a-question test is for prompts with nothing else to vouch for them.
 */
function extractQuestionText(
  container: Element,
  excluded: readonly Element[],
  hasChoices = false,
): string | null {
  const text = truncate(
    stripQuestionLabel(visibleText(container, excluded)),
    LIMITS.maxQuestionLength,
  );
  if (text.length < LIMITS.minQuestionLength) return null;
  if (!hasChoices && !looksLikeQuestion(text) && text.length < 25) return null;
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
 *
 * `exclusions` is the options' own text - controls, both label styles
 * (wrapping `<label><input> text</label>` and linked `<label for=x>`), and
 * the option rows of unlabelled components. Missing any of it lets the option
 * texts pass for a prompt, so the climb stops at the options box and the
 * question is then discarded for having no text of its own (WatuPRO).
 */
function ascendToPrompt(
  start: Element,
  controls: readonly Element[],
  exclusions: readonly Element[],
  maxAscent = MAX_ASCENT,
  otherOptions: readonly Element[] = [],
): HTMLElement | null {
  let node: Element | null = start;

  for (let depth = 0; node && depth < maxAscent; depth += 1) {
    if (!(node instanceof HTMLElement) || node.tagName === 'BODY') {
      node = composedParent(node);
      continue;
    }

    // Reaching another question's options means this one has no prompt of
    // its own nearby; any text from here up belongs to someone else.
    const here = node;
    if (otherOptions.some((other) => containsAcross(here, other))) return null;

    // Past the usual depth only component wrappers are being climbed, and
    // one that holds another question's controls has gone too far.
    if (depth >= MAX_ASCENT && holdsOtherControls(node, controls)) return null;

    const prompt = visibleText(node, exclusions);
    if (prompt.length >= LIMITS.minQuestionLength) return node;

    const parent: Element | null = composedParent(node);
    if (!parent || parent.tagName === 'BODY' || parent.tagName === 'HTML') {
      return node;
    }
    node = parent;
  }

  return node instanceof HTMLElement ? node : null;
}

/** `contains`, falling back to the composed walk only across shadow roots. */
function containsAcross(ancestor: Element, node: Element): boolean {
  if (ancestor.contains(node)) return true;
  return node.getRootNode() !== ancestor.getRootNode() && composedContains(ancestor, node);
}

/** Whether `node` holds an answer control that is not one of `controls`. */
function holdsOtherControls(node: Element, controls: readonly Element[]): boolean {
  return Array.from(node.querySelectorAll(ANY_CONTROL_SELECTOR)).some(
    (element) =>
      !isOptionIgnorable(element) &&
      !controls.some(
        (control) =>
          control === element || composedContains(control, element) || composedContains(element, control),
      ),
  );
}

/**
 * Whether a control sits in a part of the page that is shown. Checked on its
 * parent, not on the control: sites hide the real checkbox and draw a styled
 * one, but a collapsed panel (IndiaBix's "Workspace" and "Report" textareas,
 * hidden by Bootstrap's `.collapse`) hides the parent too.
 */
function controlShown(control: Element): boolean {
  return isRendered(control.parentElement ?? control);
}

function queryAll<T extends Element>(root: ParentNode, selector: string): T[] {
  return Array.from(root.querySelectorAll(selector)) as T[];
}
