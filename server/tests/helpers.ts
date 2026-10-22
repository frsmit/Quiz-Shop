/**
 * Test fixtures: a fully controllable provider registry and an app builder.
 * No test in this suite reaches the network or needs a credential.
 */
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import type { Env } from '../src/config/env.js';
import type { AIProvider, ClientCredentials } from '../src/providers/ai-provider.interface.js';
import type { ProviderDescriptor, ProviderRegistry } from '../src/providers/provider.factory.js';
import type { ProviderId, QuestionAnswer, QuestionRequest } from '../src/question/question.schema.js';

export const VALID_QUESTION = {
  question: 'What is the time complexity of binary search?',
  type: 'multiple_choice' as const,
  options: ['O(n)', 'O(log n)', 'O(n^2)', 'O(1)'],
};

export function answerFor(request: QuestionRequest): QuestionAnswer {
  return {
    answer: request.options?.[1] ?? 'An answer',
    explanation: 'Binary search halves the search space on each step.',
    confidence: 0.95,
    reasoningSummary: 'Recognised a standard complexity fact.',
    provider: 'stub',
    model: 'stub-model',
  };
}

export interface StubProviderOptions {
  name?: string;
  model?: string;
  /** Replaces the default behaviour; throw from here to simulate failures. */
  respond?: (request: QuestionRequest, signal?: AbortSignal) => Promise<QuestionAnswer>;
}

export class StubProvider implements AIProvider {
  calls = 0;

  constructor(private readonly options: StubProviderOptions = {}) {}

  getName(): string {
    return this.options.name ?? 'stub';
  }

  getModel(): string {
    return this.options.model ?? 'stub-model';
  }

  async answerQuestion(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionAnswer> {
    this.calls += 1;
    if (this.options.respond) return this.options.respond(request, signal);
    return { ...answerFor(request), provider: this.getName(), model: this.getModel() };
  }
}

export class StubRegistry implements ProviderRegistry {
  createCalls: Array<{ id?: ProviderId; model?: string; credentials?: ClientCredentials }> = [];

  constructor(
    private readonly provider: AIProvider = new StubProvider(),
    private readonly onCreate?: (id?: ProviderId, model?: string) => void,
  ) {}

  create(id?: ProviderId, model?: string, credentials?: ClientCredentials): AIProvider {
    this.createCalls.push({ id, model, ...(credentials ? { credentials } : {}) });
    this.onCreate?.(id, model);
    return this.provider;
  }

  describe(): ProviderDescriptor[] {
    return [
      { id: 'openai', label: 'OpenAI', configured: true, defaultModel: 'gpt-4o-mini' },
      { id: 'gemini', label: 'Google Gemini', configured: false, defaultModel: 'gemini-2.0-flash' },
      { id: 'anthropic', label: 'Anthropic Claude', configured: false, defaultModel: 'claude-opus-5' },
      {
        id: 'openai-compatible',
        label: 'OpenAI-compatible endpoint',
        configured: false,
        defaultModel: '',
      },
    ];
  }

  configured(): ProviderId[] {
    return ['openai'];
  }

  activeProvider(): ProviderId {
    return 'openai';
  }

  acceptsClientKeys(): boolean {
    return true;
  }
}

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    CACHE_ENABLED: 'false',
    RATE_LIMIT_MAX: '1000',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export function buildApp(
  registry: ProviderRegistry = new StubRegistry(),
  overrides: Record<string, string> = {},
): Express {
  return createApp({ env: testEnv(overrides), factory: registry });
}
