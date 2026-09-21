/**
 * Types shared by the content script, the service worker and the options page.
 * The request/answer shapes mirror the Zod schemas the backend validates
 * against (`server/src/question/question.schema.ts`) - keep them in step.
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

export interface ExtensionSettings {
  /** Which provider the backend should use for this request. */
  provider: ProviderId;
  /** Optional model override; empty means "use the backend default". */
  model: string;
  /** Base URL of the Express backend, without a trailing slash. */
  backendUrl: string;
  /** Optional shared secret, sent as `x-api-key` when the backend requires it. */
  backendApiKey: string;
  /** Watch the page and answer questions as they appear. */
  autoDetect: boolean;
  /** Fill the detected answer into the page's own controls. */
  autoFill: boolean;
  /** Upper bound on surrounding context characters sent with a question. */
  maxContextLength: number;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Reuse answers for questions already seen in this browser session. */
  cacheEnabled: boolean;
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

export interface AnswerRecord {
  fingerprint: string;
  answer: QuestionAnswer;
  receivedAt: number;
}
