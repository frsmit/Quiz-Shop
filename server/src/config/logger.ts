/**
 * Structured logging.
 *
 * Question text and page context are user content, so they are never logged;
 * only shapes and sizes are. Credentials are redacted at the serialiser level
 * so an accidental `log.info({ headers })` cannot leak one.
 */
import { pino } from 'pino';
import type { Logger } from 'pino';
import { getEnv } from './env.js';

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  '*.apiKey',
  '*.api_key',
];

let cached: Logger | null = null;

export function getLogger(): Logger {
  if (cached) return cached;
  const env = getEnv();

  cached = pino({
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });

  return cached;
}
