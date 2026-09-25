/**
 * Chooses the answer cache and history store from the environment.
 *
 * | MONGODB_URI | CACHE_ENABLED | HISTORY_ENABLED | cache   | history |
 * |-------------|---------------|-----------------|---------|---------|
 * | unset       | true          | (ignored)       | memory  | off     |
 * | set         | true          | true            | mongodb | on      |
 * | set         | false         | true            | off     | on      |
 * | any         | false         | false           | off     | off     |
 */
import type { Env } from '../config/env.js';
import type { AnswerStore } from '../cache/answer-cache.js';
import { InMemoryAnswerStore, NullAnswerStore } from '../cache/answer-cache.js';
import { MongoAnswerStore } from '../cache/mongo-answer-store.js';
import type { HistoryStore } from '../history/history-store.js';
import { MongoHistoryStore, NullHistoryStore } from '../history/history-store.js';
import type { PersistenceStatus } from '../controllers/health.controller.js';
import { connectDatabase } from './mongo.js';
import type { Database } from './mongo.js';

export interface Persistence {
  store: AnswerStore;
  history: HistoryStore;
  status: PersistenceStatus;
  database?: Database;
  close: () => Promise<void>;
}

/** Without MongoDB: the in-memory behaviour of the first version. */
export function memoryPersistence(env: Env): Persistence {
  const store: AnswerStore = env.CACHE_ENABLED
    ? new InMemoryAnswerStore({ ttlMs: env.CACHE_TTL_MS, maxEntries: env.CACHE_MAX_ENTRIES })
    : new NullAnswerStore();

  return {
    store,
    history: new NullHistoryStore(),
    status: { cache: env.CACHE_ENABLED ? 'memory' : 'off', history: false },
    close: () => Promise.resolve(),
  };
}

/** Connects when `MONGODB_URI` is set; throws if it is set but unreachable. */
export async function createPersistence(env: Env, database?: Database): Promise<Persistence> {
  if (!env.MONGODB_URI && !database) return memoryPersistence(env);

  const connected =
    database ?? (await connectDatabase(env.MONGODB_URI ?? '', {
      dbName: env.MONGODB_DB,
      dnsServers: env.MONGODB_DNS_SERVERS,
    }));

  let store: AnswerStore = new NullAnswerStore();
  if (env.CACHE_ENABLED) {
    const mongoStore = new MongoAnswerStore(connected.db, { ttlMs: env.CACHE_TTL_MS });
    await mongoStore.init();
    store = mongoStore;
  }

  let history: HistoryStore = new NullHistoryStore();
  if (env.HISTORY_ENABLED) {
    const mongoHistory = new MongoHistoryStore(connected.db, {
      retentionDays: env.HISTORY_RETENTION_DAYS,
    });
    await mongoHistory.init();
    history = mongoHistory;
  }

  return {
    store,
    history,
    database: connected,
    status: {
      cache: env.CACHE_ENABLED ? 'mongodb' : 'off',
      history: history.enabled,
      ping: connected.ping,
    },
    close: connected.close,
  };
}
