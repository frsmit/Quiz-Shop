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
import { searchRoots } from './dom';

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

/**
 * Failed attempts per question for faults that carry no retry time of their
 * own (a timeout, the backend unreachable, rate limiting). Capped so a
 * backend that stays down costs a few requests, not one every few seconds.
 */
const failures = new Map<string, number>();
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 5_000;

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

/** Questions being filled right now; a rescan mid-fill must not click again. */
const filling = new Set<string>();

/**
 * Questions the page would not let us select. Re-filling them on every
 * rescan would only repeat the same clicks, so they are left alone.
 */
const notApplied = new Set<string>();

/** Put an answer into the page and tell the worker how it went. */
function fill(question: DetectedQuestion, answer: QuestionAnswer): void {
  if (!settings?.autoFill || !question.container.isConnected) return;
  const { fingerprint } = question;
  if (filling.has(fingerprint) || notApplied.has(fingerprint)) return;

  filling.add(fingerprint);
  void applyAnswer(question.container, answer, question.controls)
    .catch((): ActivityOutcome => 'not-applied')
    .then((outcome) => {
      if (outcome === 'not-applied') notApplied.add(fingerprint);
      return send({ kind: 'answer:applied', fingerprint, outcome });
    })
    .finally(() => filling.delete(fingerprint));
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
      if (typeof response.retryAfterMs === 'number') {
        processed.delete(question.fingerprint);
        scheduleRetry(response.retryAfterMs);
      } else if (response.code === 'paused') {
        // Resuming broadcasts `run:changed`, which rescans.
        processed.delete(question.fingerprint);
      } else {
        // Nothing else will prompt a rescan - on a one-question page the DOM
        // may never change again - so schedule one, backing off, and stop
        // after a few attempts rather than retrying forever.
        const attempts = (failures.get(question.fingerprint) ?? 0) + 1;
        failures.set(question.fingerprint, attempts);
        if (attempts < MAX_ATTEMPTS) {
          processed.delete(question.fingerprint);
          scheduleRetry(RETRY_BASE_MS * 2 ** (attempts - 1));
        }
      }
    }
    return;
  }

  if (response.kind !== 'answer') return;

  failures.delete(question.fingerprint);
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

    // Shadow roots are only found by walking the page; watch each one found
    // so components that render their options later are rescanned too.
    for (const scope of searchRoots(document).slice(1)) observer.watch(scope);

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
