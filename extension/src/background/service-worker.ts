/**
 * MV3 service worker: the extension's orchestrator.
 *
 * Content scripts share an origin with untrusted page code, so the worker owns
 * everything sensitive - settings, the backend URL, the optional backend key -
 * and validates every inbound message before acting on it. Content scripts
 * receive answers, never configuration they did not ask for.
 *
 * It also owns the things that must be global rather than per-tab: the pause
 * state, the start delay, the pacing between answers, and the activity log.
 */
import { envelope, hasKind, isEnvelope } from '../shared/messages';
import type { WorkerErrorCode, WorkerResponse } from '../shared/messages';
import { LIMITS, isStaticallyInjected } from '../shared/constants';
import type {
  ActivityOutcome,
  ExtensionSettings,
  QuestionRequest,
  QuestionType,
  RuntimeStatus,
} from '../shared/types';
import { BackendError, checkHealth, requestAnswer } from './backend-client';
import { createAnswerCache } from './cache';
import { createPacer } from './pacer';
import { readSettings, sanitize, writeSettings } from './settings';
import { ensureResumedAt, pause, readRunState, readiness, resume } from './run-state';
import * as activityLog from './activity-log';

const cache = createAnswerCache();
const pacer = createPacer();

/** In-flight requests, so two tabs asking the same question make one call. */
const inFlight = new Map<string, Promise<WorkerResponse>>();

const QUESTION_TYPES: readonly QuestionType[] = [
  'multiple_choice',
  'short_answer',
  'programming',
  'mathematical',
  'unknown',
];

const OUTCOMES: readonly ActivityOutcome[] = [
  'answered',
  'cached',
  'filled',
  'no-match',
  'no-control',
  'skipped',
  'error',
];

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    // Normalise whatever is in storage so later reads have every field.
    await writeSettings(await readSettings());
    await ensureResumedAt();
    await syncDynamicContentScripts();
    await refreshBadge();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureResumedAt();
    await syncDynamicContentScripts();
    await refreshBadge();
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isEnvelope(message)) return false;
  void handle(message.payload, sender).then(sendResponse, (error: unknown) => {
    sendResponse(failure(error instanceof Error ? error.message : 'Unexpected error.', 'unknown'));
  });
  return true; // Keep the channel open for the async response.
});

async function handle(
  payload: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): Promise<WorkerResponse> {
  // The options page runs in a tab too, so `sender.tab` cannot tell a
  // content script from our own UI. The sender's URL can: ours is served from
  // the extension's own origin, a content script's is the page it runs in.
  const trusted = isExtensionPage(sender);

  if (hasKind(payload, 'settings:get')) {
    return { ok: true, kind: 'settings', settings: await readSettings() };
  }

  if (hasKind(payload, 'question:detected')) return answerQuestion(payload);

  if (hasKind(payload, 'answer:applied')) {
    const fingerprint = typeof payload.fingerprint === 'string' ? payload.fingerprint : '';
    const outcome = OUTCOMES.includes(payload.outcome as ActivityOutcome)
      ? (payload.outcome as ActivityOutcome)
      : 'skipped';
    if (fingerprint) await activityLog.recordOutcome(fingerprint, outcome);
    return { ok: true, kind: 'ack' };
  }

  // Everything below changes configuration or reveals history, so it is
  // available only to the extension's own pages.
  if (!trusted) return failure('That action is not available to page scripts.', 'bad_request');

  if (hasKind(payload, 'settings:save')) {
    const settings = await writeSettings(payload.settings);
    await syncDynamicContentScripts(settings);
    await refreshBadge();
    await broadcastSettings(settings);
    return { ok: true, kind: 'settings', settings };
  }

  if (hasKind(payload, 'cache:clear')) {
    cache.clear();
    return { ok: true, kind: 'ack' };
  }

  if (hasKind(payload, 'run:get')) {
    return { ok: true, kind: 'run', status: await runtimeStatus() };
  }

  if (hasKind(payload, 'run:pause')) {
    await pause();
    pacer.reset();
    await refreshBadge();
    const status = await runtimeStatus();
    await broadcastRun(status);
    return { ok: true, kind: 'run', status };
  }

  if (hasKind(payload, 'run:resume')) {
    await resume();
    pacer.reset();
    await refreshBadge();
    const status = await runtimeStatus();
    await broadcastRun(status);
    return { ok: true, kind: 'run', status };
  }

  if (hasKind(payload, 'log:list')) {
    const limit = typeof payload.limit === 'number' ? payload.limit : undefined;
    return { ok: true, kind: 'log', entries: await activityLog.list(limit) };
  }

  if (hasKind(payload, 'log:stats')) {
    return { ok: true, kind: 'stats', stats: await activityLog.stats() };
  }

  if (hasKind(payload, 'log:clear')) {
    await activityLog.clear();
    return { ok: true, kind: 'ack' };
  }

  if (hasKind(payload, 'site:enable') || hasKind(payload, 'site:disable')) {
    const origin = typeof payload.origin === 'string' ? normalizeOrigin(payload.origin) : null;
    if (!origin) return failure('That is not a valid site address.', 'bad_request');

    const settings = await readSettings();
    const enabling = hasKind(payload, 'site:enable');
    const origins = new Set(settings.enabledOrigins);
    if (enabling) origins.add(origin);
    else origins.delete(origin);

    const updated = await writeSettings({ ...settings, enabledOrigins: [...origins] });
    await syncDynamicContentScripts(updated);
    await broadcastSettings(updated);
    return { ok: true, kind: 'settings', settings: updated };
  }

  if (hasKind(payload, 'backend:health')) {
    const settings = await readSettings();
    try {
      const health = await checkHealth(settings);
      return {
        ok: true,
        kind: 'health',
        providers: health.providers ?? [],
        activeProvider: health.activeProvider || settings.provider || 'unknown',
      };
    } catch (error) {
      return toFailure(error);
    }
  }

  return failure('Unsupported message.', 'bad_request');
}

async function answerQuestion(payload: Record<string, unknown>): Promise<WorkerResponse> {
  const settings = await readSettings();
  const state = await ensureResumedAt();
  const ready = readiness(state, settings);

  if (ready.status === 'disabled') {
    return failure('Automatic detection is switched off.', 'disabled');
  }
  if (ready.status === 'paused') {
    return failure('The extension is paused.', 'paused');
  }
  if (ready.status === 'starting') {
    return {
      ok: false,
      code: 'warming_up',
      error: 'Waiting for the start delay to elapse.',
      retryAfterMs: ready.startsInMs,
    };
  }

  const request = validateRequest(payload.request);
  if (!request) return failure('The detected question was not usable.', 'bad_request');

  const fingerprint = typeof payload.fingerprint === 'string' ? payload.fingerprint : '';
  const cacheKey = `${settings.provider}:${settings.model}:${fingerprint}`;

  if (settings.cacheEnabled && fingerprint) {
    const cached = cache.get(cacheKey);
    if (cached) {
      await record(request, settings, {
        fingerprint,
        answer: cached.answer,
        provider: cached.provider,
        model: cached.model,
        latencyMs: 0,
        outcome: 'cached',
      });
      return { ok: true, kind: 'answer', answer: cached, cached: true };
    }
  }

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const work = (async (): Promise<WorkerResponse> => {
    try {
      // Pacing happens after the cache lookup: a cached answer costs nothing,
      // so it should not consume a slot or make the user wait.
      await pacer.take(settings.answerDelayMs);

      const startedAt = Date.now();
      const answer = await requestAnswer(request, settings);
      const latencyMs = Date.now() - startedAt;

      if (settings.cacheEnabled && fingerprint) cache.set(cacheKey, answer);

      await record(request, settings, {
        fingerprint,
        answer: answer.answer,
        provider: answer.provider,
        model: answer.model,
        latencyMs,
        outcome: 'answered',
      });

      return { ok: true, kind: 'answer', answer, cached: false };
    } catch (error) {
      const response = toFailure(error);
      await record(request, settings, {
        fingerprint,
        answer: '',
        provider: settings.provider || 'backend default',
        model: settings.model || 'backend default',
        latencyMs: 0,
        outcome: 'error',
        error: response.ok ? undefined : response.error,
      });
      return response;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, work);
  return work;
}

interface RecordFields {
  fingerprint: string;
  answer: string;
  provider: string;
  model: string;
  latencyMs: number;
  outcome: ActivityOutcome;
  error?: string | undefined;
}

async function record(
  request: QuestionRequest,
  settings: ExtensionSettings,
  fields: RecordFields,
): Promise<void> {
  if (!settings.logEnabled) return;

  const url = request.source?.url ?? '';
  await activityLog.append(
    {
      at: Date.now(),
      origin: originOf(url),
      url,
      title: request.source?.title ?? '',
      fingerprint: fields.fingerprint,
      type: request.type,
      optionCount: request.options?.length ?? 0,
      question: request.question,
      answer: fields.answer,
      provider: fields.provider,
      model: fields.model,
      latencyMs: fields.latencyMs,
      outcome: fields.outcome,
      ...(fields.error ? { error: fields.error } : {}),
    },
    settings.logLimit,
  );
}

async function runtimeStatus(): Promise<RuntimeStatus> {
  const [settings, state, stats] = await Promise.all([
    readSettings(),
    readRunState(),
    activityLog.stats(),
  ]);
  const ready = readiness(state, settings);

  return {
    status: ready.status,
    startsInMs: ready.startsInMs,
    answeredTotal: stats.total,
    answeredToday: stats.today,
    lastActivityAt: stats.lastAt,
  };
}

/**
 * Re-validate the question on this side of the message boundary: the content
 * script runs alongside page code and its output is treated as untrusted.
 */
function validateRequest(value: unknown): QuestionRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Record<string, unknown>;

  const question = typeof input.question === 'string' ? input.question.trim() : '';
  if (question.length < LIMITS.minQuestionLength || question.length > LIMITS.maxQuestionLength) {
    return null;
  }

  const type = QUESTION_TYPES.includes(input.type as QuestionType)
    ? (input.type as QuestionType)
    : 'unknown';

  const request: QuestionRequest = { question, type };

  if (Array.isArray(input.options)) {
    const options = input.options
      .filter((option): option is string => typeof option === 'string')
      .map((option) => option.slice(0, LIMITS.maxOptionLength))
      .slice(0, LIMITS.maxOptions);
    if (options.length >= 2) request.options = options;
  }

  if (typeof input.context === 'string' && input.context.trim()) {
    request.context = input.context.slice(0, LIMITS.maxContextLength);
  }

  if (typeof input.source === 'object' && input.source !== null) {
    const source = input.source as Record<string, unknown>;
    const url = typeof source.url === 'string' ? source.url.slice(0, 2000) : undefined;
    const title = typeof source.title === 'string' ? source.title.slice(0, 300) : undefined;
    if (url || title) request.source = { ...(url ? { url } : {}), ...(title ? { title } : {}) };
  }

  return request;
}

/**
 * Register content scripts for the origins the user opted in to, and drop the
 * ones they removed. Origins the user has not granted are skipped rather than
 * prompting, since a service worker cannot request permissions on its own.
 */
async function syncDynamicContentScripts(preloaded?: ExtensionSettings): Promise<void> {
  const settings = preloaded ?? (await readSettings());
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const existing = registered.find((script) => script.id === 'user-origins');

  const matches: string[] = [];
  for (const origin of settings.enabledOrigins) {
    // Skip anything the manifest already injects into, or the content script
    // would run twice on the same page and ask every question twice.
    if (isStaticallyInjected(origin)) continue;

    const pattern = `${origin}/*`;
    if (await chrome.permissions.contains({ origins: [pattern] })) matches.push(pattern);
  }

  if (matches.length === 0) {
    if (existing) await chrome.scripting.unregisterContentScripts({ ids: ['user-origins'] });
    return;
  }

  const script: chrome.scripting.RegisteredContentScript = {
    id: 'user-origins',
    js: ['content.js'],
    matches,
    runAt: 'document_idle',
    allFrames: false,
  };

  if (existing) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

/** A small badge so the toolbar shows at a glance when nothing will happen. */
async function refreshBadge(): Promise<void> {
  const status = await runtimeStatus();
  const text = status.status === 'running' ? '' : status.status === 'starting' ? '…' : '||';
  const colour = status.status === 'starting' ? '#b45309' : '#6b7280';

  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color: colour });
  } catch {
    // The action API is unavailable in some contexts; the badge is cosmetic.
  }
}

async function broadcast(message: unknown): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.tabs.sendMessage(tab.id, envelope(message));
      } catch {
        // No content script in that tab; nothing to update.
      }
    }),
  );
}

function broadcastSettings(settings: ExtensionSettings): Promise<void> {
  return broadcast({ kind: 'settings:changed', settings });
}

function broadcastRun(status: RuntimeStatus): Promise<void> {
  return broadcast({ kind: 'run:changed', status });
}

/** True when the message came from one of the extension's own pages. */
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  const base = chrome.runtime.getURL('');
  return typeof sender.url === 'string' && sender.url.startsWith(base);
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function originOf(url: string): string {
  return normalizeOrigin(url) ?? '';
}

function toFailure(error: unknown): WorkerResponse {
  if (error instanceof BackendError) return failure(error.message, error.code);
  return failure(error instanceof Error ? error.message : 'Unexpected error.', 'unknown');
}

function failure(message: string, code: WorkerErrorCode): WorkerResponse {
  return { ok: false, error: message, code };
}

export { sanitize };
