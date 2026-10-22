/**
 * The boundary every AI vendor sits behind.
 *
 * Nothing above this line - the controller, the question service, the
 * extension - knows which company answers a question. Adding a vendor means
 * adding an adapter and registering it with the factory; no detection or
 * transport code changes.
 */
import type { QuestionAnswer, QuestionRequest } from '../question/question.schema.js';

export interface AIProvider {
  /** Stable identifier reported back to the client, e.g. `openai`. */
  getName(): string;

  /** The model this instance will use, after applying any override. */
  getModel(): string;

  answerQuestion(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionAnswer>;
}

/** Everything an adapter needs to construct itself. */
export interface ProviderContext {
  /** Model override from the request or `AI_MODEL`; adapters supply a default. */
  model?: string | undefined;
  timeoutMs: number;
}

/**
 * A provider key supplied by the caller for one request - the user's own,
 * entered in the extension's settings - in place of the server's.
 */
export interface ClientCredentials {
  apiKey: string;
  /** OpenAI-compatible endpoints only; other providers ignore it. */
  baseUrl?: string | undefined;
}
