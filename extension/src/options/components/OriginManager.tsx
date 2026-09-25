import { useCallback, useEffect, useState } from 'react';

interface OriginManagerProps {
  origins: string[];
  onChange: (origins: string[]) => void;
}

/**
 * Lets the user opt individual sites in. Host access is requested through
 * `chrome.permissions.request`, which must run inside a user gesture, so the
 * request is made directly from the button's click handler.
 */
export function OriginManager({ origins, onChange }: OriginManagerProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [granted, setGranted] = useState<Record<string, boolean>>({});

  const refreshGrants = useCallback(async (list: string[]) => {
    const entries = await Promise.all(
      list.map(async (origin) => {
        const has = await chrome.permissions.contains({ origins: [`${origin}/*`] });
        return [origin, has] as const;
      }),
    );
    setGranted(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    void refreshGrants(origins);
  }, [origins, refreshGrants]);

  const add = async () => {
    setError(null);
    let origin: string;
    try {
      const url = new URL(draft.includes('://') ? draft : `https://${draft}`);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
      origin = url.origin;
    } catch {
      setError('Enter a site address such as https://example.com');
      return;
    }

    if (origins.includes(origin)) {
      setError('That site is already in the list.');
      return;
    }

    const allowed = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!allowed) {
      setError('Chrome denied access to that site.');
      return;
    }

    setDraft('');
    onChange([...origins, origin]);
  };

  const remove = async (origin: string) => {
    await chrome.permissions.remove({ origins: [`${origin}/*`] });
    onChange(origins.filter((entry) => entry !== origin));
  };

  return (
    <div className="origins">
      {origins.length === 0 ? (
        <p className="hint">
          No sites added yet. The bundled demo on <code>localhost</code> works without adding
          anything.
        </p>
      ) : (
        origins.map((origin) => (
          <div className="origin-row" key={origin}>
            <code className="origin">{origin}</code>
            <span className="granted">
              {granted[origin] === false ? 'access not granted' : 'access granted'}
            </span>
            <button type="button" className="small" onClick={() => void remove(origin)}>
              Remove
            </button>
          </div>
        ))
      )}

      <div className="add-origin">
        <input
          type="text"
          value={draft}
          placeholder="https://practice.example.com"
          aria-label="Site to enable"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add();
          }}
        />
        <button type="button" className="small" onClick={() => void add()}>
          Add site
        </button>
      </div>

      {error ? <span className="status error">{error}</span> : null}
    </div>
  );
}
