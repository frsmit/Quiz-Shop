import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from '../shared/constants';
import { envelope } from '../shared/messages';
import type { UiToWorkerMessage, WorkerResponse } from '../shared/messages';
import type { ExtensionSettings, RuntimeStatus } from '../shared/types';

async function send(message: UiToWorkerMessage): Promise<WorkerResponse> {
  return (await chrome.runtime.sendMessage(envelope(message))) as WorkerResponse;
}

const STATUS_COPY: Record<RuntimeStatus['status'], { label: string; tone: string }> = {
  running: { label: 'Running', tone: 'ok' },
  paused: { label: 'Paused', tone: 'paused' },
  starting: { label: 'Starting soon', tone: 'warn' },
  disabled: { label: 'Detection off', tone: 'off' },
};

interface SiteState {
  /** Origin of the active tab, or null when it is not an http(s) page. */
  origin: string | null;
  enabled: boolean;
  /** Covered by the manifest, so it cannot be turned off here. */
  builtIn: boolean;
}

export function App() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [site, setSite] = useState<SiteState>({ origin: null, enabled: false, builtIn: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tabId = useRef<number | null>(null);

  const loadSite = useCallback(async (current: ExtensionSettings) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId.current = tab?.id ?? null;

    let origin: string | null = null;
    try {
      if (tab?.url) {
        const url = new URL(tab.url);
        if (url.protocol === 'http:' || url.protocol === 'https:') origin = url.origin;
      }
    } catch {
      origin = null;
    }

    if (!origin) {
      setSite({ origin: null, enabled: false, builtIn: false });
      return;
    }

    const builtIn = ['localhost', '127.0.0.1'].includes(new URL(origin).hostname);
    const granted = builtIn || (await chrome.permissions.contains({ origins: [`${origin}/*`] }));
    setSite({
      origin,
      builtIn,
      enabled: builtIn || (granted && current.enabledOrigins.includes(origin)),
    });
  }, []);

  const refresh = useCallback(async () => {
    const [runResponse, settingsResponse] = await Promise.all([
      send({ kind: 'run:get' }),
      send({ kind: 'settings:get' }),
    ]);

    if (runResponse.ok && runResponse.kind === 'run') setStatus(runResponse.status);
    if (settingsResponse.ok && settingsResponse.kind === 'settings') {
      setSettings(settingsResponse.settings);
      await loadSite(settingsResponse.settings);
    }
  }, [loadSite]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Tick the countdown while the start delay is running.
  useEffect(() => {
    if (status?.status !== 'starting') return undefined;
    const timer = setInterval(() => {
      setStatus((current) =>
        current && current.startsInMs > 1000
          ? { ...current, startsInMs: current.startsInMs - 1000 }
          : current,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [status?.status]);

  const toggleRun = async () => {
    if (!status) return;
    setBusy(true);
    try {
      const response = await send({ kind: status.status === 'paused' ? 'run:resume' : 'run:pause' });
      if (response.ok && response.kind === 'run') setStatus(response.status);
    } finally {
      setBusy(false);
    }
  };

  const toggleSite = async () => {
    if (!site.origin || site.builtIn) return;
    setBusy(true);
    setError(null);
    try {
      if (site.enabled) {
        await chrome.permissions.remove({ origins: [`${site.origin}/*`] });
        await send({ kind: 'site:disable', origin: site.origin });
        setSite((current) => ({ ...current, enabled: false }));
        return;
      }

      // Must be called straight from the click, or Chrome rejects it.
      const granted = await chrome.permissions.request({ origins: [`${site.origin}/*`] });
      if (!granted) {
        setError('Chrome denied access to this site.');
        return;
      }

      await send({ kind: 'site:enable', origin: site.origin });
      setSite((current) => ({ ...current, enabled: true }));

      // The script is registered for future loads; inject now so the current
      // page starts working without a manual reload.
      if (tabId.current !== null) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tabId.current },
            files: ['content.js'],
          });
        } catch {
          setError('Enabled. Reload the page to start.');
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const openOptions = () => {
    void chrome.runtime.openOptionsPage();
    window.close();
  };

  if (!status || !settings) {
    return (
      <main className="popup">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const copy = STATUS_COPY[status.status];
  const paused = status.status === 'paused';

  return (
    <main className="popup">
      <header className="popup-header">
        <div>
          <h1>AI Browser Learning Assistant</h1>
          <p className={`status status-${copy.tone}`}>
            <span className="dot" aria-hidden="true" />
            {copy.label}
            {status.status === 'starting' ? ` · ${formatDuration(status.startsInMs)}` : ''}
          </p>
        </div>
      </header>

      <button
        type="button"
        className={`run-toggle ${paused ? 'resume' : 'pause'}`}
        onClick={() => void toggleRun()}
        disabled={busy}
      >
        {paused ? 'Resume' : 'Pause'}
      </button>

      {status.status === 'starting' ? (
        <p className="hint">
          Waiting out the {Math.round(settings.startDelayMs / 60000) || '<1'} minute start delay.
          Questions found in the meantime are answered once it elapses.
        </p>
      ) : null}

      {status.status === 'disabled' ? (
        <p className="hint">
          Automatic detection is switched off in settings, so nothing will be answered.
        </p>
      ) : null}

      <section className="site">
        <h2>This site</h2>
        {site.origin === null ? (
          <p className="muted">Not a web page.</p>
        ) : site.builtIn ? (
          <p className="muted">
            <code>{site.origin}</code> is always enabled.
          </p>
        ) : (
          <>
            <code className="origin">{site.origin}</code>
            <button
              type="button"
              className={site.enabled ? 'secondary' : 'primary'}
              onClick={() => void toggleSite()}
              disabled={busy}
            >
              {site.enabled ? 'Disable here' : 'Enable on this site'}
            </button>
          </>
        )}
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="counts">
        <div>
          <strong>{status.answeredToday}</strong>
          <span>today</span>
        </div>
        <div>
          <strong>{status.answeredTotal}</strong>
          <span>all time</span>
        </div>
        <div>
          <strong>{settings.autoFill ? 'On' : 'Off'}</strong>
          <span>auto-fill</span>
        </div>
      </section>

      <button type="button" className="link" onClick={openOptions}>
        Settings and activity log
      </button>
    </main>
  );
}
