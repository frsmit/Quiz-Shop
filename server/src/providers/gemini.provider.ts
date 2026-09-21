/**
 * Google Gemini adapter.
 *
 * Gemini constrains output through `responseMimeType` plus a JSON schema.
 * Its schema dialect is a subset of JSON Schema, so the shared schema is
 * passed without `additionalProperties`, which it does not accept.
 */
import { GoogleGenAI } from '@google/genai';
import type { AIProvider, ProviderContext } from './ai-provider.interface.js';
import { ProviderError, codeForStatus, isAbort, messageOf, statusOf } from './provider.errors.js';
import { parseAnswerText, withDeadline } from './provider.utils.js';
import { ANSWER_JSON_SCHEMA } from '../question/question.schema.js';
import type { QuestionAnswer, QuestionRequest } from '../question/question.schema.js';
import { SYSTEM_PROMPT, buildUserPrompt } from '../question/question.prompt.js';

export const GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash';

const { additionalProperties: _ignored, ...GEMINI_SCHEMA } = ANSWER_JSON_SCHEMA;

export class GeminiProvider implements AIProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, context: ProviderContext) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = context.model?.trim() || GEMINI_DEFAULT_MODEL;
    this.timeoutMs = context.timeoutMs;
  }

  getName(): string {
    return 'gemini';
  }

  getModel(): string {
    return this.model;
  }

  async answerQuestion(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionAnswer> {
    const deadline = withDeadline(this.timeoutMs, signal);

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: buildUserPrompt(request),
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseJsonSchema: GEMINI_SCHEMA,
          abortSignal: deadline.signal,
        },
      });

      const answer = parseAnswerText(response.text, this.getName());
      return { ...answer, provider: this.getName(), model: this.model };
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
        `Gemini did not respond within ${this.timeoutMs}ms.`,
        { cause: error },
      );
    }

    const status = statusOf(error);
    if (status !== undefined) {
      return new ProviderError(
        codeForStatus(status),
        this.getName(),
        messageOf(error, 'Gemini rejected the request.'),
        { cause: error },
      );
    }

    return new ProviderError('unknown', this.getName(), messageOf(error, 'Gemini request failed.'), {
      cause: error,
    });
  }
}
