/**
 * Anthropic Claude adapter.
 *
 * Uses structured outputs (`messages.parse` with `output_config.format`), so
 * the SDK validates the reply against the same Zod schema the rest of the
 * server uses and hands back a typed object.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { AIProvider, ProviderContext } from './ai-provider.interface.js';
import { ProviderError, codeForStatus, isAbort, messageOf, statusOf } from './provider.errors.js';
import { validateAnswer, withDeadline } from './provider.utils.js';
import { providerAnswerSchema } from '../question/question.schema.js';
import type { QuestionAnswer, QuestionRequest } from '../question/question.schema.js';
import { SYSTEM_PROMPT, buildUserPrompt } from '../question/question.prompt.js';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5';

/** Comfortably above any answer this contract allows, and below the cap that
 *  would require streaming. */
const MAX_TOKENS = 16_000;

export class AnthropicProvider implements AIProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, context: ProviderContext) {
    this.client = new Anthropic({ apiKey, maxRetries: 1 });
    this.model = context.model?.trim() || ANTHROPIC_DEFAULT_MODEL;
    this.timeoutMs = context.timeoutMs;
  }

  getName(): string {
    return 'anthropic';
  }

  getModel(): string {
    return this.model;
  }

  async answerQuestion(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionAnswer> {
    const deadline = withDeadline(this.timeoutMs, signal);

    try {
      // Thinking is left at its default: on for current Claude models, which
      // is what the harder maths and code questions want.
      const message = await this.client.messages.parse(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildUserPrompt(request) }],
          output_config: { format: zodOutputFormat(providerAnswerSchema) },
        },
        { signal: deadline.signal },
      );

      // A safety classifier can decline with HTTP 200, so the stop reason is
      // checked before the content is read.
      if (message.stop_reason === 'refusal') {
        throw new ProviderError(
          'bad_request',
          this.getName(),
          'Claude declined to answer this question.',
        );
      }

      if (message.stop_reason === 'max_tokens') {
        throw new ProviderError(
          'invalid_response',
          this.getName(),
          'Claude stopped before finishing its answer.',
        );
      }

      const answer = validateAnswer(message.parsed_output, this.getName());
      return { ...answer, provider: this.getName(), model: message.model || this.model };
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
        `Claude did not respond within ${this.timeoutMs}ms.`,
        { cause: error },
      );
    }

    // APIConnectionError extends APIError in this SDK, so it is checked first.
    if (error instanceof Anthropic.APIConnectionError) {
      return new ProviderError('unavailable', this.getName(), 'Could not reach the Claude API.', {
        cause: error,
      });
    }

    if (error instanceof Anthropic.APIError) {
      return new ProviderError(
        codeForStatus(statusOf(error)),
        this.getName(),
        messageOf(error, 'The Claude API rejected the request.'),
        { cause: error },
      );
    }

    return new ProviderError('unknown', this.getName(), messageOf(error, 'Claude request failed.'), {
      cause: error,
    });
  }
}
