/**
 * OpenAI adapter.
 *
 * Uses the Chat Completions endpoint with a strict JSON schema, so the model
 * is constrained to the answer contract rather than asked politely to follow
 * it.
 */
import OpenAI from 'openai';
import type { AIProvider, ProviderContext } from './ai-provider.interface.js';
import { ProviderError, codeForStatus, isAbort, messageOf, statusOf } from './provider.errors.js';
import { parseAnswerText, withDeadline } from './provider.utils.js';
import { ANSWER_JSON_SCHEMA } from '../question/question.schema.js';
import type { QuestionAnswer, QuestionRequest } from '../question/question.schema.js';
import { SYSTEM_PROMPT, buildUserPrompt } from '../question/question.prompt.js';

export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

export class OpenAIProvider implements AIProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, context: ProviderContext) {
    this.client = new OpenAI({ apiKey, maxRetries: 1 });
    this.model = context.model?.trim() || OPENAI_DEFAULT_MODEL;
    this.timeoutMs = context.timeoutMs;
  }

  getName(): string {
    return 'openai';
  }

  getModel(): string {
    return this.model;
  }

  async answerQuestion(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionAnswer> {
    const deadline = withDeadline(this.timeoutMs, signal);

    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(request) },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'question_answer',
              strict: true,
              schema: ANSWER_JSON_SCHEMA as unknown as Record<string, unknown>,
            },
          },
        },
        { signal: deadline.signal },
      );

      const choice = completion.choices[0];
      if (choice?.finish_reason === 'length') {
        throw new ProviderError(
          'invalid_response',
          this.getName(),
          'The model stopped before finishing its answer.',
        );
      }

      const answer = parseAnswerText(choice?.message?.content, this.getName());
      return { ...answer, provider: this.getName(), model: completion.model || this.model };
    } catch (error) {
      throw this.translate(error, deadline.timedOut());
    } finally {
      deadline.dispose();
    }
  }

  private translate(error: unknown, timedOut: boolean): ProviderError {
    if (error instanceof ProviderError) return error;

    if (timedOut || isAbort(error)) {
      return new ProviderError(
        'timeout',
        this.getName(),
        `OpenAI did not respond within ${this.timeoutMs}ms.`,
        { cause: error },
      );
    }

    if (error instanceof OpenAI.APIConnectionError) {
      return new ProviderError('unavailable', this.getName(), 'Could not reach OpenAI.', {
        cause: error,
      });
    }

    if (error instanceof OpenAI.APIError) {
      return new ProviderError(
        codeForStatus(statusOf(error)),
        this.getName(),
        messageOf(error, 'OpenAI rejected the request.'),
        { cause: error },
      );
    }

    return new ProviderError('unknown', this.getName(), messageOf(error, 'OpenAI request failed.'), {
      cause: error,
    });
  }
}
