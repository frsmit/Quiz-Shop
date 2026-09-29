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
  /** Unset means loopback in development and all interfaces in production,
   *  which is what a hosted container or PaaS needs. */
  HOST: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Which adapter the provider factory builds by default. */
  AI_PROVIDER: z.enum(['openai', 'gemini', 'anthropic', 'openai-compatible']).default('openai'),
  /** Optional global model override; each provider has a sensible default. */
  AI_MODEL: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  /**
   * How long Gemini 3.x reasons before answering. Its default reasons at
   * length even for a one-word answer (24-30s+ per question), which outlasts
   * the extension's request timeout; LOW answers the same questions in a
   * few seconds.
   */
  GEMINI_THINKING_LEVEL: z
    .enum(['minimal', 'low', 'medium', 'high'])
    .default('low'),
  ANTHROPIC_API_KEY: z.string().optional(),

  /** Credentials for any OpenAI-compatible endpoint. */
  AI_BASE_URL: z.string().optional(),
  AI_API_KEY: z.string().optional(),

  /** Shared secret the extension must present, when set. */
  API_ACCESS_KEY: z.string().optional(),

  /** Browser extensions send `Origin: chrome-extension://<id>`. */
  /** Unset means the extension plus the local demo page in development, and
   *  the extension alone in production. */
  CORS_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((value) => (value ? splitCsv(value) : undefined)),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),

  /** Upper bound on answering one question, retries included. */
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  /**
   * Upper bound on one provider call. A call past it counts as stalled and is
   * retried while PROVIDER_TIMEOUT_MS has time left - under a burst, free
   * tiers leave some calls hanging that answer at once when sent again.
   * Unset means a single call may use the whole budget, and is not retried.
   */
  PROVIDER_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  /** Attempts per question, including the first. Only retryable failures
   *  (429, 503, connection resets) are retried - free tiers return these
   *  routinely and one of them should not become a failed answer. */
  PROVIDER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  /** Delay before the second attempt; doubles, with jitter. */
  PROVIDER_RETRY_BASE_MS: z.coerce.number().int().min(0).default(1_000),
  /** Largest JSON body accepted, as an Express body-parser size string. */
  MAX_REQUEST_BODY: z.string().default('32kb'),

  CACHE_ENABLED: booleanish.default(true),
  CACHE_TTL_MS: z.coerce.number().int().positive().default(1_800_000),
  CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(500),

  /**
   * Optional persistence. When set, the answer cache and question history
   * live in MongoDB (local or Atlas); when unset, the cache is in memory and
   * no history is kept.
   */
  MONGODB_URI: z.string().optional(),
  /**
   * DNS servers for the driver's `mongodb+srv://` SRV/TXT lookups, e.g.
   * `8.8.8.8,1.1.1.1`. Only needed where the local resolver refuses SRV
   * queries (some VPNs and endpoint agents); leave unset otherwise.
   */
  MONGODB_DNS_SERVERS: z
    .string()
    .optional()
    .transform((value) => (value ? splitCsv(value) : undefined)),
  /** Database name; defaults to the one in the URI path, else `quiz-shop`. */
  MONGODB_DB: z.string().optional(),
  /** Store each answered question server-side. Only applies with MONGODB_URI. */
  HISTORY_ENABLED: booleanish.default(true),
  /** History entries older than this are deleted by a TTL index. */
  HISTORY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
});

type ParsedEnv = z.infer<typeof envSchema>;

export type Env = Omit<ParsedEnv, 'HOST' | 'CORS_ALLOWED_ORIGINS'> & {
  HOST: string;
  CORS_ALLOWED_ORIGINS: string[];
};

const DEV_CORS = ['chrome-extension://*', 'http://localhost:5173'];
const PROD_CORS = ['chrome-extension://*'];

/** Environment-dependent defaults, plus rules that only hold in production. */
function finalize(parsed: ParsedEnv): Env {
  const production = parsed.NODE_ENV === 'production';

  if (production && !parsed.API_ACCESS_KEY) {
    throw new Error(
      'Invalid environment configuration:\n  API_ACCESS_KEY: required when NODE_ENV=production, ' +
        'so a hosted backend cannot be used by anyone who finds its URL.',
    );
  }

  return {
    ...parsed,
    HOST: parsed.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    CORS_ALLOWED_ORIGINS: parsed.CORS_ALLOWED_ORIGINS ?? (production ? PROD_CORS : DEV_CORS),
  };
}

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
  return finalize(parsed.data);
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
