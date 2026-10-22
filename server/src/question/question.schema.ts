/**
 * The API contract, expressed once as Zod schemas.
 *
 * These schemas validate both directions: what the extension sends, and what
 * comes back from a provider. A model that returns something off-contract is
 * treated as a provider failure rather than passed through to the caller.
 */
import { z } from 'zod';

export const QUESTION_LIMITS = {
  maxQuestionLength: 4000,
  maxContextLength: 8000,
  maxOptionLength: 1000,
  maxOptions: 26,
  minQuestionLength: 8,
} as const;

export const questionTypeSchema = z.enum([
  'multiple_choice',
  'short_answer',
  'programming',
  'mathematical',
  'unknown',
]);

export const providerIdSchema = z.enum(['openai', 'gemini', 'anthropic', 'openai-compatible']);

export const questionRequestSchema = z.object({
  question: z
    .string()
    .trim()
    .min(QUESTION_LIMITS.minQuestionLength)
    .max(QUESTION_LIMITS.maxQuestionLength),

  type: questionTypeSchema.default('unknown'),

  options: z
    .array(z.string().trim().min(1).max(QUESTION_LIMITS.maxOptionLength))
    .min(2)
    .max(QUESTION_LIMITS.maxOptions)
    .optional(),

  context: z.string().trim().max(QUESTION_LIMITS.maxContextLength).optional(),

  /**
   * More than one option may be correct ("select all that apply"): the page
   * offers checkboxes rather than radio buttons. Only meaningful with options.
   */
  multiSelect: z.boolean().optional(),

  source: z
    .object({
      url: z.string().max(2000).optional(),
      title: z.string().max(300).optional(),
    })
    .optional(),

  /** Per-request overrides; both fall back to the server configuration. */
  provider: providerIdSchema.optional(),
  model: z.string().trim().min(1).max(120).optional(),
});

/**
 * What a provider is asked to produce. `reasoningSummary` is a short,
 * learner-facing note - providers are instructed never to return raw
 * chain-of-thought, and nothing here carries one.
 */
export const providerAnswerSchema = z.object({
  answer: z.string().min(1).max(4000),
  /**
   * Every option chosen, for a question where more than one may be correct.
   * The service keeps it only for multi-select requests; `answer` then lists
   * the same options joined by "; ", for display.
   */
  answers: z.array(z.string().max(4000)).max(50).optional(),
  explanation: z.string().min(1).max(4000),
  confidence: z.number().min(0).max(1).optional(),
  reasoningSummary: z.string().max(2000).optional(),
});

export const questionAnswerSchema = providerAnswerSchema.extend({
  provider: z.string(),
  model: z.string(),
});

export type QuestionRequest = z.infer<typeof questionRequestSchema>;
export type QuestionType = z.infer<typeof questionTypeSchema>;
export type ProviderId = z.infer<typeof providerIdSchema>;
export type ProviderAnswer = z.infer<typeof providerAnswerSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

/**
 * JSON Schema handed to providers that constrain output natively.
 * Written out rather than generated so the wording stays under our control
 * and every provider sees exactly the same contract.
 */
export const ANSWER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description:
        'The answer itself. For a multiple-choice question this must be the exact text of one of the supplied options.',
    },
    answers: {
      type: 'array',
      items: { type: 'string' },
      description:
        'For a multiple-choice question, the exact text of every option chosen - one entry for a single-answer question, all the correct ones when more than one may be correct. Empty for any other question.',
    },
    explanation: {
      type: 'string',
      description: 'A short explanation of why that answer is correct, aimed at a learner.',
    },
    confidence: {
      type: 'number',
      description: 'Confidence in the answer, from 0 to 1.',
    },
    reasoningSummary: {
      type: 'string',
      description:
        'One or two sentences summarising the approach. Never include internal chain-of-thought.',
    },
  },
  required: ['answer', 'answers', 'explanation', 'confidence', 'reasoningSummary'],
  additionalProperties: false,
} as const;
