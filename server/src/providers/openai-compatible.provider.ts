/**
 * Adapter for any OpenAI-compatible endpoint.
 *
 * The base URL, key and model all come from configuration - no third-party
 * endpoint is hard-coded. Compatible servers vary in how much of the
 * `response_format` surface they implement, so this adapter asks for JSON
 * object mode (widely supported), restates the schema in the prompt, and
 * falls back to extracting the JSON object from plain text if the endpoint
 * ignores the request entirely.
 */
import OpenAI from 'openai';
import type { AIProvider, ProviderContext } from './ai-provider.interface.js';
import { ProviderError, codeForStatus, isAbort, messageOf, statusOf } from './provider.errors.js';
import { parseAnswerText, withDeadline } from './provider.utils.js';
import type { QuestionAnswer, QuestionRequest } from '../question/question.schema.js';
import { SYSTEM_PROMPT, buildUserPrompt } from '../question/question.prompt.js';

const SCHEMA_INSTRUCTION = [
  'Reply with a single JSON object and nothing else, in exactly this shape:',
  '{"answer": string, "explanation": string, "confidence": number between 0 and 1, "reasoningSummary": string}',
].join('\n');

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class OpenAICompatibleProvider implements AIProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(config: OpenAICompatibleConfig, context: ProviderContext) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      maxRetries: 1,
    });
    this.model = context.model?.trim() || config.model;
    this.timeoutMs = context.timeoutMs;
  }

  getName(): string {
    return 'openai-compatible';
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
            { role: 'system', content: `${SYSTEM_PROMPT}\n\n${SCHEMA_INSTRUCTION}` },
            { role: 'user', content: buildUserPrompt(request) },
          ],
          response_format: { type: 'json_object' },
        },
        { signal: deadline.signal },
      );

      const answer = parseAnswerText(completion.choices[0]?.message?.content, this.getName());
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
        `The endpoint did not respond within ${this.timeoutMs}ms.`,
        { cause: error },
      );
    }

    if (error instanceof OpenAI.APIConnectionError) {
      return new ProviderError(
        'unavailable',
        this.getName(),
        'Could not reach the configured endpoint.',
        { cause: error },
      );
    }

    if (error instanceof OpenAI.APIError) {
      return new ProviderError(
        codeForStatus(statusOf(error)),
        this.getName(),
        messageOf(error, 'The endpoint rejected the request.'),
        { cause: error },
      );
    }

    return new ProviderError(
      'unknown',
      this.getName(),
      messageOf(error, 'The endpoint request failed.'),
      { cause: error },
    );
  }
}
