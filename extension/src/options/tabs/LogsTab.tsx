import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { ActivityEntry, ActivityOutcome } from '../../shared/types';
import {
  SERVER_HISTORY_OFF,
  clearServerHistory,
  formatTime,
  fromServerEntry,
  getLog,
  getServerHistory,
  send,
} from '../api';
import { OutcomeBadge } from '../components/OutcomeBadge';
import { SourceSwitch, useHistorySource } from '../components/SourceSwitch';

type Filter = 'all' | 'errors' | ActivityOutcome;

const FILTERS: ReadonlyArray<{ value: Filter; label: string; server: boolean }> = [
  { value: 'all', label: 'Everything', server: true },
  { value: 'answered', label: 'Answered', server: true },
  { value: 'cached', label: 'Cached', server: true },
  // The server records answers it produced, never what happened on the page.
  { value: 'no-match', label: 'No match', server: false },
  { value: 'not-applied', label: 'Not applied', server: false },
  { value: 'errors', label: 'Errors', server: false },
];

/** Server history is fetched a page at a time, newest first. */
const SERVER_PAGE_SIZE = 100;

export function LogsTab() {
  const [source, setSource] = useHistorySource();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<string | undefined>();
  const [confirmingClear, setConfirmingClear] = useState(false);

  const server = source === 'server';

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    setConfirmingClear(false);
    try {
      if (source === 'local') {
        setEntries(await getLog());
        setNextBefore(undefined);
        return;
      }
      const result = await getServerHistory({ limit: SERVER_PAGE_SIZE });
      if (!result.ok) {
        setEntries([]);
        setNextBefore(undefined);
        setError(result.error);
        return;
      }
      setEntries(result.value.entries.map(fromServerEntry));
      setNextBefore(result.value.nextBefore);
      if (!result.value.enabled) setNotice(SERVER_HISTORY_OFF);
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // A filter the server cannot answer would silently show nothing.
    if (server && !FILTERS.find((option) => option.value === filter)?.server) setFilter('all');
  }, [server, filter]);

  const loadOlder = async () => {
    if (!nextBefore) return;
    setLoading(true);
    try {
      const result = await getServerHistory({ limit: SERVER_PAGE_SIZE, before: nextBefore });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEntries((current) => [...current, ...result.value.entries.map(fromServerEntry)]);
      setNextBefore(result.value.nextBefore);
    } finally {
      setLoading(false);
    }
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (filter === 'errors' && entry.outcome !== 'error') return false;
      if (filter !== 'all' && filter !== 'errors' && entry.outcome !== filter) return false;
      if (!needle) return true;
      return (
        entry.question.toLowerCase().includes(needle) ||
        entry.answer.toLowerCase().includes(needle) ||
        entry.origin.toLowerCase().includes(needle)
      );
    });
  }, [entries, filter, query]);

  const clear = async () => {
    if (!server) {
      await send({ kind: 'log:clear' });
      setEntries([]);
      return;
    }
    // Server history may hold other browsers' questions too, so ask twice.
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }
    setConfirmingClear(false);
    const result = await clearServerHistory();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEntries([]);
    setNextBefore(undefined);
    setNotice(`Deleted ${result.value} ${result.value === 1 ? 'entry' : 'entries'} from the server.`);
  };

  /** Download the log as JSON so it can be attached to a bug report. */
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ai-browser-assistant-${server ? 'server-history' : 'log'}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const emptyMessage = server
    ? 'The server has no history yet. It fills up as the backend answers questions.'
    : 'The log is empty. It fills up as questions are answered.';

  return (
    <div className="stack">
      <section className="card">
        <div className="toolbar">
          <SourceSwitch source={source} onChange={setSource} />

          <div className="chips" role="group" aria-label="Filter">
            {FILTERS.filter((option) => !server || option.server).map((option) => (
              <button
                key={option.value}
                type="button"
                className={`chip ${filter === option.value ? 'chip-on' : ''}`}
                aria-pressed={filter === option.value}
                onClick={() => setFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <input
            type="search"
            className="search"
            placeholder="Search questions, answers, sites"
            aria-label="Search the log"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          <div className="toolbar-actions">
            <button type="button" className="small" onClick={() => void refresh()}>
              Refresh
            </button>
            <button type="button" className="small" onClick={exportJson} disabled={!entries.length}>
              Export
            </button>
            <button
              type="button"
              className="small danger"
              onClick={() => void clear()}
              onBlur={() => setConfirmingClear(false)}
              disabled={!entries.length}
            >
              {confirmingClear ? 'Delete from server?' : 'Clear'}
            </button>
          </div>
        </div>

        <p className="muted count-line">
          {loading
            ? 'Loading…'
            : `${visible.length} of ${entries.length}${nextBefore ? '+' : ''} ${
                entries.length === 1 ? 'entry' : 'entries'
              }${server ? ' on the server' : ' in this browser'}`}
        </p>
        {error ? <p className="status error">{error}</p> : null}
        {notice ? <p className="notice">{notice}</p> : null}
      </section>

      {!loading && !error && visible.length === 0 ? (
        <section className="card">
          <p className="muted">{entries.length === 0 ? emptyMessage : 'Nothing matches that filter.'}</p>
        </section>
      ) : null}

      {visible.length > 0 ? (
        <section className="card log-card">
          <table className="log">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Site</th>
                <th scope="col">Question</th>
                <th scope="col">Answer</th>
                <th scope="col">Outcome</th>
                <th scope="col" className="numeric">
                  Took
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => {
                const open = expanded === entry.id;
                return (
                  <Fragment key={entry.id}>
                    <tr className={open ? 'row-open' : ''} onClick={() => setExpanded(open ? null : entry.id)}>
                      <td>
                        <time dateTime={new Date(entry.at).toISOString()}>{formatTime(entry.at)}</time>
                      </td>
                      <td className="origin">{entry.origin || '—'}</td>
                      <td className="truncate">{entry.question}</td>
                      <td className="truncate">
                        {entry.error ? <span className="error">{entry.error}</span> : entry.answer}
                      </td>
                      <td>
                        <OutcomeBadge outcome={entry.outcome} />
                      </td>
                      <td className="numeric">{entry.latencyMs ? `${entry.latencyMs} ms` : '—'}</td>
                    </tr>
                    {open ? (
                      <tr className="detail-row">
                        <td colSpan={6}>
                          <dl className="pairs">
                            <dt>Question</dt>
                            <dd>{entry.question}</dd>
                            <dt>Answer</dt>
                            <dd>{entry.answer || '—'}</dd>
                            {entry.explanation ? (
                              <>
                                <dt>Explanation</dt>
                                <dd>{entry.explanation}</dd>
                              </>
                            ) : null}
                            {entry.error ? (
                              <>
                                <dt>Error</dt>
                                <dd className="error">{entry.error}</dd>
                              </>
                            ) : null}
                            <dt>Type</dt>
                            <dd>
                              {entry.type}
                              {entry.optionCount ? ` · ${entry.optionCount} options` : ''}
                            </dd>
                            <dt>Provider</dt>
                            <dd>
                              {entry.provider} · {entry.model}
                            </dd>
                            <dt>Page</dt>
                            <dd className="break">
                              {entry.title || entry.url || (server ? entry.origin || '—' : '—')}
                            </dd>
                          </dl>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {server && nextBefore ? (
            <p className="muted count-line">
              <button type="button" className="small" onClick={() => void loadOlder()} disabled={loading}>
                {loading ? 'Loading…' : 'Load older'}
              </button>
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
