import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ActivityEntry, ActivityOutcome } from '../../shared/types';
import { formatTime, getLog, send } from '../api';
import { OutcomeBadge } from '../components/OutcomeBadge';

type Filter = 'all' | 'errors' | ActivityOutcome;

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Everything' },
  { value: 'answered', label: 'Answered' },
  { value: 'cached', label: 'Cached' },
  { value: 'no-match', label: 'No match' },
  { value: 'errors', label: 'Errors' },
];

export function LogsTab() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await getLog());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    await send({ kind: 'log:clear' });
    setEntries([]);
  };

  /** Download the log as JSON so it can be attached to a bug report. */
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ai-browser-assistant-log-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack">
      <section className="card">
        <div className="toolbar">
          <div className="chips" role="group" aria-label="Filter">
            {FILTERS.map((option) => (
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
            <button type="button" className="small danger" onClick={() => void clear()} disabled={!entries.length}>
              Clear
            </button>
          </div>
        </div>

        <p className="muted count-line">
          {loading
            ? 'Loading…'
            : `${visible.length} of ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`}
        </p>
      </section>

      {!loading && visible.length === 0 ? (
        <section className="card">
          <p className="muted">
            {entries.length === 0
              ? 'The log is empty. It fills up as questions are answered.'
              : 'Nothing matches that filter.'}
          </p>
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
                  <>
                    <tr
                      key={entry.id}
                      className={open ? 'row-open' : ''}
                      onClick={() => setExpanded(open ? null : entry.id)}
                    >
                      <td>
                        <time dateTime={new Date(entry.at).toISOString()}>{formatTime(entry.at)}</time>
                      </td>
                      <td className="origin">{entry.origin || '—'}</td>
                      <td className="truncate">{entry.question}</td>
                      <td className="truncate">{entry.error ? <span className="error">{entry.error}</span> : entry.answer}</td>
                      <td>
                        <OutcomeBadge outcome={entry.outcome} />
                      </td>
                      <td className="numeric">{entry.latencyMs ? `${entry.latencyMs} ms` : '—'}</td>
                    </tr>
                    {open ? (
                      <tr key={`${entry.id}-detail`} className="detail-row">
                        <td colSpan={6}>
                          <dl className="pairs">
                            <dt>Question</dt>
                            <dd>{entry.question}</dd>
                            <dt>Answer</dt>
                            <dd>{entry.answer || '—'}</dd>
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
                            <dd className="break">{entry.title || entry.url || '—'}</dd>
                          </dl>
                        </td>
                      </tr>
                    ) : null}
                  </>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
