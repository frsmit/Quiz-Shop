import { useCallback, useEffect, useState } from 'react';
import { formatDuration } from '../../shared/constants';
import type { ActivityEntry, ActivityStats, ExtensionSettings, RuntimeStatus } from '../../shared/types';
import { formatRelative, formatTime, getLog, getStats, getStatus, send } from '../api';
import { OutcomeBadge } from '../components/OutcomeBadge';

interface MonitorTabProps {
  settings: ExtensionSettings;
}

interface Health {
  activeProvider: string;
  providers: string[];
  error?: string;
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
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [recent, setRecent] = useState<ActivityEntry[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    const [nextStatus, nextStats, entries] = await Promise.all([getStatus(), getStats(), getLog(8)]);
    setStatus(nextStatus);
    setStats(nextStats);
    setRecent(entries);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  const checkBackend = async () => {
    setChecking(true);
    try {
      const response = await send({ kind: 'backend:health' });
      if (response.ok && response.kind === 'health') {
        setHealth({ activeProvider: response.activeProvider, providers: response.providers });
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

  if (!status || !stats) return <p className="muted">Loading…</p>;

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

      <section className="metrics">
        <div className="metric">
          <strong>{stats.today}</strong>
          <span>answered today</span>
        </div>
        <div className="metric">
          <strong>{stats.total}</strong>
          <span>answered in total</span>
        </div>
        <div className="metric">
          <strong>{stats.cached}</strong>
          <span>served from cache</span>
        </div>
        <div className={`metric ${stats.errors > 0 ? 'metric-bad' : ''}`}>
          <strong>{stats.errors}</strong>
          <span>errors</span>
        </div>
        <div className="metric">
          <strong>{formatRelative(stats.lastAt)}</strong>
          <span>last activity</span>
        </div>
      </section>

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
          </p>
        ) : null}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Recent activity</h2>
        </div>
        {recent.length === 0 ? (
          <p className="muted">
            Nothing yet. Open a page with questions on a site you have enabled.
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

      {stats.byOrigin.length > 0 ? (
        <section className="card">
          <div className="card-head">
            <h2>Busiest sites</h2>
          </div>
          <ul className="bars">
            {stats.byOrigin.map((row) => (
              <li key={row.origin}>
                <span className="bar-label">{row.origin || 'unknown'}</span>
                <span className="bar-track" aria-hidden="true">
                  <span
                    className="bar-fill"
                    style={{ width: `${(row.count / stats.byOrigin[0]!.count) * 100}%` }}
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
