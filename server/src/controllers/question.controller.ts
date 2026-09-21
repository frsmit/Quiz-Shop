/**
 * `POST /api/questions/answer`
 *
 * Validates the request, hands it to the question service, and validates the
 * result again on the way out so a provider can never widen the contract.
 */
import type { Request, RequestHandler, Response } from 'express';
import { questionAnswerSchema, questionRequestSchema } from '../question/question.schema.js';
import type { QuestionService } from '../question/question.service.js';
import { getLogger } from '../config/logger.js';
import { ProviderError } from '../providers/provider.errors.js';

export function answerQuestionHandler(service: QuestionService): RequestHandler {
  return async (req: Request, res: Response) => {
    const request = questionRequestSchema.parse(req.body);

    // Log the shape, never the content: questions and page context are the
    // user's data and have no business in the server log.
    getLogger().info(
      {
        type: request.type,
        options: request.options?.length ?? 0,
        contextChars: request.context?.length ?? 0,
        provider: request.provider,
      },
      'Answering question',
    );

    // Abort the provider call if the client hangs up.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const { answer, cached } = await service.answer(request, controller.signal);

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

export function clearCacheHandler(service: QuestionService): RequestHandler {
  return async (_req, res) => {
    await service.clearCache();
    res.status(200).json({ data: { cleared: true } });
  };
}
