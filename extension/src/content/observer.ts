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
}

const RELEVANT_SELECTOR = 'input, select, textarea, label, form, fieldset, [data-question], .question';

/** Could this node have brought a question - or its answer controls - with it? */
function isRelevantNode(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.nodeValue?.trim().length ?? 0) > 0;
  }
  if (!(node instanceof Element)) return false;
  if (node.matches(RELEVANT_SELECTOR)) return true;
  return node.querySelector(RELEVANT_SELECTOR) !== null || (node.textContent?.trim().length ?? 0) > 0;
}

function isRelevantMutation(mutation: MutationRecord): boolean {
  if (mutation.type === 'attributes') return true;
  if (mutation.type === 'characterData') return true;
  return (
    Array.from(mutation.addedNodes).some(isRelevantNode) ||
    Array.from(mutation.removedNodes).some(isRelevantNode)
  );
}

export function createPageObserver(options: PageObserverOptions): PageObserver {
  const debounceMs = options.debounceMs ?? MUTATION_DEBOUNCE_MS;
  const attributeFilter = options.attributeFilter ?? ['data-question', 'aria-hidden', 'hidden'];

  let timer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;

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
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter,
      });
      schedule();
    },
    stop() {
      observer?.disconnect();
      observer = null;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    schedule,
  };
}
