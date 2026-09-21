/**
 * CORS, authentication and rate limiting.
 */
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import type { CorsOptions } from 'cors';
import type { RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../config/env.js';
import { HttpError } from './error-handler.js';

/**
 * Origin matching with a single trailing wildcard, so a whole scheme can be
 * allowed (`chrome-extension://*`) without listing every extension id - the
 * id changes each time an unpacked extension is reloaded during development.
 */
export function originMatches(origin: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return origin.startsWith(pattern.slice(0, -1));
  return origin === pattern;
}

export function buildCors(env: Env): RequestHandler {
  const allowed = env.CORS_ALLOWED_ORIGINS;

  const options: CorsOptions = {
    origin(origin, callback) {
      // Same-origin and non-browser callers (curl, tests) send no Origin.
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowed.some((pattern) => originMatches(origin, pattern))) {
        callback(null, true);
        return;
      }
      callback(new HttpError(403, 'origin_not_allowed', `Origin ${origin} is not allowed.`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
    maxAge: 600,
  };

  return cors(options);
}

/**
 * Require the shared secret when one is configured.
 * Compared in constant time so the endpoint cannot be used as an oracle.
 */
export function buildAuth(env: Env): RequestHandler {
  const expected = env.API_ACCESS_KEY;

  return (req, _res, next) => {
    if (!expected) {
      next();
      return;
    }

    const provided = req.get('x-api-key') ?? '';
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);

    const ok =
      expectedBuffer.length === providedBuffer.length &&
      timingSafeEqual(expectedBuffer, providedBuffer);

    next(ok ? undefined : new HttpError(401, 'unauthorized', 'A valid x-api-key is required.'));
  };
}

export function buildRateLimit(env: Env): RequestHandler {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: {
        code: 'rate_limited',
        message: 'Too many requests. Slow down and try again shortly.',
      },
    },
  });
}
