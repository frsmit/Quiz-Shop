/**
 * The single place an error becomes an HTTP response.
 *
 * Clients get a stable `{ error: { code, message } }` envelope. Provider
 * messages are safe to forward - they describe the failure, not the
 * credentials - but stack traces and causes stay in the log.
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ProviderError } from '../providers/provider.errors.js';
import { getLogger } from '../config/logger.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}.` },
  });
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const log = getLogger();

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'The request body did not match the expected shape.',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (error instanceof ProviderError) {
    log.warn(
      { provider: error.provider, code: error.code, status: error.status },
      'Provider request failed',
    );
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        provider: error.provider,
        retryable: error.retryable,
      },
    });
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }

  // `entity.too.large` from body-parser, and malformed JSON.
  const status = (error as { status?: number; statusCode?: number })?.status;
  if (status === 413) {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large.' } });
    return;
  }
  if (status === 400) {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON.' } });
    return;
  }

  log.error({ err: error }, 'Unhandled error');
  res.status(500).json({
    error: { code: 'internal_error', message: 'The server could not handle the request.' },
  });
};
