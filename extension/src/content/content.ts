/**
 * Content script entry point.
 *
 * Runs in the page's DOM but in an isolated world: it reads the document,
 * hands normalised questions to the service worker, and optionally writes the
 * answer back into the page's own controls. It renders no UI of its own - the
 * page should look exactly as it did before the extension was installed - and
 * it never exposes the backend URL, credentials or message channel to page
 * JavaScript.
 *
 * It fills answers in and stops there. It never clicks Next, Submit or any
 * other control that would commit an answer or navigate on the user's behalf.
 */
import { RETRYABLE_CODES, envelope, isEnvelope } from '../shared/messages';
import type { ContentToWorkerMessage, WorkerResponse } from '../shared/messages';
import type { ActivityOutcome, DetectedQuestion, ExtensionSettings, QuestionAnswer } from '../shared/types';
import { detectQuestions } from './detector';
import { applyAnswer } from './interaction';
import { createPageObserver } from './observer';

/** Fingerprints already sent; prevents re-asking after a re-render. */
const processed = new Set<string>();

/**
 * Answers already received, kept for the page's lifetime.
 *
 * On a site that shows one question per page, going back to a question that
 * was already answered should re-fill it without another request - the DOM is
 * new, but the question is not.
 */
const answers = new Map<string, QuestionAnswer>();

let settings: ExtensionSettings | null = null;
let scanning = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

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

/** Schedule one more scan, replacing any scan already scheduled. */
function scheduleRetry(delayMs: number): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void scan();
  }, Math.max(500, Math.min(delayMs, 5 * 60 * 1000)));
}

/** Put an answer into the page and tell the worker how it went. */
function fill(question: DetectedQuestion, answer: QuestionAnswer): void {
  if (!settings?.autoFill || !question.container.isConnected) return;
  const outcome = applyAnswer(question.container, answer) as ActivityOutcome;
  void send({ kind: 'answer:applied', fingerprint: question.fingerprint, outcome });
}

async function resolveQuestion(question: DetectedQuestion): Promise<void> {
  const response = await send({
    kind: 'question:detected',
    fingerprint: question.fingerprint,
    request: question.request,
  });

  if (!response) {
    processed.delete(question.fingerprint);
    return;
  }

  if (!response.ok) {
    if (RETRYABLE_CODES.has(response.code)) {
      // Paused, warming up or a transient network fault: let a later scan
      // pick the question up again rather than losing it.
      processed.delete(question.fingerprint);
      if (typeof response.retryAfterMs === 'number') scheduleRetry(response.retryAfterMs);
    }
    return;
  }

  if (response.kind !== 'answer') return;

  answers.set(question.fingerprint, response.answer);
  fill(question, response.answer);
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
      const known = answers.get(question.fingerprint);
      if (known) {
        // Re-rendered, or the user navigated back to it. Fill it in again
        // without asking anyone.
        fill(question, known);
        continue;
      }

      if (processed.has(question.fingerprint)) continue;
      processed.add(question.fingerprint);

      // Pacing between answers is enforced by the service worker, so that it
      // holds across every tab rather than per page.
      void resolveQuestion(question);
    }
  } finally {
    scanning = false;
  }
}

const observer = createPageObserver({ onScan: () => void scan() });

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isEnvelope(message)) return undefined;
  const payload = message.payload;

  if (payload.kind === 'settings:changed' && typeof payload.settings === 'object') {
    settings = payload.settings as ExtensionSettings;
    // Keep the answers: they are still valid, and re-filling is free.
    processed.clear();
    if (settings.autoDetect) observer.schedule();
    return undefined;
  }

  if (payload.kind === 'run:changed') {
    // Resumed, or the start delay elapsed - try anything that was skipped.
    processed.clear();
    observer.schedule();
  }

  return undefined;
});

void (async () => {
  const loaded = await loadSettings();
  if (!loaded) return;
  observer.start();
})();
