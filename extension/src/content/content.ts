/**
 * Content script entry point.
 *
 * Runs in the page's DOM but in an isolated world: it reads the document,
 * hands normalised questions to the service worker, and optionally writes the
 * answer back into the page's own controls. It renders no UI of its own - the
 * page should look exactly as it did before the extension was installed - and
 * it never exposes the backend URL, credentials or message channel to page
 * JavaScript.
 */
import { REQUEST_THROTTLE_MS } from '../shared/constants';
import { envelope, isEnvelope } from '../shared/messages';
import type { ContentToWorkerMessage, WorkerResponse } from '../shared/messages';
import type { DetectedQuestion, ExtensionSettings } from '../shared/types';
import { detectQuestions } from './detector';
import { applyAnswer } from './interaction';
import { createPageObserver } from './observer';

/** Fingerprints already sent this page-load; prevents re-asking on re-render. */
const processed = new Set<string>();

let settings: ExtensionSettings | null = null;
let lastRequestAt = 0;
let scanning = false;

async function send(message: ContentToWorkerMessage): Promise<WorkerResponse | null> {
  try {
    const response = (await chrome.runtime.sendMessage(envelope(message))) as unknown;
    return isWorkerResponse(response) ? response : null;
  } catch {
    // The worker is asleep or the extension was reloaded; the next scan retries.
    return null;
  }
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

async function loadSettings(): Promise<ExtensionSettings | null> {
  const response = await send({ kind: 'settings:get' });
  if (response?.ok && response.kind === 'settings') {
    settings = response.settings;
    return settings;
  }
  return null;
}

/** Ask the worker about one question and apply the answer if configured to. */
async function resolveQuestion(question: DetectedQuestion): Promise<void> {
  const response = await send({
    kind: 'question:detected',
    fingerprint: question.fingerprint,
    request: question.request,
  });

  if (!response) {
    // Allow a later scan to retry a question the worker never saw.
    processed.delete(question.fingerprint);
    return;
  }

  if (!response.ok) {
    if (response.code === 'network' || response.code === 'timeout') {
      processed.delete(question.fingerprint);
    }
    return;
  }

  if (response.kind !== 'answer') return;

  if (settings?.autoFill && question.container.isConnected) {
    applyAnswer(question.container, response.answer);
  }
}

async function scan(): Promise<void> {
  if (scanning) return;
  const current = settings;
  if (!current?.autoDetect) return;

  scanning = true;
  try {
    const questions = detectQuestions(document, {
      maxContextLength: current.maxContextLength,
      url: location.href,
      title: document.title,
    });

    for (const question of questions) {
      if (processed.has(question.fingerprint)) continue;
      processed.add(question.fingerprint);

      // Space requests out so a page that renders twenty questions at once
      // cannot turn into twenty simultaneous provider calls.
      const wait = Math.max(0, lastRequestAt + REQUEST_THROTTLE_MS - Date.now());
      lastRequestAt = Date.now() + wait;
      if (wait > 0) await sleep(wait);

      void resolveQuestion(question);
    }
  } finally {
    scanning = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const observer = createPageObserver({ onScan: () => void scan() });

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isEnvelope(message)) return undefined;
  const payload = message.payload;
  if (payload.kind === 'settings:changed' && typeof payload.settings === 'object') {
    settings = payload.settings as ExtensionSettings;
    processed.clear();
    if (settings.autoDetect) observer.schedule();
  }
  return undefined;
});

void (async () => {
  const loaded = await loadSettings();
  if (!loaded) return;
  observer.start();
})();
