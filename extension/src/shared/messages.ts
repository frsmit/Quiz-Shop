/**
 * The message envelope exchanged over `chrome.runtime` message passing.
 *
 * Content scripts share a world with the page, so every inbound message is
 * treated as untrusted: the service worker validates the discriminant and the
 * payload shape before acting, and never echoes backend configuration back.
 */
import type {
  ActivityEntry,
  ActivityOutcome,
  ActivityStats,
  DetectedQuestion,
  ExtensionSettings,
  QuestionAnswer,
  QuestionRequest,
  RuntimeStatus,
  ServerHistoryPage,
  ServerPersistence,
  ServerStats,
} from './types';

export const MESSAGE_SOURCE = 'ai-browser-assistant' as const;

export type ContentToWorkerMessage =
  | { kind: 'question:detected'; fingerprint: string; request: QuestionRequest }
  | { kind: 'answer:applied'; fingerprint: string; outcome: ActivityOutcome }
  | { kind: 'settings:get' };

export type WorkerToContentMessage =
  | { kind: 'settings:changed'; settings: ExtensionSettings }
  | { kind: 'run:changed'; status: RuntimeStatus };

export type UiToWorkerMessage =
  | { kind: 'settings:get' }
  | { kind: 'settings:save'; settings: ExtensionSettings }
  | { kind: 'backend:health' }
  | { kind: 'cache:clear' }
  | { kind: 'run:get' }
  | { kind: 'run:pause' }
  | { kind: 'run:resume' }
  | { kind: 'log:list'; limit?: number }
  | { kind: 'log:stats' }
  | { kind: 'log:clear' }
  | { kind: 'history:list'; limit?: number; before?: string }
  | { kind: 'history:stats' }
  | { kind: 'history:clear' }
  | { kind: 'site:enable'; origin: string }
  | { kind: 'site:disable'; origin: string };

export type WorkerMessage = ContentToWorkerMessage | UiToWorkerMessage;

export type WorkerResponse =
  | { ok: true; kind: 'answer'; answer: QuestionAnswer; cached: boolean }
  | { ok: true; kind: 'settings'; settings: ExtensionSettings }
  | {
      ok: true;
      kind: 'health';
      providers: string[];
      activeProvider: string;
      /** Absent from backends that predate persistence. */
      persistence?: ServerPersistence;
    }
  | { ok: true; kind: 'history'; page: ServerHistoryPage }
  | { ok: true; kind: 'server-stats'; stats: ServerStats }
  | { ok: true; kind: 'history-cleared'; deleted: number }
  | { ok: true; kind: 'run'; status: RuntimeStatus }
  | { ok: true; kind: 'log'; entries: ActivityEntry[] }
  | { ok: true; kind: 'stats'; stats: ActivityStats }
  | { ok: true; kind: 'ack' }
  | { ok: false; error: string; code: WorkerErrorCode; retryAfterMs?: number };

export type WorkerErrorCode =
  | 'bad_request'
  | 'disabled'
  | 'paused'
  | 'warming_up'
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'provider_error'
  | 'unknown';

/** Failures worth retrying on a later scan rather than giving up on. */
export const RETRYABLE_CODES: ReadonlySet<WorkerErrorCode> = new Set([
  'network',
  'timeout',
  'paused',
  'warming_up',
  'rate_limited',
]);

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
