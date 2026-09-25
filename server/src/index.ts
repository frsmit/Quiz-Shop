/**
 * Server entry point: configuration, startup and graceful shutdown.
 */
import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { getLogger } from './config/logger.js';
import { ProviderFactory } from './providers/provider.factory.js';
import { createPersistence } from './db/persistence.js';

async function main(): Promise<void> {
  const env = getEnv();
  const log = getLogger();
  const factory = new ProviderFactory(env);

  const configured = factory.configured();
  if (configured.length === 0) {
    log.warn(
      'No AI provider credentials found. Requests will fail until one is configured in .env - see .env.example.',
    );
  } else if (!configured.includes(env.AI_PROVIDER)) {
    log.warn(
      { active: env.AI_PROVIDER, configured },
      'The active provider has no credentials; requests will fail unless the client overrides the provider.',
    );
  }

  // A MONGODB_URI that is set but unreachable stops startup: silently
  // falling back to memory would lose history without anyone noticing.
  const persistence = await createPersistence(env).catch((error: unknown) => {
    throw new Error(
      `Could not connect to MongoDB (MONGODB_URI): ${error instanceof Error ? error.message : String(error)}
` +
        'Check the URI and credentials, and for Atlas that this machine is on the Network Access list. ' +
        'Unset MONGODB_URI to run without persistence.',
    );
  });

  const server = createApp({
    env,
    factory,
    store: persistence.store,
    history: persistence.history,
    persistence: persistence.status,
  }).listen(env.PORT, env.HOST, () => {
    log.info(
      {
        url: `http://${env.HOST}:${env.PORT}`,
        provider: env.AI_PROVIDER,
        configured,
        cache: persistence.status.cache,
        history: persistence.status.history,
        database: persistence.database?.db.databaseName,
      },
      'Backend listening',
    );
  });

  const shutdown = (signal: string) => {
    log.info({ signal }, 'Shutting down');
    server.close((error) => {
      if (error) log.error({ err: error }, 'Error while closing the server');
      persistence
        .close()
        .catch((closeError: unknown) => log.error({ err: closeError }, 'Error closing MongoDB'))
        .finally(() => process.exit(error ? 1 : 0));
    });
    // Do not let a hung connection block the exit indefinitely.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // Configuration errors happen before the logger exists.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
