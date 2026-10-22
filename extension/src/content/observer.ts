/**
 * Watches the page for newly rendered questions.
 *
 * Single-page apps rebuild large subtrees constantly, so an unfiltered
 * MutationObserver callback would fire hundreds of times a second. Two guards
 * keep the cost down: mutations are filtered to ones that could plausibly
 * introduce a question, and surviving mutations are coalesced into one
 * debounced scan.
 */
import { MUTATION_DEBOUNCE_MS } from '../shared/constants';

export interface PageObserverOptions {
  /** Called after the page has been quiet for `debounceMs`. */
  onScan: () => void;
  debounceMs?: number;
  /** Attribute changes worth reacting to; others are ignored. */
  attributeFilter?: string[];
}

export interface PageObserver {
  start: () => void;
  stop: () => void;
  /** Request a scan directly, bypassing mutation filtering but not the debounce. */
  schedule: () => void;
  /**
   * Also watch inside a shadow root. Mutations there never reach an observer
   * on the document, so a web component that renders its options late would
   * otherwise go unseen. Watching the same root twice is a no-op.
   */
  watch: (root: Node) => void;
}

const RELEVANT_SELECTOR = 'input, select, textarea, label, form, fieldset, [data-question], .question';

/**
 * `Node.TEXT_NODE` and `Node.ELEMENT_NODE` as literals.
 *
 * The constructor globals (`Node`, `Element`) are not guaranteed to exist
 * everywhere this module can be evaluated, and a `ReferenceError` thrown
 * inside a MutationObserver callback is swallowed by the browser - the page
 * would simply stop being watched, with nothing in the console to say why.
 */
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Could this node have brought a question - or its answer controls - with it? */
function isRelevantNode(node: Node): boolean {
  if (node.nodeType === TEXT_NODE) {
    return (node.nodeValue?.trim().length ?? 0) > 0;
  }
  if (node.nodeType !== ELEMENT_NODE) return false;

  const element = node as Element;
  if (element.matches(RELEVANT_SELECTOR)) return true;
  return (
    element.querySelector(RELEVANT_SELECTOR) !== null ||
    (element.textContent?.trim().length ?? 0) > 0
  );
}

/**
 * `style` and `class` change constantly (animations, hover states, progress
 * bars), so those only count when they land on something holding answer
 * controls - which is exactly how one-question-at-a-time quizzes reveal the
 * next question.
 */
const PRESENTATION_ATTRIBUTES = new Set(['style', 'class']);

function isRelevantMutation(mutation: MutationRecord): boolean {
  if (mutation.type === 'attributes') {
    if (!mutation.attributeName || !PRESENTATION_ATTRIBUTES.has(mutation.attributeName)) return true;
    const target = mutation.target as Element;
    return target.nodeType === ELEMENT_NODE && target.querySelector(RELEVANT_SELECTOR) !== null;
  }
  if (mutation.type === 'characterData') return true;
  return (
    Array.from(mutation.addedNodes).some(isRelevantNode) ||
    Array.from(mutation.removedNodes).some(isRelevantNode)
  );
}

export function createPageObserver(options: PageObserverOptions): PageObserver {
  const debounceMs = options.debounceMs ?? MUTATION_DEBOUNCE_MS;
  const attributeFilter = options.attributeFilter ?? ['data-question', 'aria-hidden', 'hidden', 'style', 'class'];

  let timer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;
  let watched = new WeakSet<Node>();
  const observeOptions: MutationObserverInit = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter,
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      options.onScan();
    }, debounceMs);
  };

  const handle: MutationCallback = (mutations) => {
    // `some` short-circuits: a burst of irrelevant records costs almost nothing.
    if (mutations.some(isRelevantMutation)) schedule();
  };

  return {
    start() {
      if (observer) return;
      observer = new MutationObserver(handle);
      observer.observe(document.documentElement, observeOptions);
      schedule();
    },
    stop() {
      observer?.disconnect();
      observer = null;
      watched = new WeakSet<Node>();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    schedule,
    watch(root) {
      if (!observer || watched.has(root)) return;
      watched.add(root);
      observer.observe(root, observeOptions);
    },
  };
}
