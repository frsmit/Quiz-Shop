/**
 * Text normalisation and fingerprinting.
 *
 * Fingerprints exist so a question that is re-rendered - which React and Vue
 * do constantly - is recognised as the same question rather than answered
 * again. They are derived from normalised content, never from DOM identity.
 */

/** Collapse all whitespace runs (including non-breaking spaces) to one space. */
export function normalizeWhitespace(value: string): string {
  return value.replace(/[\s ​]+/g, ' ').trim();
}

const OPTION_PREFIX = /^\s*(?:\(?\s*(?:[a-z]|[ivx]{1,4}|\d{1,2})\s*[).:\]]|[-*•●▪])\s+/i;

/** Strip an `A.` / `(b)` / `3)` / bullet marker from the head of an option. */
export function stripOptionPrefix(value: string): string {
  return normalizeWhitespace(value.replace(OPTION_PREFIX, ''));
}

/**
 * Normalisation used for hashing and equality, never sent anywhere.
 *
 * Brackets and `!` are kept deliberately: answers here are often code or
 * complexity classes, where dropping them would make `O(n)` and `O(n!)`
 * indistinguishable and let an answer be filled into the wrong option.
 */
export function canonicalize(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}'"+\-*/=<>^%.$!,:(){}[\] ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** FNV-1a, seeded so two passes can be concatenated into a wider digest. */
function fnv1a(input: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A 64-bit-wide hex digest over the canonical question and its options.
 * Two independent seeds keep accidental collisions negligible for the
 * few hundred questions a page realistically holds.
 */
export function fingerprint(parts: readonly string[]): string {
  const joined = parts.map(canonicalize).join('\u0001');
  const high = fnv1a(joined, 0x811c9dc5);
  const low = fnv1a(`${joined}\u0002${joined.length}`, 0x811c9dc5 ^ 0x5f5f5f5f);
  return `${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

/** Cut a string to `max` characters on a word boundary where one is nearby. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const clipped = value.slice(0, max);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace >= max * 0.8 ? clipped.slice(0, lastSpace) : clipped).trimEnd();
}

/** Heuristic: does this text read like a question or a task instruction? */
export function looksLikeQuestion(text: string): boolean {
  const trimmed = normalizeWhitespace(text);
  if (trimmed.length < 8) return false;
  if (trimmed.endsWith('?')) return true;
  return /^(what|which|who|whom|whose|when|where|why|how|name|list|state|define|explain|describe|identify|calculate|compute|evaluate|solve|simplify|choose|select|write|complete|fill|convert|prove|derive|find|determine|match|arrange|output|predict)\b/i.test(
    trimmed,
  );
}

/**
 * Escape a value for use inside a quoted attribute selector.
 * `CSS.escape` is not available in every DOM implementation the detector runs
 * under (jsdom in tests, older embedded engines), and quoting the value only
 * needs the two characters below.
 */
export function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
