/**
 * Express application factory.
 *
 * Kept free of side effects and of `process.exit`, so tests can build an app
 * with whatever environment and dependencies they need.
 */
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { getEnv } from './config/env.js';
import type { Env } from './config/env.js';
import { getLogger } from './config/logger.js';
import type { AnswerStore } from './cache/answer-cache.js';
import type { HistoryStore } from './history/history-store.js';
import { memoryPersistence } from './db/persistence.js';
import { ProviderFactory } from './providers/provider.factory.js';
import type { ProviderRegistry } from './providers/provider.factory.js';
import { QuestionService } from './question/question.service.js';
import { answerQuestionHandler, clearCacheHandler } from './controllers/question.controller.js';
import { healthHandler } from './controllers/health.controller.js';
import type { PersistenceStatus } from './controllers/health.controller.js';
import {
  clearHistoryHandler,
  listHistoryHandler,
  statsHandler,
} from './controllers/history.controller.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { buildAuth, buildCors, buildRateLimit } from './middleware/security.js';

export interface AppDependencies {
  env?: Env;
  store?: AnswerStore;
  history?: HistoryStore;
  /** What the health endpoint reports about persistence. */
  persistence?: PersistenceStatus;
  factory?: ProviderRegistry;
}

export function createApp(dependencies: AppDependencies = {}): Express {
  const env = dependencies.env ?? getEnv();
  const factory = dependencies.factory ?? new ProviderFactory(env);
  // Connecting to MongoDB is asynchronous, so it happens in the entry point
  // and arrives here as dependencies; without them the app runs in memory.
  const fallback = memoryPersistence(env);
  const store = dependencies.store ?? fallback.store;
  const history = dependencies.history ?? fallback.history;
  const persistence = dependencies.persistence ?? {
    ...fallback.status,
    history: history.enabled,
  };

  const service = new QuestionService(factory, store, {
    maxAttempts: env.PROVIDER_MAX_ATTEMPTS,
    baseRetryDelayMs: env.PROVIDER_RETRY_BASE_MS,
    history,
  });
  const app = express();

  // Behind a single reverse proxy in the Docker setup; needed for the rate
  // limiter to see the real client address.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON only, so the browser-facing policies that matter
      // are the ones that stop it being embedded or sniffed.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  if (env.NODE_ENV !== 'test') {
    app.use(pinoHttp({ logger: getLogger() }));
  }

  app.use(buildCors(env));
  app.use(express.json({ limit: env.MAX_REQUEST_BODY }));

  app.get('/api/health', healthHandler(factory, persistence));

  const api = express.Router();
  api.use(buildAuth(env));
  api.use(buildRateLimit(env));
  api.post('/questions/answer', answerQuestionHandler(service));
  api.post('/cache/clear', clearCacheHandler(service));
  api.get('/history', listHistoryHandler(history));
  api.get('/stats', statsHandler(history));
  api.post('/history/clear', clearHistoryHandler(history));
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
