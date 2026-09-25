import type { ExtensionSettings, RunState } from './types';

/** `chrome.storage.sync` key holding the user's settings object. */
export const SETTINGS_STORAGE_KEY = 'settings';

/** `chrome.storage.local` keys. Runtime state and logs are per-device. */
export const RUN_STATE_STORAGE_KEY = 'runState';
export const ACTIVITY_LOG_STORAGE_KEY = 'activityLog';

/** Transport limits, mirrored by the backend's Zod schema. */
export const LIMITS = {
  maxQuestionLength: 4000,
  maxContextLength: 8000,
  maxOptionLength: 1000,
  maxOptions: 26,
  /** Shortest string still plausible as a question. */
  minQuestionLength: 12,
} as const;

/** How long the service worker keeps an answer before re-asking the provider. */
export const CACHE_TTL_MS = 30 * 60 * 1000;

/** Largest number of answers held in the in-memory service-worker cache. */
export const CACHE_MAX_ENTRIES = 200;

/** Quiet period after a DOM mutation before the page is re-scanned. */
export const MUTATION_DEBOUNCE_MS = 400;

/** Bounds for the two user-configurable timings, in milliseconds. */
export const TIMING_BOUNDS = {
  startDelay: { min: 0, max: 60 * 60 * 1000 },
  answerDelay: { min: 0, max: 5 * 60 * 1000 },
} as const;

export const LOG_LIMIT_BOUNDS = { min: 50, max: 5000 } as const;

/**
 * Hosts the manifest's static content script already covers.
 *
 * Chrome match patterns ignore the port, so `http://localhost/*` covers every
 * port on localhost. Registering a dynamic script for one of these would
 * inject the content script a second time into the same page.
 */
export const STATIC_CONTENT_SCRIPT_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

/** True when the manifest already injects into this origin. */
export function isStaticallyInjected(origin: string): boolean {
  try {
    return STATIC_CONTENT_SCRIPT_HOSTS.includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: '',
  model: '',
  // 127.0.0.1 rather than localhost on purpose. The backend binds IPv4 only
  // (HOST defaults to 127.0.0.1), while `localhost` resolves to ::1 first on
  // Windows - so if anything else is listening on IPv6 port 3000, that is
  // what the extension would talk to.
  backendUrl: 'http://127.0.0.1:3000',
  backendApiKey: '',
  autoDetect: true,
  autoFill: false,
  maxContextLength: 2000,
  requestTimeoutMs: 30_000,
  cacheEnabled: true,

  startDelayMs: 0,
  answerDelayMs: 1200,

  logEnabled: true,
  logLimit: 500,

  // Empty by default: localhost is covered by the manifest, so the bundled
  // demo works with no opt-in and no site is enabled without the user asking.
  enabledOrigins: [],
};

export const DEFAULT_RUN_STATE: RunState = { paused: false, resumedAt: 0 };

/**
 * The provider dropdown, in order. The first entry sends no `provider` field
 * at all, so the backend's own `AI_PROVIDER` applies.
 */
export const PROVIDER_CHOICES: ReadonlyArray<{
  value: ExtensionSettings['provider'];
  label: string;
}> = [
  { value: '', label: "Use the backend's configured provider" },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'anthropic', label: 'Anthropic Claude' },
  { value: 'openai-compatible', label: 'OpenAI-compatible endpoint' },
];

/** Preset values offered for the two delays, so the common cases are one click. */
export const START_DELAY_PRESETS = [
  { label: 'Immediately', value: 0 },
  { label: 'After 30 seconds', value: 30_000 },
  { label: 'After 2 minutes', value: 120_000 },
  { label: 'After 5 minutes', value: 300_000 },
  { label: 'After 10 minutes', value: 600_000 },
] as const;

export const ANSWER_DELAY_PRESETS = [
  { label: 'No delay', value: 0 },
  { label: '1 second', value: 1000 },
  { label: '3 seconds', value: 3000 },
  { label: '10 seconds', value: 10_000 },
  { label: '30 seconds', value: 30_000 },
] as const;

/** `mm:ss` for a countdown, used by the popup and the monitor. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
