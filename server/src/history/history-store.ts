/**
 * Server-side question history and usage statistics.
 *
 * What is kept is deliberately narrower than what the extension sends: the
 * question, its options and the answer - never the surrounding page context,
 * and only the origin of the page, not its full URL or title.
 */
import { ObjectId } from 'mongodb';
import type { Collection, Db } from 'mongodb';
import type { QuestionAnswer, QuestionRequest, QuestionType } from '../question/question.schema.js';

export const HISTORY_COLLECTION = 'question_history';

export interface HistoryInput {
  request: QuestionRequest;
  answer: QuestionAnswer;
  cached: boolean;
  latencyMs: number;
}

export interface HistoryEntry {
  id: string;
  createdAt: string;
  question: string;
  type: QuestionType;
  options?: string[];
  answer: string;
  explanation: string;
  confidence?: number;
  provider: string;
  model: string;
  cached: boolean;
  latencyMs: number;
  origin?: string;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Pass back as `before` for the next page; absent on the last one. */
  nextBefore?: string;
}

export interface UsageStats {
  total: number;
  today: number;
  cached: number;
  averageLatencyMs: number;
  byProvider: Array<{ provider: string; model: string; count: number }>;
  byType: Array<{ type: string; count: number }>;
  topOrigins: Array<{ origin: string; count: number }>;
}

export interface ListOptions {
  limit: number;
  before?: Date;
}

export interface HistoryStore {
  readonly enabled: boolean;
  record: (input: HistoryInput) => Promise<void>;
  list: (options: ListOptions) => Promise<HistoryPage>;
  stats: () => Promise<UsageStats>;
  clear: () => Promise<number>;
}

interface HistoryDocument {
  _id: ObjectId;
  createdAt: Date;
  question: string;
  type: QuestionType;
  options?: string[];
  answer: string;
  explanation: string;
  confidence?: number;
  provider: string;
  model: string;
  cached: boolean;
  latencyMs: number;
  origin?: string;
}

export interface MongoHistoryStoreOptions {
  retentionDays: number;
  now?: () => number;
}

export class MongoHistoryStore implements HistoryStore {
  readonly enabled = true;
  private readonly collection: Collection<HistoryDocument>;
  private readonly retentionSeconds: number;
  private readonly now: () => number;

  constructor(db: Db, options: MongoHistoryStoreOptions) {
    this.collection = db.collection<HistoryDocument>(HISTORY_COLLECTION);
    this.retentionSeconds = options.retentionDays * 86_400;
    this.now = options.now ?? Date.now;
  }

  /** Idempotent; also brings an existing TTL index in line with the setting. */
  async init(): Promise<void> {
    const indexes = await this.collection.indexes().catch(() => []);
    const ttl = indexes.find((index) => index.name === 'createdAt_ttl');
    if (ttl && ttl.expireAfterSeconds !== this.retentionSeconds) {
      await this.collection.db.command({
        collMod: HISTORY_COLLECTION,
        index: { name: 'createdAt_ttl', expireAfterSeconds: this.retentionSeconds },
      });
    } else if (!ttl) {
      await this.collection.createIndex(
        { createdAt: 1 },
        { name: 'createdAt_ttl', expireAfterSeconds: this.retentionSeconds },
      );
    }
  }

  async record({ request, answer, cached, latencyMs }: HistoryInput): Promise<void> {
    const doc: HistoryDocument = {
      _id: new ObjectId(),
      createdAt: new Date(this.now()),
      question: request.question,
      type: request.type,
      answer: answer.answer,
      explanation: answer.explanation,
      provider: answer.provider,
      model: answer.model,
      cached,
      latencyMs: Math.round(latencyMs),
    };
    if (request.options) doc.options = request.options;
    if (answer.confidence !== undefined) doc.confidence = answer.confidence;
    const origin = originOf(request.source?.url);
    if (origin) doc.origin = origin;

    await this.collection.insertOne(doc);
  }

  async list({ limit, before }: ListOptions): Promise<HistoryPage> {
    const filter = before ? { createdAt: { $lt: before } } : {};
    const docs = await this.collection
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();

    const page = docs.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map(toEntry),
      ...(docs.length > limit && last ? { nextBefore: last.createdAt.toISOString() } : {}),
    };
  }

  async stats(): Promise<UsageStats> {
    const startOfDay = new Date(this.now());
    startOfDay.setUTCHours(0, 0, 0, 0);

    const [result] = await this.collection
      .aggregate<{
        totals: Array<{ total: number; cached: number; averageLatencyMs: number | null }>;
        today: Array<{ count: number }>;
        byProvider: Array<{ _id: { provider: string; model: string }; count: number }>;
        byType: Array<{ _id: string; count: number }>;
        topOrigins: Array<{ _id: string; count: number }>;
      }>([
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  cached: { $sum: { $cond: ['$cached', 1, 0] } },
                  averageLatencyMs: { $avg: '$latencyMs' },
                },
              },
            ],
            today: [{ $match: { createdAt: { $gte: startOfDay } } }, { $count: 'count' }],
            byProvider: [
              { $group: { _id: { provider: '$provider', model: '$model' }, count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
            byType: [{ $group: { _id: '$type', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
            topOrigins: [
              { $match: { origin: { $exists: true } } },
              { $group: { _id: '$origin', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 10 },
            ],
          },
        },
      ])
      .toArray();

    const totals = result?.totals[0];
    return {
      total: totals?.total ?? 0,
      today: result?.today[0]?.count ?? 0,
      cached: totals?.cached ?? 0,
      averageLatencyMs: Math.round(totals?.averageLatencyMs ?? 0),
      byProvider: (result?.byProvider ?? []).map(({ _id, count }) => ({ ..._id, count })),
      byType: (result?.byType ?? []).map(({ _id, count }) => ({ type: _id, count })),
      topOrigins: (result?.topOrigins ?? []).map(({ _id, count }) => ({ origin: _id, count })),
    };
  }

  async clear(): Promise<number> {
    const { deletedCount } = await this.collection.deleteMany({});
    return deletedCount;
  }
}

/** Used when MongoDB is not configured or history is switched off. */
export class NullHistoryStore implements HistoryStore {
  readonly enabled = false;

  record(): Promise<void> {
    return Promise.resolve();
  }

  list(): Promise<HistoryPage> {
    return Promise.resolve({ entries: [] });
  }

  stats(): Promise<UsageStats> {
    return Promise.resolve({
      total: 0,
      today: 0,
      cached: 0,
      averageLatencyMs: 0,
      byProvider: [],
      byType: [],
      topOrigins: [],
    });
  }

  clear(): Promise<number> {
    return Promise.resolve(0);
  }
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function toEntry(doc: HistoryDocument): HistoryEntry {
  const { _id, createdAt, ...rest } = doc;
  return { id: _id.toHexString(), createdAt: createdAt.toISOString(), ...rest };
}
