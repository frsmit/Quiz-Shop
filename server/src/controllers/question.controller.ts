/**
 * `POST /api/questions/answer` and `POST /api/providers/test`
 *
 * Validates the request, hands it to the question service, and validates the
 * result again on the way out so a provider can never widen the contract.
 */
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import {
  providerIdSchema,
  questionAnswerSchema,
  questionRequestSchema,
} from '../question/question.schema.js';
import type { QuestionService } from '../question/question.service.js';
import type { ClientCredentials } from '../providers/ai-provider.interface.js';
import { getLogger } from '../config/logger.js';
import { ProviderError } from '../providers/provider.errors.js';
import { HttpError } from '../middleware/error-handler.js';

const probeRequestSchema = z.object({
  provider: providerIdSchema.optional(),
  model: z.string().trim().min(1).max(120).optional(),
});

export function answerQuestionHandler(service: QuestionService): RequestHandler {
  return async (req: Request, res: Response) => {
    const request = questionRequestSchema.parse(req.body);
    const credentials = clientCredentials(req);

    // Log the shape, never the content: questions and page context are the
    // user's data and have no business in the server log.
    getLogger().info(
      {
        type: request.type,
        options: request.options?.length ?? 0,
        multiSelect: request.multiSelect ?? false,
        contextChars: request.context?.length ?? 0,
        provider: request.provider,
        ownKey: credentials !== undefined,
      },
      'Answering question',
    );

    const { answer, cached } = await service.answer(request, abortOnClose(res), credentials);

    // Validate on the way out too. A provider that breaks the contract is a
    // provider failure (502), not a client error - so it is not left to the
    // ZodError branch of the error handler, which would report 400.
    const validated = questionAnswerSchema.safeParse(answer);
    if (!validated.success) {
      throw new ProviderError(
        'invalid_response',
        answer?.provider ?? 'unknown',
        'The provider returned an answer that did not match the API contract.',
      );
    }

    res.status(200).json({ data: validated.data, meta: { cached } });
  };
}

/** Try a provider, model and key with one tiny question. */
export function testProviderHandler(service: QuestionService): RequestHandler {
  return async (req: Request, res: Response) => {
    const target = probeRequestSchema.parse(req.body ?? {});
    const credentials = clientCredentials(req);
    getLogger().info(
      { provider: target.provider, ownKey: credentials !== undefined },
      'Testing provider',
    );
    const result = await service.probe(target, abortOnClose(res), credentials);
    res.status(200).json({ data: result });
  };
}

export function clearCacheHandler(service: QuestionService): RequestHandler {
  return async (_req, res) => {
    await service.clearCache();
    res.status(200).json({ data: { cleared: true } });
  };
}

/**
 * The caller's own provider key, sent as `x-ai-api-key` (plus
 * `x-ai-base-url` for an OpenAI-compatible endpoint). Headers rather than
 * body fields, so the key is never part of the validated request object that
 * gets logged, cached or recorded in history.
 */
function clientCredentials(req: Request): ClientCredentials | undefined {
  const apiKey = req.get('x-ai-api-key')?.trim();
  if (!apiKey) return undefined;
  if (apiKey.length > 512) {
    throw new HttpError(400, 'invalid_request', 'The x-ai-api-key header is too long.');
  }
  const baseUrl = req.get('x-ai-base-url')?.trim();
  if (baseUrl && baseUrl.length > 2000) {
    throw new HttpError(400, 'invalid_request', 'The x-ai-base-url header is too long.');
  }
  return { apiKey, ...(baseUrl ? { baseUrl } : {}) };
}

/** Abort the provider call if the client hangs up. */
function abortOnClose(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
