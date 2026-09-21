/**
 * The extension's only outbound network surface: the Express backend.
 *
 * Provider credentials never reach the browser, so this client speaks to our
 * own API and nothing else. Failures are mapped onto a small set of codes the
 * content script and options page can act on.
 */
import type { ExtensionSettings, QuestionAnswer, QuestionRequest } from '../shared/types';
import type { WorkerErrorCode } from '../shared/messages';

export class BackendError extends Error {
  constructor(
    message: string,
    readonly code: WorkerErrorCode,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export interface HealthResponse {
  status: string;
  activeProvider: string;
  providers: string[];
}

interface AnswerEnvelope {
  data?: QuestionAnswer;
  error?: { message?: string; code?: string };
}

export async function requestAnswer(
  request: QuestionRequest,
  settings: ExtensionSettings,
): Promise<QuestionAnswer> {
  const body: Record<string, unknown> = { ...request };
  if (settings.provider) body.provider = settings.provider;
  if (settings.model) body.model = settings.model;

  const payload = await call<AnswerEnvelope>(
    '/api/questions/answer',
    { method: 'POST', body: JSON.stringify(body) },
    settings,
  );

  if (!payload.data || typeof payload.data.answer !== 'string') {
    throw new BackendError('The backend returned a malformed answer.', 'provider_error');
  }
  return payload.data;
}

export async function checkHealth(settings: ExtensionSettings): Promise<HealthResponse> {
  return call<HealthResponse>('/api/health', { method: 'GET' }, settings);
}

async function call<T>(path: string, init: RequestInit, settings: ExtensionSettings): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.requestTimeoutMs);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body) headers['Content-Type'] = 'application/json';
  if (settings.backendApiKey) headers['x-api-key'] = settings.backendApiKey;

  let response: Response;
  try {
    response = await fetch(`${settings.backendUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
      credentials: 'omit',
      mode: 'cors',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new BackendError('The backend did not respond in time.', 'timeout');
    }
    throw new BackendError(
      `Could not reach the backend at ${settings.backendUrl}.`,
      'network',
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  const parsed = safeJsonParse(text);

  if (!response.ok) {
    const message =
      (parsed as AnswerEnvelope | null)?.error?.message ??
      `Backend responded with ${response.status}.`;
    throw new BackendError(message, mapStatus(response.status));
  }

  if (parsed === null) {
    throw new BackendError('The backend returned a response that was not JSON.', 'provider_error');
  }
  return parsed as T;
}

function mapStatus(status: number): WorkerErrorCode {
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 401 || status === 403) return 'bad_request';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_error';
  return 'unknown';
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
