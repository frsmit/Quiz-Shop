/**
 * MV3 service worker: the extension's orchestrator.
 *
 * Content scripts share an origin with untrusted page code, so the worker owns
 * everything sensitive - settings, the backend URL, the optional backend key -
 * and validates every inbound message before acting on it. Content scripts
 * receive answers, never configuration they did not ask for.
 */
import { envelope, hasKind, isEnvelope } from '../shared/messages';
import type { WorkerErrorCode, WorkerResponse } from '../shared/messages';
import { LIMITS } from '../shared/constants';
import type { ExtensionSettings, QuestionRequest, QuestionType } from '../shared/types';
import { BackendError, checkHealth, requestAnswer } from './backend-client';
import { createAnswerCache } from './cache';
import { readSettings, sanitize, writeSettings } from './settings';

const cache = createAnswerCache();

/** In-flight requests, so two tabs asking the same question make one call. */
const inFlight = new Map<string, Promise<WorkerResponse>>();

const QUESTION_TYPES: readonly QuestionType[] = [
  'multiple_choice',
  'short_answer',
  'programming',
  'mathematical',
  'unknown',
];

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    // Normalise whatever is in storage so later reads have every field.
    await writeSettings(await readSettings());
    await syncDynamicContentScripts();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void syncDynamicContentScripts();
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
  if (hasKind(payload, 'settings:get')) {
    return { ok: true, kind: 'settings', settings: await readSettings() };
  }

  if (hasKind(payload, 'settings:save')) {
    if (isFromContentScript(sender)) {
      return failure('Settings can only be changed from the options page.', 'bad_request');
    }
    const settings = await writeSettings(payload.settings);
    await syncDynamicContentScripts(settings);
    await broadcastSettings(settings);
    return { ok: true, kind: 'settings', settings };
  }

  if (hasKind(payload, 'cache:clear')) {
    cache.clear();
    return { ok: true, kind: 'ack' };
  }

  if (hasKind(payload, 'backend:health')) {
    const settings = await readSettings();
    try {
      const health = await checkHealth(settings);
      return {
        ok: true,
        kind: 'health',
        providers: health.providers ?? [],
        activeProvider: health.activeProvider ?? settings.provider,
      };
    } catch (error) {
      return toFailure(error);
    }
  }

  if (hasKind(payload, 'question:detected')) {
    return answerQuestion(payload);
  }

  return failure('Unsupported message.', 'bad_request');
}

async function answerQuestion(payload: Record<string, unknown>): Promise<WorkerResponse> {
  const settings = await readSettings();
  if (!settings.autoDetect) return failure('Automatic detection is switched off.', 'disabled');

  const request = validateRequest(payload.request);
  if (!request) return failure('The detected question was not usable.', 'bad_request');

  const fingerprint = typeof payload.fingerprint === 'string' ? payload.fingerprint : '';
  const cacheKey = `${settings.provider}:${settings.model}:${fingerprint}`;

  if (settings.cacheEnabled && fingerprint) {
    const cached = cache.get(cacheKey);
    if (cached) return { ok: true, kind: 'answer', answer: cached, cached: true };
  }

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const work = (async (): Promise<WorkerResponse> => {
    try {
      const answer = await requestAnswer(request, settings);
      if (settings.cacheEnabled && fingerprint) cache.set(cacheKey, answer);
      return { ok: true, kind: 'answer', answer, cached: false };
    } catch (error) {
      return toFailure(error);
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, work);
  return work;
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

/** Tell any listening content script that settings changed. */
async function broadcastSettings(settings: ExtensionSettings): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.tabs.sendMessage(tab.id, envelope({ kind: 'settings:changed', settings }));
      } catch {
        // No content script in that tab; nothing to update.
      }
    }),
  );
}

function isFromContentScript(sender: chrome.runtime.MessageSender): boolean {
  return sender.tab !== undefined;
}

function toFailure(error: unknown): WorkerResponse {
  if (error instanceof BackendError) return failure(error.message, error.code);
  return failure(error instanceof Error ? error.message : 'Unexpected error.', 'unknown');
}

function failure(message: string, code: WorkerErrorCode): WorkerResponse {
  return { ok: false, error: message, code };
}

export { sanitize };
