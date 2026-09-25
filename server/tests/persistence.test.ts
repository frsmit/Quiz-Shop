/**
 * MongoDB persistence, against a real `mongod` started by
 * mongodb-memory-server - no network, no Atlas, nothing left behind.
 */
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { connectDatabase, dbNameFromUri } from '../src/db/mongo.js';
import type { Database } from '../src/db/mongo.js';
import { createPersistence } from '../src/db/persistence.js';
import type { Persistence } from '../src/db/persistence.js';
import { MongoAnswerStore, ANSWER_CACHE_COLLECTION } from '../src/cache/mongo-answer-store.js';
import { HISTORY_COLLECTION, MongoHistoryStore } from '../src/history/history-store.js';
import { StubProvider, StubRegistry, VALID_QUESTION, answerFor, testEnv } from './helpers.js';
import type { QuestionRequest } from '../src/question/question.schema.js';

let mongod: MongoMemoryServer;
let database: Database;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  database = await connectDatabase(mongod.getUri(), { dbName: 'quiz-shop-test' });
}, 300_000);

afterAll(async () => {
  await database?.close();
  await mongod?.stop();
});

beforeEach(async () => {
  await database.db.dropDatabase();
});

const REQUEST: QuestionRequest = { ...VALID_QUESTION, type: 'multiple_choice' };

/** Resolves once fire-and-forget history writes have landed. */
async function waitForHistory(count: number): Promise<void> {
  const collection = database.db.collection(HISTORY_COLLECTION);
  for (let i = 0; i < 50; i += 1) {
    if ((await collection.countDocuments()) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`history never reached ${count} entries`);
}

async function mongoApp(
  provider = new StubProvider(),
  overrides: Record<string, string> = {},
): Promise<{ app: ReturnType<typeof createApp>; persistence: Persistence }> {
  const env = testEnv({ CACHE_ENABLED: 'true', ...overrides });
  const persistence = await createPersistence(env, database);
  const app = createApp({
    env,
    factory: new StubRegistry(provider),
    store: persistence.store,
    history: persistence.history,
    persistence: persistence.status,
  });
  return { app, persistence };
}

describe('dbNameFromUri', () => {
  it('reads the database from the URI path', () => {
    expect(dbNameFromUri('mongodb+srv://u:p@cluster0.example.net/quiz-shop?retryWrites=true')).toBe(
      'quiz-shop',
    );
    expect(dbNameFromUri('mongodb://localhost:27017/other')).toBe('other');
  });

  it('falls back when the URI names no database', () => {
    expect(dbNameFromUri('mongodb://localhost:27017')).toBe('quiz-shop');
    expect(dbNameFromUri('mongodb://localhost:27017/?replicaSet=rs0')).toBe('quiz-shop');
  });
});

describe('MongoAnswerStore', () => {
  it('round-trips an answer and clears', async () => {
    const store = new MongoAnswerStore(database.db, { ttlMs: 60_000 });
    await store.init();
    const answer = answerFor(REQUEST);

    await store.set('k1', answer);
    expect(await store.get('k1')).toEqual(answer);

    await store.clear();
    expect(await store.get('k1')).toBeUndefined();
  });

  it('ignores expired entries before the TTL monitor removes them', async () => {
    let now = 1_000_000;
    const store = new MongoAnswerStore(database.db, { ttlMs: 1_000, now: () => now });
    await store.set('k1', answerFor(REQUEST));

    now += 999;
    expect(await store.get('k1')).toBeDefined();
    now += 2;
    expect(await store.get('k1')).toBeUndefined();
  });

  it('creates a TTL index on expiresAt', async () => {
    await new MongoAnswerStore(database.db, { ttlMs: 1_000 }).init();
    const indexes = await database.db.collection(ANSWER_CACHE_COLLECTION).indexes();
    expect(indexes.find((index) => index.key.expiresAt === 1)?.expireAfterSeconds).toBe(0);
  });
});

describe('MongoHistoryStore', () => {
  it('stores the question and answer but not the page context or full URL', async () => {
    const history = new MongoHistoryStore(database.db, { retentionDays: 30 });
    await history.init();

    await history.record({
      request: {
        ...REQUEST,
        context: 'SECRET PAGE CONTEXT',
        source: { url: 'https://quiz.example.com/course/42?token=abc', title: 'Private title' },
      },
      answer: answerFor(REQUEST),
      cached: false,
      latencyMs: 123.4,
    });

    const [raw] = await database.db.collection(HISTORY_COLLECTION).find().toArray();
    expect(raw).toMatchObject({
      question: REQUEST.question,
      options: REQUEST.options,
      answer: 'O(log n)',
      origin: 'https://quiz.example.com',
      latencyMs: 123,
      cached: false,
    });
    expect(JSON.stringify(raw)).not.toMatch(/SECRET|token=abc|Private title/);
  });

  it('pages newest first', async () => {
    let now = Date.UTC(2026, 0, 1);
    const history = new MongoHistoryStore(database.db, { retentionDays: 30, now: () => now });
    for (let i = 0; i < 5; i += 1) {
      now += 1_000;
      await history.record({
        request: { ...REQUEST, question: `Question number ${i}` },
        answer: answerFor(REQUEST),
        cached: false,
        latencyMs: 10,
      });
    }

    const first = await history.list({ limit: 2 });
    expect(first.entries.map((e) => e.question)).toEqual(['Question number 4', 'Question number 3']);
    expect(first.nextBefore).toBeDefined();

    const second = await history.list({ limit: 2, before: new Date(first.nextBefore!) });
    expect(second.entries.map((e) => e.question)).toEqual(['Question number 2', 'Question number 1']);

    const last = await history.list({ limit: 2, before: new Date(second.nextBefore!) });
    expect(last.entries.map((e) => e.question)).toEqual(['Question number 0']);
    expect(last.nextBefore).toBeUndefined();
  });

  it('keeps the retention TTL index in step with the setting', async () => {
    await new MongoHistoryStore(database.db, { retentionDays: 30 }).init();
    await new MongoHistoryStore(database.db, { retentionDays: 7 }).init();

    const indexes = await database.db.collection(HISTORY_COLLECTION).indexes();
    expect(indexes.find((index) => index.name === 'createdAt_ttl')?.expireAfterSeconds).toBe(7 * 86_400);
  });
});

describe('API with MongoDB', () => {
  it('serves a repeat question from the MongoDB cache, surviving an app restart', async () => {
    const provider = new StubProvider();
    const first = await mongoApp(provider);
    await request(first.app).post('/api/questions/answer').send(VALID_QUESTION).expect(200);

    // A fresh app over the same database stands in for a redeploy.
    const second = await mongoApp(provider);
    const response = await request(second.app)
      .post('/api/questions/answer')
      .send(VALID_QUESTION)
      .expect(200);

    expect(response.body.meta.cached).toBe(true);
    expect(provider.calls).toBe(1);
  });

  it('records history and reports usage stats', async () => {
    const { app } = await mongoApp();
    await request(app)
      .post('/api/questions/answer')
      .send({ ...VALID_QUESTION, source: { url: 'https://a.example.com/q/1' } })
      .expect(200);
    await request(app)
      .post('/api/questions/answer')
      .send({ ...VALID_QUESTION, source: { url: 'https://a.example.com/q/2' } })
      .expect(200);
    await waitForHistory(2);

    const history = await request(app).get('/api/history?limit=10').expect(200);
    expect(history.body.meta.enabled).toBe(true);
    expect(history.body.data.entries).toHaveLength(2);
    expect(history.body.data.entries[0]).toMatchObject({ answer: 'O(log n)', origin: 'https://a.example.com' });

    const stats = await request(app).get('/api/stats').expect(200);
    expect(stats.body.data).toMatchObject({
      total: 2,
      today: 2,
      cached: 1,
      byType: [{ type: 'multiple_choice', count: 2 }],
      topOrigins: [{ origin: 'https://a.example.com', count: 2 }],
    });
  });

  it('clears history', async () => {
    const { app } = await mongoApp();
    await request(app).post('/api/questions/answer').send(VALID_QUESTION).expect(200);
    await waitForHistory(1);

    const cleared = await request(app).post('/api/history/clear').expect(200);
    expect(cleared.body.data.deleted).toBe(1);
    const history = await request(app).get('/api/history').expect(200);
    expect(history.body.data.entries).toHaveLength(0);
  });

  it('rejects a malformed history query', async () => {
    const { app } = await mongoApp();
    await request(app).get('/api/history?limit=0').expect(400);
    await request(app).get('/api/history?before=yesterday').expect(400);
  });

  it('keeps no history when HISTORY_ENABLED is false', async () => {
    const { app } = await mongoApp(new StubProvider(), { HISTORY_ENABLED: 'false' });
    await request(app).post('/api/questions/answer').send(VALID_QUESTION).expect(200);

    const history = await request(app).get('/api/history').expect(200);
    expect(history.body.meta.enabled).toBe(false);
    expect(await database.db.collection(HISTORY_COLLECTION).countDocuments()).toBe(0);
  });

  it('reports the database on the health endpoint without revealing where it is', async () => {
    const { app } = await mongoApp();
    const response = await request(app).get('/api/health').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.persistence).toEqual({ database: 'connected', cache: 'mongodb', history: true });
    expect(JSON.stringify(response.body)).not.toMatch(/mongodb:\/\/|127\.0\.0\.1/);
  });

  it('still answers when the cache is unreachable', async () => {
    const provider = new StubProvider();
    const env = testEnv({ CACHE_ENABLED: 'true' });
    const broken = {
      get: () => Promise.reject(new Error('connection reset')),
      set: () => Promise.reject(new Error('connection reset')),
      clear: () => Promise.resolve(),
    };
    const app = createApp({ env, factory: new StubRegistry(provider), store: broken });

    const response = await request(app).post('/api/questions/answer').send(VALID_QUESTION).expect(200);
    expect(response.body.data.answer).toBe('O(log n)');
  });
});

describe('API without MongoDB', () => {
  it('reports persistence as not configured and history as disabled', async () => {
    const app = createApp({ env: testEnv({ CACHE_ENABLED: 'true' }), factory: new StubRegistry() });

    const health = await request(app).get('/api/health').expect(200);
    expect(health.body.persistence).toEqual({ database: 'not_configured', cache: 'memory', history: false });

    const history = await request(app).get('/api/history').expect(200);
    expect(history.body).toEqual({ data: { entries: [] }, meta: { enabled: false } });
  });

  it('requires the API key on history endpoints when one is set', async () => {
    const app = createApp({
      env: testEnv({ API_ACCESS_KEY: 'secret-key' }),
      factory: new StubRegistry(),
    });
    await request(app).get('/api/history').expect(401);
    await request(app).get('/api/stats').expect(401);
    await request(app).post('/api/history/clear').expect(401);
    await request(app).get('/api/history').set('x-api-key', 'secret-key').expect(200);
  });
});
