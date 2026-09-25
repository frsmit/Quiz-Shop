/**
 * Types shared by the content script, the service worker, the popup and the
 * options page. The request/answer shapes mirror the Zod schemas the backend
 * validates against (`server/src/question/question.schema.ts`) - keep them in
 * step.
 */

export type QuestionType =
  | 'multiple_choice'
  | 'short_answer'
  | 'programming'
  | 'mathematical'
  | 'unknown';

export interface QuestionSource {
  url?: string;
  title?: string;
}

/** The normalised payload sent to the backend. Nothing else leaves the page. */
export interface QuestionRequest {
  question: string;
  type: QuestionType;
  options?: string[];
  context?: string;
  source?: QuestionSource;
}

/** The structured answer the backend guarantees, whichever provider ran. */
export interface QuestionAnswer {
  answer: string;
  explanation: string;
  confidence?: number;
  reasoningSummary?: string;
  provider: string;
  model: string;
}

export type ProviderId = 'openai' | 'gemini' | 'anthropic' | 'openai-compatible';

/**
 * What the user picked in the options page. The empty string means "whatever
 * the backend is configured to use", and is the default: the extension should
 * not silently override a backend that has already been set up.
 */
export type ProviderChoice = ProviderId | '';

export interface ExtensionSettings {
  /** Which provider to use, or '' to let the backend decide. */
  provider: ProviderChoice;
  /** Optional model override; empty means "use the backend default". */
  model: string;
  /** Base URL of the Express backend, without a trailing slash. */
  backendUrl: string;
  /** Optional shared secret, sent as `x-api-key` when the backend requires it. */
  backendApiKey: string;
  /** Watch pages and answer questions as they appear. */
  autoDetect: boolean;
  /** Fill the answer into the page's own controls. Never clicks anything. */
  autoFill: boolean;
  /** Upper bound on surrounding context characters sent with a question. */
  maxContextLength: number;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Reuse answers for questions already seen. */
  cacheEnabled: boolean;

  /**
   * How long to wait after resuming before answering the first question.
   * Lets you open a page and read it yourself before help arrives. 0 = none.
   */
  startDelayMs: number;
  /**
   * Minimum gap between two answers, across every tab. Paces the extension so
   * a page full of questions cannot become a burst of provider calls.
   */
  answerDelayMs: number;

  /** Record activity to the local log. */
  logEnabled: boolean;
  /** How many log entries to keep before the oldest are dropped. */
  logLimit: number;

  /** Origins the user has explicitly opted in to, e.g. `https://example.com`. */
  enabledOrigins: string[];
}

/** A question located in the DOM, before it is normalised for transport. */
export interface DetectedQuestion {
  /** Stable hash of the normalised question text and options. */
  fingerprint: string;
  request: QuestionRequest;
  /** The element that owns the question, used to locate answer controls. */
  container: HTMLElement;
}

/**
 * Whether the extension is answering right now, and why not if it is not.
 * Derived state - the popup renders it directly.
 */
export type RunStatus = 'running' | 'paused' | 'starting' | 'disabled';

export interface RunState {
  /** User-controlled pause, from the toolbar popup. */
  paused: boolean;
  /** When the extension was last resumed; the start delay counts from here. */
  resumedAt: number;
}

export interface RuntimeStatus {
  status: RunStatus;
  /** Milliseconds until the start delay elapses; 0 once running. */
  startsInMs: number;
  /** Questions answered since the extension was installed. */
  answeredTotal: number;
  /** Questions answered in the last 24 hours. */
  answeredToday: number;
  lastActivityAt: number | null;
}

export type ActivityOutcome =
  | 'answered'
  | 'cached'
  | 'filled'
  | 'no-match'
  | 'no-control'
  | 'skipped'
  | 'error';

/**
 * One line in the activity log.
 *
 * Question and answer text are recorded so the monitoring page is useful for
 * working out why a site was or was not handled. The log lives in
 * `chrome.storage.local` and is never transmitted.
 */
export interface ActivityEntry {
  id: string;
  at: number;
  origin: string;
  url: string;
  title: string;
  fingerprint: string;
  type: QuestionType;
  optionCount: number;
  question: string;
  answer: string;
  provider: string;
  model: string;
  latencyMs: number;
  outcome: ActivityOutcome;
  error?: string;
  /** Present on entries that came from the backend's history. */
  explanation?: string;
}

export interface ActivityStats {
  total: number;
  today: number;
  errors: number;
  cached: number;
  lastAt: number | null;
  /** Answer counts keyed by origin, most recent first. */
  byOrigin: Array<{ origin: string; count: number }>;
}

/**
 * The backend's own question history (only when it has MongoDB configured).
 * Narrower than `ActivityEntry`: the server records answers it produced, so
 * it knows nothing of page-side outcomes, page URLs or titles.
 */
export interface ServerHistoryEntry {
  id: string;
  createdAt: string;
  question: string;
  type: QuestionType;
  options?: string[];
  answer: string;
  explanation: string;
  confidence?: number;
  provider: string;
  model: string;
  cached: boolean;
  latencyMs: number;
  origin?: string;
}

export interface ServerHistoryPage {
  /** False when the backend keeps no history; entries are then empty. */
  enabled: boolean;
  entries: ServerHistoryEntry[];
  /** Cursor for the next (older) page; absent on the last one. */
  nextBefore?: string;
}

export interface ServerStats {
  enabled: boolean;
  total: number;
  today: number;
  cached: number;
  averageLatencyMs: number;
  byProvider: Array<{ provider: string; model: string; count: number }>;
  byType: Array<{ type: string; count: number }>;
  topOrigins: Array<{ origin: string; count: number }>;
}

/** What `/api/health` says about the backend's storage. */
export interface ServerPersistence {
  database: 'connected' | 'unreachable' | 'not_configured';
  cache: 'mongodb' | 'memory' | 'off';
  history: boolean;
}
