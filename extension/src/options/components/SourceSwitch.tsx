import { useState } from 'react';

export type HistorySource = 'local' | 'server';

const STORAGE_KEY = 'ai-browser-assistant:history-source';

/** The last source picked on either tab, so both open where you left off. */
export function useHistorySource(): [HistorySource, (source: HistorySource) => void] {
  const [source, setSource] = useState<HistorySource>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'server' ? 'server' : 'local';
    } catch {
      return 'local';
    }
  });

  const update = (next: HistorySource) => {
    setSource(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A view preference; losing it is harmless.
    }
  };

  return [source, update];
}

const OPTIONS: ReadonlyArray<{ value: HistorySource; label: string; title: string }> = [
  {
    value: 'local',
    label: 'This browser',
    title: 'The activity log kept in this browser, including page-side outcomes and errors.',
  },
  {
    value: 'server',
    label: 'Server',
    title: "The backend's question history in MongoDB, shared across browsers and devices.",
  },
];

export function SourceSwitch({
  source,
  onChange,
}: {
  source: HistorySource;
  onChange: (source: HistorySource) => void;
}) {
  return (
    <div className="chips" role="group" aria-label="History source">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`chip ${source === option.value ? 'chip-on' : ''}`}
          aria-pressed={source === option.value}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
