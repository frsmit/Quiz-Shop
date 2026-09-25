import { useCallback, useEffect, useState } from 'react';
import { formatDuration } from '../../shared/constants';
import type {
  ActivityEntry,
  ActivityStats,
  ExtensionSettings,
  RuntimeStatus,
  ServerPersistence,
} from '../../shared/types';
import {
  SERVER_HISTORY_OFF,
  formatRelative,
  formatTime,
  fromServerEntry,
  getLog,
  getServerHistory,
  getServerStats,
  getStats,
  getStatus,
  send,
} from '../api';
import { OutcomeBadge } from '../components/OutcomeBadge';
import { SourceSwitch, useHistorySource } from '../components/SourceSwitch';

interface MonitorTabProps {
  settings: ExtensionSettings;
}

interface Health {
  activeProvider: string;
  providers: string[];
  persistence?: ServerPersistence;
  error?: string;
}

/** The numbers the metric row shows, whichever source they came from. */
interface Summary {
  today: number;
  total: number;
  cached: number;
  /** Local: errors. Server: average latency, since it records no errors. */
  fourth: { value: string; label: string; bad: boolean };
  lastAt: number | null;
  byOrigin: Array<{ origin: string; count: number }>;
}

/**
 * Local state is cheap to poll. The server is not: each poll is two requests
 * against the backend's rate limit, which answering shares.
 */
const POLL_MS = { local: 4_000, server: 30_000 } as const;

const DATABASE_COPY: Record<ServerPersistence['database'], string> = {
  connected: 'MongoDB connected',
  unreachable: 'MongoDB unreachable',
  not_configured: 'no database (in memory)',
};

function fromLocal(stats: ActivityStats): Summary {
  return {
    today: stats.today,
    total: stats.total,
    cached: stats.cached,
    fourth: { value: String(stats.errors), label: 'errors', bad: stats.errors > 0 },
    lastAt: stats.lastAt,
    byOrigin: stats.byOrigin,
  };
}

const STATUS_COPY: Record<RuntimeStatus['status'], { label: string; tone: string; detail: string }> = {
  running: { label: 'Running', tone: 'ok', detail: 'Watching enabled pages for questions.' },
  paused: { label: 'Paused', tone: 'idle', detail: 'Resume from the toolbar icon.' },
  starting: { label: 'Starting soon', tone: 'warn', detail: 'Waiting out the start delay.' },
  disabled: { label: 'Detection off', tone: 'idle', detail: 'Turn it back on under Settings.' },
};

/** Live view: what the extension is doing right now, and what it just did. */
export function MonitorTab({ settings }: MonitorTabProps) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [source, setSource] = useHistorySource();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [recent, setRecent] = useState<ActivityEntry[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverOff, setServerOff] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [checking, setChecking] = useState(false);

  const refreshStatus = useCallback(async () => {
    setStatus(await getStatus());
  }, []);

  const refreshActivity = useCallback(async () => {
    if (source === 'local') {
      const [nextStats, entries] = await Promise.all([getStats(), getLog(8)]);
      setSummary(nextStats ? fromLocal(nextStats) : null);
      setRecent(entries);
      setServerError(null);
      setServerOff(false);
      return;
    }

    const [statsResult, historyResult] = await Promise.all([
      getServerStats(),
      getServerHistory({ limit: 8 }),
    ]);
    if (!statsResult.ok || !historyResult.ok) {
      setServerError(!statsResult.ok ? statsResult.error : !historyResult.ok ? historyResult.error : null);
      setSummary(null);
      setRecent([]);
      return;
    }
    const stats = statsResult.value;
    const entries = historyResult.value.entries.map(fromServerEntry);
    setServerError(null);
    setServerOff(!stats.enabled);
    setRecent(entries);
    setSummary({
      today: stats.today,
      total: stats.total,
      cached: stats.cached,
      fourth: {
        value: stats.total ? `${stats.averageLatencyMs} ms` : '—',
        label: 'average response',
        bad: false,
      },
      lastAt: entries[0]?.at ?? null,
      byOrigin: stats.topOrigins,
    });
  }, [source]);

  // The run state is always local and always live.
  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), POLL_MS.local);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    setSummary(null);
    void refreshActivity();
    const timer = setInterval(() => void refreshActivity(), POLL_MS[source]);
    return () => clearInterval(timer);
  }, [refreshActivity, source]);

  const checkBackend = async () => {
    setChecking(true);
    try {
      const response = await send({ kind: 'backend:health' });
      if (response.ok && response.kind === 'health') {
        setHealth({
          activeProvider: response.activeProvider,
          providers: response.providers,
          persistence: response.persistence,
        });
      } else if (!response.ok) {
        setHealth({ activeProvider: '', providers: [], error: response.error });
      }
    } finally {
      setChecking(false);
    }
  };

  const toggleRun = async () => {
    if (!status) return;
    const response = await send({ kind: status.status === 'paused' ? 'run:resume' : 'run:pause' });
    if (response.ok && response.kind === 'run') setStatus(response.status);
  };

  if (!status) return <p className="muted">Loading…</p>;

  const copy = STATUS_COPY[status.status];

  return (
    <div className="stack">
      <section className="card status-card">
        <div className={`status-block tone-${copy.tone}`}>
          <span className="dot" aria-hidden="true" />
          <div>
            <h2>
              {copy.label}
              {status.status === 'starting' ? ` · ${formatDuration(status.startsInMs)}` : ''}
            </h2>
            <p>{copy.detail}</p>
          </div>
        </div>
        <button type="button" onClick={() => void toggleRun()}>
          {status.status === 'paused' ? 'Resume' : 'Pause'}
        </button>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Activity</h2>
          <SourceSwitch source={source} onChange={setSource} />
        </div>
        <p className="muted">
          {source === 'server'
            ? "From the backend's history: every question it answered, from any browser using it. Refreshes every 30 seconds."
            : "From this browser's activity log, including what happened on the page."}
        </p>
        {serverError ? <p className="status error">{serverError}</p> : null}
        {serverOff ? <p className="notice">{SERVER_HISTORY_OFF}</p> : null}
      </section>

      {summary ? (
        <section className="metrics">
          <div className="metric">
            <strong>{summary.today}</strong>
            <span>answered today</span>
          </div>
          <div className="metric">
            <strong>{summary.total}</strong>
            <span>answered in total</span>
          </div>
          <div className="metric">
            <strong>{summary.cached}</strong>
            <span>served from cache</span>
          </div>
          <div className={`metric ${summary.fourth.bad ? 'metric-bad' : ''}`}>
            <strong>{summary.fourth.value}</strong>
            <span>{summary.fourth.label}</span>
          </div>
          <div className="metric">
            <strong>{formatRelative(summary.lastAt)}</strong>
            <span>last activity</span>
          </div>
        </section>
      ) : !serverError ? (
        <p className="muted">Loading…</p>
      ) : null}

      <section className="card">
        <div className="card-head">
          <h2>Backend</h2>
          <button type="button" className="small" onClick={() => void checkBackend()} disabled={checking}>
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </div>
        <dl className="pairs">
          <dt>URL</dt>
          <dd>
            <code>{settings.backendUrl}</code>
          </dd>
          <dt>Provider</dt>
          <dd>{settings.provider || "the backend's own choice"}</dd>
          <dt>Model</dt>
          <dd>{settings.model || 'backend default'}</dd>
        </dl>
        {health?.error ? <p className="status error">{health.error}</p> : null}
        {health && !health.error ? (
          <p className="status ok">
            Reachable. Active provider: {health.activeProvider}. Credentials present for:{' '}
            {health.providers.length ? health.providers.join(', ') : 'none'}.
            {health.persistence
              ? ` Storage: ${DATABASE_COPY[health.persistence.database]}, cache in ${health.persistence.cache}, history ${
                  health.persistence.history ? 'on' : 'off'
                }.`
              : ''}
          </p>
        ) : null}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Recent activity</h2>
        </div>
        {recent.length === 0 ? (
          <p className="muted">
            {source === 'server'
              ? 'Nothing on the server yet.'
              : 'Nothing yet. Open a page with questions on a site you have enabled.'}
          </p>
        ) : (
          <ul className="feed">
            {recent.map((entry) => (
              <li key={entry.id}>
                <div className="feed-head">
                  <time>{formatTime(entry.at)}</time>
                  <span className="origin">{entry.origin || 'unknown origin'}</span>
                  <OutcomeBadge outcome={entry.outcome} />
                </div>
                <p className="feed-question">{entry.question}</p>
                {entry.error ? (
                  <p className="feed-answer error">{entry.error}</p>
                ) : (
                  <p className="feed-answer">{entry.answer}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {summary && summary.byOrigin.length > 0 ? (
        <section className="card">
          <div className="card-head">
            <h2>Busiest sites</h2>
          </div>
          <ul className="bars">
            {summary.byOrigin.map((row) => (
              <li key={row.origin}>
                <span className="bar-label">{row.origin || 'unknown'}</span>
                <span className="bar-track" aria-hidden="true">
                  <span
                    className="bar-fill"
                    style={{ width: `${(row.count / summary.byOrigin[0]!.count) * 100}%` }}
                  />
                </span>
                <span className="bar-value">{row.count}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
