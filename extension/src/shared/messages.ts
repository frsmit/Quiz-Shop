/**
 * The message envelope exchanged over `chrome.runtime` message passing.
 *
 * Content scripts share a world with the page, so every inbound message is
 * treated as untrusted: the service worker validates the discriminant and the
 * payload shape before acting, and never echoes backend configuration back.
 */
import type { DetectedQuestion, ExtensionSettings, QuestionAnswer, QuestionRequest } from './types';

export const MESSAGE_SOURCE = 'ai-browser-assistant' as const;

export type ContentToWorkerMessage =
  | { kind: 'question:detected'; fingerprint: string; request: QuestionRequest }
  | { kind: 'settings:get' };

export type WorkerToContentMessage = { kind: 'settings:changed'; settings: ExtensionSettings };

export type OptionsToWorkerMessage =
  | { kind: 'settings:get' }
  | { kind: 'settings:save'; settings: ExtensionSettings }
  | { kind: 'backend:health' }
  | { kind: 'cache:clear' };

export type WorkerMessage = ContentToWorkerMessage | OptionsToWorkerMessage;

export type WorkerResponse =
  | { ok: true; kind: 'answer'; answer: QuestionAnswer; cached: boolean }
  | { ok: true; kind: 'settings'; settings: ExtensionSettings }
  | { ok: true; kind: 'health'; providers: string[]; activeProvider: string }
  | { ok: true; kind: 'ack' }
  | { ok: false; error: string; code: WorkerErrorCode };

export type WorkerErrorCode =
  | 'bad_request'
  | 'disabled'
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'provider_error'
  | 'unknown';

export interface Envelope<T> {
  source: typeof MESSAGE_SOURCE;
  payload: T;
}

export function envelope<T>(payload: T): Envelope<T> {
  return { source: MESSAGE_SOURCE, payload };
}

/** Narrow an unknown `chrome.runtime.onMessage` value to our envelope. */
export function isEnvelope(value: unknown): value is Envelope<Record<string, unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Envelope<unknown>).source === MESSAGE_SOURCE &&
    typeof (value as Envelope<unknown>).payload === 'object' &&
    (value as Envelope<unknown>).payload !== null
  );
}

/** Type guard for the discriminant only; payload fields are validated later. */
export function hasKind<K extends string>(
  payload: Record<string, unknown>,
  kind: K,
): payload is Record<string, unknown> & { kind: K } {
  return payload.kind === kind;
}

export type { DetectedQuestion };
