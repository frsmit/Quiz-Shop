/**
 * Environment configuration.
 *
 * Every value the server reads from the environment is declared and validated
 * here, so a misconfigured deployment fails at startup with a readable message
 * rather than on the first request. Provider credentials never leave this
 * module's consumers - they are not logged and not exposed on any endpoint.
 */
import 'dotenv/config';
import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Which adapter the provider factory builds by default. */
  AI_PROVIDER: z.enum(['openai', 'gemini', 'anthropic', 'openai-compatible']).default('openai'),
  /** Optional global model override; each provider has a sensible default. */
  AI_MODEL: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  /** Credentials for any OpenAI-compatible endpoint. */
  AI_BASE_URL: z.string().optional(),
  AI_API_KEY: z.string().optional(),

  /** Shared secret the extension must present, when set. */
  API_ACCESS_KEY: z.string().optional(),

  /** Browser extensions send `Origin: chrome-extension://<id>`. */
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('chrome-extension://*,http://localhost:5173')
    .transform(splitCsv),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),

  /** Upper bound on a single provider call. */
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  /** Largest JSON body accepted, as an Express body-parser size string. */
  MAX_REQUEST_BODY: z.string().default('32kb'),

  CACHE_ENABLED: booleanish.default(true),
  CACHE_TTL_MS: z.coerce.number().int().positive().default(1_800_000),
  CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(500),

  /** Reserved for the optional persistence layer; unused in this version. */
  MONGODB_URI: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * A blank value in a `.env` file means "not set", not "set to empty string" -
 * otherwise commenting a key out and clearing it would behave differently,
 * and every default in the schema below would be bypassed.
 */
function withoutBlanks(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(withoutBlanks(source));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}

/** The process-wide configuration, parsed once. */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test helper: force the next `getEnv()` to re-read the environment. */
export function resetEnv(): void {
  cached = null;
}
