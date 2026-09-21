/**
 * Answer cache.
 *
 * The interface is asynchronous on purpose: the in-memory store below is the
 * only implementation today, but a Redis or MongoDB store can be dropped in
 * behind the same three methods without touching the question service.
 */
import type { QuestionAnswer } from '../question/question.schema.js';

export interface AnswerStore {
  get: (key: string) => Promise<QuestionAnswer | undefined>;
  set: (key: string, answer: QuestionAnswer) => Promise<void>;
  clear: () => Promise<void>;
}

interface Entry {
  answer: QuestionAnswer;
  expiresAt: number;
}

export interface InMemoryAnswerStoreOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

/** Bounded LRU with per-entry expiry. */
export class InMemoryAnswerStore implements AnswerStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: InMemoryAnswerStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
  }

  get(key: string): Promise<QuestionAnswer | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve(undefined);

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return Promise.resolve(undefined);
    }

    // Re-insert so Map iteration order stays least-recently-used first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return Promise.resolve(entry.answer);
  }

  set(key: string, answer: QuestionAnswer): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { answer, expiresAt: this.now() + this.ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.entries.clear();
    return Promise.resolve();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** A store that keeps nothing, used when caching is switched off. */
export class NullAnswerStore implements AnswerStore {
  get(): Promise<QuestionAnswer | undefined> {
    return Promise.resolve(undefined);
  }

  set(): Promise<void> {
    return Promise.resolve();
  }

  clear(): Promise<void> {
    return Promise.resolve();
  }
}
