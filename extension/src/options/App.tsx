import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, PROVIDER_LABELS } from '../shared/constants';
import { envelope } from '../shared/messages';
import type { OptionsToWorkerMessage, WorkerResponse } from '../shared/messages';
import type { ExtensionSettings, ProviderId } from '../shared/types';
import { Field, Toggle } from './components/Field';
import { OriginManager } from './components/OriginManager';

type Status = { tone: 'ok' | 'error'; message: string } | null;

async function send(message: OptionsToWorkerMessage): Promise<WorkerResponse> {
  return (await chrome.runtime.sendMessage(envelope(message))) as WorkerResponse;
}

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    void (async () => {
      const response = await send({ kind: 'settings:get' });
      if (response.ok && response.kind === 'settings') setSettings(response.settings);
      setLoaded(true);
    })();
  }, []);

  const update = <K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setStatus(null);
  };

  const save = async () => {
    setBusy(true);
    try {
      const response = await send({ kind: 'settings:save', settings });
      if (response.ok && response.kind === 'settings') {
        setSettings(response.settings);
        setStatus({ tone: 'ok', message: 'Settings saved.' });
      } else if (!response.ok) {
        setStatus({ tone: 'error', message: response.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await send({ kind: 'settings:save', settings });
      const response = await send({ kind: 'backend:health' });
      if (response.ok && response.kind === 'health') {
        const configured = response.providers.length
          ? response.providers.join(', ')
          : 'none configured';
        setStatus({
          tone: 'ok',
          message: `Backend reachable. Active provider: ${response.activeProvider}. Credentials present for: ${configured}.`,
        });
      } else if (!response.ok) {
        setStatus({ tone: 'error', message: response.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const clearCache = async () => {
    await send({ kind: 'cache:clear' });
    setStatus({ tone: 'ok', message: 'Cached answers cleared.' });
  };

  if (!loaded) return <main className="page">Loading settings…</main>;

  return (
    <main className="page">
      <header className="page-header">
        <h1>AI Browser Learning Assistant</h1>
        <p>Detected questions are answered by your own backend. No AI interface is added to pages.</p>
      </header>

      <section className="card">
        <h2>AI provider</h2>
        <div className="row">
          <Field label="Provider" htmlFor="provider">
            <select
              id="provider"
              value={settings.provider}
              onChange={(event) => update('provider', event.target.value as ProviderId)}
            >
              {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Model" htmlFor="model" hint="Leave blank to use the backend default.">
            <input
              id="model"
              type="text"
              value={settings.model}
              placeholder="backend default"
              onChange={(event) => update('model', event.target.value)}
            />
          </Field>
        </div>

        <p className="notice">
          <strong>API keys live on the backend.</strong> They are never stored in the extension or
          sent to the page. Configure them in <code>server/.env</code>.
        </p>
      </section>

      <section className="card">
        <h2>Backend</h2>
        <div className="row">
          <Field label="Backend URL" htmlFor="backendUrl">
            <input
              id="backendUrl"
              type="url"
              value={settings.backendUrl}
              onChange={(event) => update('backendUrl', event.target.value)}
            />
          </Field>

          <Field
            label="Backend access key"
            htmlFor="backendApiKey"
            hint="Only needed if the backend sets API_ACCESS_KEY."
          >
            <input
              id="backendApiKey"
              type="password"
              value={settings.backendApiKey}
              onChange={(event) => update('backendApiKey', event.target.value)}
            />
          </Field>
        </div>

        <div className="row">
          <Field
            label="Request timeout (ms)"
            htmlFor="requestTimeoutMs"
            hint="Between 2000 and 120000."
          >
            <input
              id="requestTimeoutMs"
              type="number"
              min={2000}
              max={120000}
              step={500}
              value={settings.requestTimeoutMs}
              onChange={(event) => update('requestTimeoutMs', Number(event.target.value))}
            />
          </Field>

          <Field
            label="Maximum context length"
            htmlFor="maxContextLength"
            hint="Characters of surrounding page content sent with a question. 0 sends none."
          >
            <input
              id="maxContextLength"
              type="number"
              min={0}
              max={8000}
              step={100}
              value={settings.maxContextLength}
              onChange={(event) => update('maxContextLength', Number(event.target.value))}
            />
          </Field>
        </div>
      </section>

      <section className="card">
        <h2>Behaviour</h2>
        <Toggle
          label="Detect questions automatically"
          hint="Watches the page and answers questions as they appear."
          checked={settings.autoDetect}
          onChange={(value) => update('autoDetect', value)}
        />
        <Toggle
          label="Fill answers into the page"
          hint="Selects the matching option or types into the answer field using ordinary DOM events."
          checked={settings.autoFill}
          onChange={(value) => update('autoFill', value)}
        />
        <Toggle
          label="Cache answers"
          hint="Reuses the answer when the same question is seen again."
          checked={settings.cacheEnabled}
          onChange={(value) => update('cacheEnabled', value)}
        />
      </section>

      <section className="card">
        <h2>Sites</h2>
        <p className="hint">
          The extension only runs on sites you add here, plus <code>localhost</code> for the bundled
          demo.
        </p>
        <OriginManager
          origins={settings.enabledOrigins}
          onChange={(origins) => update('enabledOrigins', origins)}
        />
      </section>

      <div className="actions">
        <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
          Save settings
        </button>
        <button type="button" onClick={() => void testConnection()} disabled={busy}>
          Test connection
        </button>
        <button type="button" onClick={() => void clearCache()} disabled={busy}>
          Clear cached answers
        </button>
        {status ? <span className={`status ${status.tone}`}>{status.message}</span> : null}
      </div>
    </main>
  );
}
