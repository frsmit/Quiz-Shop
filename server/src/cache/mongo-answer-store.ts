/**
 * MongoDB-backed answer cache.
 *
 * Survives restarts and redeploys, and is shared by every instance behind a
 * load balancer. Expiry is enforced twice: reads ignore anything past
 * `expiresAt`, and a TTL index deletes it in the background (MongoDB's TTL
 * monitor runs about once a minute, so the read-side check is what makes the
 * TTL exact).
 */
import type { Collection, Db } from 'mongodb';
import type { AnswerStore } from './answer-cache.js';
import type { QuestionAnswer } from '../question/question.schema.js';

export const ANSWER_CACHE_COLLECTION = 'answer_cache';

interface CacheDocument {
  _id: string;
  answer: QuestionAnswer;
  expiresAt: Date;
}

export interface MongoAnswerStoreOptions {
  ttlMs: number;
  now?: () => number;
}

export class MongoAnswerStore implements AnswerStore {
  private readonly collection: Collection<CacheDocument>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(db: Db, options: MongoAnswerStoreOptions) {
    this.collection = db.collection<CacheDocument>(ANSWER_CACHE_COLLECTION);
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  /** Idempotent; safe to run on every startup. */
  async init(): Promise<void> {
    await this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  async get(key: string): Promise<QuestionAnswer | undefined> {
    const doc = await this.collection.findOne({ _id: key, expiresAt: { $gt: new Date(this.now()) } });
    return doc?.answer;
  }

  async set(key: string, answer: QuestionAnswer): Promise<void> {
    await this.collection.replaceOne(
      { _id: key },
      { answer, expiresAt: new Date(this.now() + this.ttlMs) },
      { upsert: true },
    );
  }

  async clear(): Promise<void> {
    await this.collection.deleteMany({});
  }
}
