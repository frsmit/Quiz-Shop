/**
 * Provider factory and registry.
 *
 * Adding a vendor is four small steps and touches nothing else in the system:
 *   1. write an adapter implementing `AIProvider`,
 *   2. add its id to `providerIdSchema`,
 *   3. register a builder below,
 *   4. add its credentials to the environment schema.
 */
import type { AIProvider, ClientCredentials, ProviderContext } from './ai-provider.interface.js';
import { ProviderError } from './provider.errors.js';
import { ANTHROPIC_DEFAULT_MODEL, AnthropicProvider } from './anthropic.provider.js';
import { GEMINI_DEFAULT_MODEL, GeminiProvider } from './gemini.provider.js';
import { OPENAI_DEFAULT_MODEL, OpenAIProvider } from './openai.provider.js';
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

/** The key and endpoint one adapter instance is built with. */
interface Credentials {
  apiKey: string;
  baseUrl?: string | undefined;
}

interface Registration {
  label: string;
  /** The adapter's own default, when neither the request nor AI_MODEL names one. */
  fallbackModel: string;
  isConfigured: (env: Env) => boolean;
  /** Human-readable note naming the variables that are missing. */
  requirement: string;
  /** The server's own credentials for this provider. */
  serverCredentials: (env: Env) => Credentials;
  build: (credentials: Credentials, env: Env, context: ProviderContext) => AIProvider;
}

const REGISTRY: Record<ProviderId, Registration> = {
  openai: {
    label: 'OpenAI',
    fallbackModel: OPENAI_DEFAULT_MODEL,
    isConfigured: (env) => Boolean(env.OPENAI_API_KEY),
    requirement: 'OPENAI_API_KEY',
    serverCredentials: (env) => ({ apiKey: env.OPENAI_API_KEY as string }),
    build: (credentials, _env, context) => new OpenAIProvider(credentials.apiKey, context),
  },

  gemini: {
    label: 'Google Gemini',
    fallbackModel: GEMINI_DEFAULT_MODEL,
    isConfigured: (env) => Boolean(env.GEMINI_API_KEY),
    requirement: 'GEMINI_API_KEY',
    serverCredentials: (env) => ({ apiKey: env.GEMINI_API_KEY as string }),
    build: (credentials, env, context) =>
      new GeminiProvider(credentials.apiKey, context, {
        thinkingLevel: env.GEMINI_THINKING_LEVEL,
      }),
  },

  anthropic: {
    label: 'Anthropic Claude',
    fallbackModel: ANTHROPIC_DEFAULT_MODEL,
    isConfigured: (env) => Boolean(env.ANTHROPIC_API_KEY),
    requirement: 'ANTHROPIC_API_KEY',
    serverCredentials: (env) => ({ apiKey: env.ANTHROPIC_API_KEY as string }),
    build: (credentials, _env, context) => new AnthropicProvider(credentials.apiKey, context),
  },

  'openai-compatible': {
    label: 'OpenAI-compatible endpoint',
    fallbackModel: '',
    isConfigured: (env) => Boolean(env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL),
    requirement: 'AI_BASE_URL, AI_API_KEY and AI_MODEL',
    serverCredentials: (env) => ({ apiKey: env.AI_API_KEY as string, baseUrl: env.AI_BASE_URL }),
    build: (credentials, _env, context) =>
      new OpenAICompatibleProvider(
        {
          baseUrl: credentials.baseUrl as string,
          apiKey: credentials.apiKey,
          model: context.model as string,
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
  /**
   * `credentials`, when given, is the caller's own key and replaces the
   * server's for this one adapter.
   */
  create: (id?: ProviderId, model?: string, credentials?: ClientCredentials) => AIProvider;
  describe: () => ProviderDescriptor[];
  configured: () => ProviderId[];
  activeProvider: () => ProviderId;
  /** Whether `create` accepts caller-supplied credentials at all. */
  acceptsClientKeys: () => boolean;
}

export class ProviderFactory implements ProviderRegistry {
  constructor(private readonly env: Env) {}

  /**
   * Build the adapter for `id`, defaulting to the configured provider.
   * Adapters are cheap to construct, so each request gets its own - which is
   * what makes a per-request model override, and a per-request key, possible.
   */
  create(
    id: ProviderId = this.env.AI_PROVIDER,
    model?: string,
    credentials?: ClientCredentials,
  ): AIProvider {
    const registration = REGISTRY[id];
    if (!registration) {
      throw new ProviderError('bad_request', id, `Unknown AI provider "${id}".`);
    }

    const resolvedModel = model?.trim() || this.configuredModel(id);
    const context: ProviderContext = {
      model: resolvedModel || undefined,
      // Per call; the service enforces PROVIDER_TIMEOUT_MS across retries.
      timeoutMs: Math.min(
        this.env.PROVIDER_ATTEMPT_TIMEOUT_MS ?? this.env.PROVIDER_TIMEOUT_MS,
        this.env.PROVIDER_TIMEOUT_MS,
      ),
    };

    if (credentials?.apiKey) {
      const own = this.clientCredentials(id, credentials, model?.trim() ?? '');
      return registration.build(own, this.env, context);
    }

    if (!registration.isConfigured(this.env)) {
      throw new ProviderError(
        'missing_credentials',
        id,
        `The ${registration.label} provider is not configured. Set ${registration.requirement} in the server environment, or enter your own API key in the extension settings.`,
      );
    }

    return registration.build(registration.serverCredentials(this.env), this.env, context);
  }

  /** Everything the health endpoint reports - never the credentials. */
  describe(): ProviderDescriptor[] {
    return (Object.keys(REGISTRY) as ProviderId[]).map((id) => {
      const registration = REGISTRY[id];
      return {
        id,
        label: registration.label,
        configured: registration.isConfigured(this.env),
        defaultModel: this.configuredModel(id) || registration.fallbackModel,
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

  acceptsClientKeys(): boolean {
    return this.env.ALLOW_CLIENT_AI_KEYS;
  }

  /**
   * The model the environment names for `id`. `AI_MODEL` belongs to
   * `AI_PROVIDER`: handing a Gemini model name to OpenAI because the extension
   * switched provider would only produce a 404. The OpenAI-compatible
   * endpoint's server-side configuration has no other model setting, so it
   * keeps AI_MODEL whichever provider is active.
   */
  private configuredModel(id: ProviderId): string {
    if (id === this.env.AI_PROVIDER || id === 'openai-compatible') return this.env.AI_MODEL ?? '';
    return '';
  }

  /** Validate a caller's key, and the endpoint that goes with it. */
  private clientCredentials(id: ProviderId, credentials: ClientCredentials, model: string): Credentials {
    if (!this.env.ALLOW_CLIENT_AI_KEYS) {
      throw new ProviderError(
        'bad_request',
        id,
        "This backend does not accept API keys from the extension (ALLOW_CLIENT_AI_KEYS is off). Clear the key in the extension settings to use the server's own.",
      );
    }

    if (id !== 'openai-compatible') return { apiKey: credentials.apiKey };

    // The caller's key only ever goes to the caller's endpoint, with the
    // caller's model: pairing it with the server's AI_BASE_URL would hand a
    // user's key to an endpoint they never chose.
    const baseUrl = credentials.baseUrl?.trim();
    if (!baseUrl) {
      throw new ProviderError(
        'bad_request',
        id,
        'An OpenAI-compatible endpoint needs a base URL. Set one in the extension settings.',
      );
    }
    if (!isHttpUrl(baseUrl)) {
      throw new ProviderError('bad_request', id, 'The endpoint base URL must be an http(s) URL.');
    }
    if (!model) {
      throw new ProviderError(
        'bad_request',
        id,
        'An OpenAI-compatible endpoint needs a model name. Set one in the extension settings.',
      );
    }
    return { apiKey: credentials.apiKey, baseUrl };
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
