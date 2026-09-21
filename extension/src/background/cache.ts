/**
 * A bounded, expiring answer cache keyed by question fingerprint.
 *
 * MV3 service workers are evicted when idle, so this is a best-effort hot
 * cache rather than durable storage - a cold worker simply asks the backend
 * again. The backend keeps its own cache behind the same fingerprint, and both
 * are designed to be swapped for Redis or MongoDB without touching callers.
 */
import { CACHE_MAX_ENTRIES, CACHE_TTL_MS } from '../shared/constants';
import type { QuestionAnswer } from '../shared/types';

interface Entry {
  answer: QuestionAnswer;
  expiresAt: number;
}

export interface AnswerCache {
  get: (key: string) => QuestionAnswer | undefined;
  set: (key: string, answer: QuestionAnswer) => void;
  clear: () => void;
  readonly size: number;
}

export function createAnswerCache(
  ttlMs: number = CACHE_TTL_MS,
  maxEntries: number = CACHE_MAX_ENTRIES,
  now: () => number = Date.now,
): AnswerCache {
  // Map preserves insertion order, which gives least-recently-used eviction
  // for free as long as reads re-insert.
  const entries = new Map<string, Entry>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.answer;
    },

    set(key, answer) {
      entries.delete(key);
      entries.set(key, { answer, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },

    clear() {
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}
