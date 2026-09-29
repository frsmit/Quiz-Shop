/**
 * Google Gemini adapter.
 *
 * Gemini constrains output through `responseMimeType` plus a JSON schema.
 * Its schema dialect is a subset of JSON Schema, so the shared schema is
 * passed without `additionalProperties`, which it does not accept.
 */
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { AIProvider, ProviderContext } from './ai-provider.interface.js';
import {
  ProviderError,
  codeForStatus,
  isAbort,
  messageOf,
  retryAfterOf,
  statusOf,
} from './provider.errors.js';
import { parseAnswerText, withDeadline } from './provider.utils.js';
import { ANSWER_JSON_SCHEMA } from '../question/question.schema.js';
import type { QuestionAnswer, QuestionRequest } from '../question/question.schema.js';
import { SYSTEM_PROMPT, buildUserPrompt } from '../question/question.prompt.js';

/**
 * A pinned Flash model rather than the `gemini-flash-latest` alias.
 *
 * The alias reliably serves plain requests but returns 503 for ones that
 * carry a system instruction or a response schema - which is every request
 * this adapter makes. Pinned models answer those fine.
 *
 * Newer Flash releases carry a much smaller free-tier allowance (the newest
 * was capped at 20 requests a day when this was written), so the default is a
 * version back from the newest - it is the one a free key can actually use.
 *
 * Google retires pinned versions, and when it does the 404 it returns names
 * the replacement; that message is surfaced verbatim in the activity log.
 * Override with AI_MODEL at any time.
 */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash';

const { additionalProperties: _ignored, ...GEMINI_SCHEMA } = ANSWER_JSON_SCHEMA;

export interface GeminiOptions {
  /** See GEMINI_THINKING_LEVEL. */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
}

const THINKING_LEVELS: Record<NonNullable<GeminiOptions['thinkingLevel']>, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export class GeminiProvider implements AIProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly thinkingLevel: ThinkingLevel;

  constructor(apiKey: string, context: ProviderContext, options: GeminiOptions = {}) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = context.model?.trim() || GEMINI_DEFAULT_MODEL;
    this.timeoutMs = context.timeoutMs;
    this.thinkingLevel = THINKING_LEVELS[options.thinkingLevel ?? 'low'];
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
          // `thinkingLevel`, not `thinkingBudget`: the SDK documents the
          // budget as rejected from Gemini 3.5 on.
          thinkingConfig: { thinkingLevel: this.thinkingLevel },
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
    if (status === 429) {
      // Google's message is a page of JSON; the useful part is the wait.
      const retryAfterMs = retryAfterOf(error);
      return new ProviderError(
        'rate_limited',
        this.getName(),
        retryAfterMs === undefined
          ? 'Gemini rate limit reached (the free tier allows 15 requests a minute).'
          : `Gemini rate limit reached (the free tier allows 15 requests a minute); retry in ${Math.ceil(retryAfterMs / 1000)}s.`,
        { cause: error, retryAfterMs },
      );
    }
    if (status !== undefined) {
      return new ProviderError(
        codeForStatus(status),
        this.getName(),
        messageOf(error, 'Gemini rejected the request.'),
        { cause: error, retryAfterMs: retryAfterOf(error) },
      );
    }

    return new ProviderError('unknown', this.getName(), messageOf(error, 'Gemini request failed.'), {
      cause: error,
    });
  }
}
