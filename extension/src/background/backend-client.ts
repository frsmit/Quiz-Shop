/**
 * The extension's only outbound network surface: the Express backend.
 *
 * It speaks to our own API and nothing else - not even when the user has
 * entered their own provider key: the key travels to the backend in a header,
 * and the backend makes the provider call. Failures are mapped onto a small
 * set of codes the content script and options page can act on.
 */
import type {
  ExtensionSettings,
  ProviderInfo,
  ProviderTestResult,
  QuestionAnswer,
  QuestionRequest,
  ServerHistoryEntry,
  ServerHistoryPage,
  ServerPersistence,
  ServerStats,
} from '../shared/types';
import type { WorkerErrorCode } from '../shared/messages';

export class BackendError extends Error {
  constructor(
    message: string,
    readonly code: WorkerErrorCode,
    /** How long the backend asked us to wait (a provider rate limit). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export interface HealthResponse {
  status: string;
  activeProvider: string;
  providers: string[];
  /** Every provider the backend knows, with its default model. */
  allProviders?: ProviderInfo[];
  /** Whether the backend uses a key entered in the extension. */
  clientCredentials?: boolean;
  persistence?: ServerPersistence;
}

interface ListEnvelope<T> {
  data?: T;
  meta?: { enabled?: boolean };
}

interface AnswerEnvelope {
  data?: QuestionAnswer;
  error?: { message?: string; code?: string; retryAfterMs?: number };
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
    providerHeaders(settings),
  );

  if (!payload.data || typeof payload.data.answer !== 'string') {
    throw new BackendError('The backend returned a malformed answer.', 'provider_error');
  }
  return payload.data;
}

/**
 * Ask the chosen provider one small question through the backend, so a key or
 * model can be checked from the settings page before it is saved.
 */
export async function testProvider(settings: ExtensionSettings): Promise<ProviderTestResult> {
  const body: Record<string, unknown> = {};
  if (settings.provider) body.provider = settings.provider;
  if (settings.model) body.model = settings.model;

  const payload = await call<{ data?: ProviderTestResult }>(
    '/api/providers/test',
    { method: 'POST', body: JSON.stringify(body) },
    settings,
    providerHeaders(settings),
  );
  if (!payload.data || typeof payload.data.provider !== 'string') {
    throw new BackendError('The backend returned a malformed test result.', 'provider_error');
  }
  return payload.data;
}

/**
 * The user's own key, for the provider they picked. With "use the backend's
 * provider" selected the backend's own key applies, so nothing is sent.
 */
function providerHeaders(settings: ExtensionSettings): Record<string, string> {
  if (!settings.provider || !settings.aiApiKey) return {};
  const headers: Record<string, string> = { 'x-ai-api-key': settings.aiApiKey };
  if (settings.provider === 'openai-compatible' && settings.aiBaseUrl) {
    headers['x-ai-base-url'] = settings.aiBaseUrl;
  }
  return headers;
}

export async function checkHealth(settings: ExtensionSettings): Promise<HealthResponse> {
  return call<HealthResponse>('/api/health', { method: 'GET' }, settings);
}

/** One page of the backend's question history, newest first. */
export async function fetchHistory(
  settings: ExtensionSettings,
  options: { limit?: number; before?: string } = {},
): Promise<ServerHistoryPage> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.before) query.set('before', options.before);
  const suffix = query.size ? `?${query.toString()}` : '';

  const payload = await call<ListEnvelope<{ entries?: ServerHistoryEntry[]; nextBefore?: string }>>(
    `/api/history${suffix}`,
    { method: 'GET' },
    settings,
  );
  const entries = payload.data?.entries;
  if (!Array.isArray(entries)) {
    throw new BackendError('The backend returned malformed history.', 'provider_error');
  }
  return {
    enabled: payload.meta?.enabled === true,
    entries,
    ...(payload.data?.nextBefore ? { nextBefore: payload.data.nextBefore } : {}),
  };
}

export async function fetchServerStats(settings: ExtensionSettings): Promise<ServerStats> {
  const payload = await call<ListEnvelope<Omit<ServerStats, 'enabled'>>>(
    '/api/stats',
    { method: 'GET' },
    settings,
  );
  if (!payload.data || typeof payload.data.total !== 'number') {
    throw new BackendError('The backend returned malformed statistics.', 'provider_error');
  }
  return { ...payload.data, enabled: payload.meta?.enabled === true };
}

export async function clearServerHistory(settings: ExtensionSettings): Promise<number> {
  const payload = await call<ListEnvelope<{ deleted?: number }>>(
    '/api/history/clear',
    { method: 'POST' },
    settings,
  );
  return payload.data?.deleted ?? 0;
}

async function call<T>(
  path: string,
  init: RequestInit,
  settings: ExtensionSettings,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.requestTimeoutMs);

  const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
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
    const error = (parsed as AnswerEnvelope | null)?.error;
    const message = error?.message ?? `Backend responded with ${response.status}.`;
    throw new BackendError(message, mapStatus(response.status), retryAfter(error?.retryAfterMs, response));
  }

  if (parsed === null) {
    throw new BackendError('The backend returned a response that was not JSON.', 'provider_error');
  }
  return parsed as T;
}

/** The wait the backend asked for: its JSON field, else the Retry-After header. */
function retryAfter(fromBody: unknown, response: Response): number | undefined {
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  const header = Number(response.headers.get('retry-after'));
  return response.headers.has('retry-after') && Number.isFinite(header) && header >= 0
    ? header * 1000
    : undefined;
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
