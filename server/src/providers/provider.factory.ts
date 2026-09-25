/**
 * Provider factory and registry.
 *
 * Adding a vendor is four small steps and touches nothing else in the system:
 *   1. write an adapter implementing `AIProvider`,
 *   2. add its id to `providerIdSchema`,
 *   3. register a builder below,
 *   4. add its credentials to the environment schema.
 */
import type { AIProvider, ProviderContext } from './ai-provider.interface.js';
import { ProviderError } from './provider.errors.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { GEMINI_DEFAULT_MODEL, GeminiProvider } from './gemini.provider.js';
import { OpenAIProvider } from './openai.provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.provider.js';
import type { Env } from '../config/env.js';
import type { ProviderId } from '../question/question.schema.js';

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  /** Whether the environment carries everything this adapter needs. */
  configured: boolean;
  /** The model it would use with no per-request override. */
  defaultModel: string;
}

interface Registration {
  label: string;
  defaultModel: (env: Env) => string;
  isConfigured: (env: Env) => boolean;
  /** Human-readable note naming the variables that are missing. */
  requirement: string;
  build: (env: Env, context: ProviderContext) => AIProvider;
}

const REGISTRY: Record<ProviderId, Registration> = {
  openai: {
    label: 'OpenAI',
    defaultModel: (env) => env.AI_MODEL ?? 'gpt-4o-mini',
    isConfigured: (env) => Boolean(env.OPENAI_API_KEY),
    requirement: 'OPENAI_API_KEY',
    build: (env, context) => new OpenAIProvider(env.OPENAI_API_KEY as string, context),
  },

  gemini: {
    label: 'Google Gemini',
    defaultModel: (env) => env.AI_MODEL ?? GEMINI_DEFAULT_MODEL,
    isConfigured: (env) => Boolean(env.GEMINI_API_KEY),
    requirement: 'GEMINI_API_KEY',
    build: (env, context) => new GeminiProvider(env.GEMINI_API_KEY as string, context),
  },

  anthropic: {
    label: 'Anthropic Claude',
    defaultModel: (env) => env.AI_MODEL ?? 'claude-opus-5',
    isConfigured: (env) => Boolean(env.ANTHROPIC_API_KEY),
    requirement: 'ANTHROPIC_API_KEY',
    build: (env, context) => new AnthropicProvider(env.ANTHROPIC_API_KEY as string, context),
  },

  'openai-compatible': {
    label: 'OpenAI-compatible endpoint',
    defaultModel: (env) => env.AI_MODEL ?? '',
    isConfigured: (env) => Boolean(env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL),
    requirement: 'AI_BASE_URL, AI_API_KEY and AI_MODEL',
    build: (env, context) =>
      new OpenAICompatibleProvider(
        {
          baseUrl: env.AI_BASE_URL as string,
          apiKey: env.AI_API_KEY as string,
          model: env.AI_MODEL as string,
        },
        context,
      ),
  },
};

/**
 * What the application actually depends on. Narrowing the dependency to an
 * interface keeps `createApp` testable without credentials or network access.
 */
export interface ProviderRegistry {
  create: (id?: ProviderId, model?: string) => AIProvider;
  describe: () => ProviderDescriptor[];
  configured: () => ProviderId[];
  activeProvider: () => ProviderId;
}

export class ProviderFactory implements ProviderRegistry {
  constructor(private readonly env: Env) {}

  /**
   * Build the adapter for `id`, defaulting to the configured provider.
   * Adapters are cheap to construct, so each request gets its own - which is
   * what makes a per-request model override possible.
   */
  create(id: ProviderId = this.env.AI_PROVIDER, model?: string): AIProvider {
    const registration = REGISTRY[id];
    if (!registration) {
      throw new ProviderError('bad_request', id, `Unknown AI provider "${id}".`);
    }

    if (!registration.isConfigured(this.env)) {
      throw new ProviderError(
        'missing_credentials',
        id,
        `The ${registration.label} provider is not configured. Set ${registration.requirement} in the server environment.`,
      );
    }

    return registration.build(this.env, {
      model: model ?? this.env.AI_MODEL,
      timeoutMs: this.env.PROVIDER_TIMEOUT_MS,
    });
  }

  /** Everything the health endpoint reports - never the credentials. */
  describe(): ProviderDescriptor[] {
    return (Object.keys(REGISTRY) as ProviderId[]).map((id) => {
      const registration = REGISTRY[id];
      return {
        id,
        label: registration.label,
        configured: registration.isConfigured(this.env),
        defaultModel: registration.defaultModel(this.env),
      };
    });
  }

  /** Ids with usable credentials. */
  configured(): ProviderId[] {
    return this.describe()
      .filter((descriptor) => descriptor.configured)
      .map((descriptor) => descriptor.id);
  }

  activeProvider(): ProviderId {
    return this.env.AI_PROVIDER;
  }
}
