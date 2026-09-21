import type { ExtensionSettings } from './types';

/** `chrome.storage.sync` key holding the user's settings object. */
export const SETTINGS_STORAGE_KEY = 'settings';

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

/** Floor on the gap between two backend requests from one tab. */
export const REQUEST_THROTTLE_MS = 1200;

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: 'openai',
  model: '',
  backendUrl: 'http://localhost:3000',
  backendApiKey: '',
  autoDetect: true,
  autoFill: false,
  maxContextLength: 2000,
  requestTimeoutMs: 30_000,
  cacheEnabled: true,
  enabledOrigins: ['http://localhost:5173'],
};

export const PROVIDER_LABELS: Record<ExtensionSettings['provider'], string> = {
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  anthropic: 'Anthropic Claude',
  'openai-compatible': 'OpenAI-compatible endpoint',
};
