/**
 * Server entry point: configuration, startup and graceful shutdown.
 */
import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { getLogger } from './config/logger.js';
import { ProviderFactory } from './providers/provider.factory.js';

function main(): void {
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

  const server = createApp({ env, factory }).listen(env.PORT, env.HOST, () => {
    log.info(
      { url: `http://${env.HOST}:${env.PORT}`, provider: env.AI_PROVIDER, configured },
      'Backend listening',
    );
  });

  const shutdown = (signal: string) => {
    log.info({ signal }, 'Shutting down');
    server.close((error) => {
      if (error) log.error({ err: error }, 'Error while closing the server');
      process.exit(error ? 1 : 0);
    });
    // Do not let a hung connection block the exit indefinitely.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (error) {
  // Configuration errors happen before the logger exists.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
