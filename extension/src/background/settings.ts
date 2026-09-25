/**
 * Settings persistence for the service worker.
 *
 * Stored in `chrome.storage.sync` so preferences follow the signed-in profile.
 * Reads always merge over the defaults, which keeps older stored objects valid
 * after a new setting is introduced.
 */
import {
  DEFAULT_SETTINGS,
  LOG_LIMIT_BOUNDS,
  SETTINGS_STORAGE_KEY,
  TIMING_BOUNDS,
} from '../shared/constants';
import type { ExtensionSettings, ProviderChoice } from '../shared/types';

const PROVIDERS: readonly ProviderChoice[] = ['', 'openai', 'gemini', 'anthropic', 'openai-compatible'];

export async function readSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(SETTINGS_STORAGE_KEY);
  return sanitize(stored[SETTINGS_STORAGE_KEY]);
}

export async function writeSettings(value: unknown): Promise<ExtensionSettings> {
  const settings = sanitize(value);
  await chrome.storage.sync.set({ [SETTINGS_STORAGE_KEY]: settings });
  return settings;
}

/**
 * Coerce an arbitrary stored or posted object into valid settings.
 * The options page is trusted, but this is also the boundary that stops a
 * corrupt storage entry from taking the worker down on startup.
 */
export function sanitize(value: unknown): ExtensionSettings {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof ExtensionSettings, unknown>
  >;

  return {
    provider: PROVIDERS.includes(input.provider as ProviderChoice)
      ? (input.provider as ProviderChoice)
      : DEFAULT_SETTINGS.provider,
    model: asString(input.model, DEFAULT_SETTINGS.model).slice(0, 120),
    backendUrl: normalizeUrl(asString(input.backendUrl, DEFAULT_SETTINGS.backendUrl)),
    backendApiKey: asString(input.backendApiKey, DEFAULT_SETTINGS.backendApiKey).slice(0, 200),
    autoDetect: asBoolean(input.autoDetect, DEFAULT_SETTINGS.autoDetect),
    autoFill: asBoolean(input.autoFill, DEFAULT_SETTINGS.autoFill),
    maxContextLength: clamp(input.maxContextLength, 0, 8000, DEFAULT_SETTINGS.maxContextLength),
    requestTimeoutMs: clamp(input.requestTimeoutMs, 2000, 120_000, DEFAULT_SETTINGS.requestTimeoutMs),
    cacheEnabled: asBoolean(input.cacheEnabled, DEFAULT_SETTINGS.cacheEnabled),

    startDelayMs: clamp(
      input.startDelayMs,
      TIMING_BOUNDS.startDelay.min,
      TIMING_BOUNDS.startDelay.max,
      DEFAULT_SETTINGS.startDelayMs,
    ),
    answerDelayMs: clamp(
      input.answerDelayMs,
      TIMING_BOUNDS.answerDelay.min,
      TIMING_BOUNDS.answerDelay.max,
      DEFAULT_SETTINGS.answerDelayMs,
    ),

    logEnabled: asBoolean(input.logEnabled, DEFAULT_SETTINGS.logEnabled),
    logLimit: clamp(
      input.logLimit,
      LOG_LIMIT_BOUNDS.min,
      LOG_LIMIT_BOUNDS.max,
      DEFAULT_SETTINGS.logLimit,
    ),
    enabledOrigins: asOrigins(input.enabledOrigins),
  };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), min), max);
}

/** Keep only well-formed http(s) origins, de-duplicated. */
function asOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.enabledOrigins];
  const origins = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    try {
      const url = new URL(entry);
      if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(url.origin);
    } catch {
      // Ignore anything that is not a URL.
    }
  }
  return [...origins];
}

function normalizeUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_SETTINGS.backendUrl;
    return trimmed;
  } catch {
    return DEFAULT_SETTINGS.backendUrl;
  }
}
