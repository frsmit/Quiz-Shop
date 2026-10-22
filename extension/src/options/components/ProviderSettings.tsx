import { useEffect, useState } from 'react';
import { PROVIDER_CHOICES } from '../../shared/constants';
import type { ExtensionSettings, ProviderChoice, ProviderInfo } from '../../shared/types';
import { send } from '../api';
import { Field } from './Field';

interface ProviderSettingsProps {
  settings: ExtensionSettings;
  update: <K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) => void;
}

/** What the backend said about its providers; null until it answers. */
interface BackendProviders {
  providers: ProviderInfo[];
  activeProvider: string;
  /** False only when the backend explicitly refuses keys from the extension. */
  clientCredentials: boolean;
}

type TestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'ok'; message: string }
  | { phase: 'error'; message: string };

/**
 * Provider, model and key - everything needed to point the extension at the
 * user's own AI account. The backend still makes the call; a key entered here
 * rides along with each request in place of the backend's own.
 */
export function ProviderSettings({ settings, update }: ProviderSettingsProps) {
  const [backend, setBackend] = useState<BackendProviders | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<TestState>({ phase: 'idle' });

  useEffect(() => {
    let live = true;
    void send({ kind: 'backend:health' }).then((response) => {
      if (!live || !response.ok || response.kind !== 'health') return;
      setBackend({
        providers: response.allProviders ?? [],
        activeProvider: response.activeProvider,
        clientCredentials: response.clientCredentials !== false,
      });
    });
    return () => {
      live = false;
    };
  }, []);

  // A result describes the settings it was run against, not the edited ones.
  useEffect(() => {
    setTest({ phase: 'idle' });
  }, [settings.provider, settings.model, settings.aiApiKey, settings.aiBaseUrl]);

  const chosen = settings.provider;
  const info = backend?.providers.find((entry) => entry.id === (chosen || backend.activeProvider));
  const compatible = chosen === 'openai-compatible';
  const baseUrlInvalid = compatible && settings.aiBaseUrl.trim() !== '' && !isHttpUrl(settings.aiBaseUrl);
  const missing = missingFields(settings);

  const runTest = async () => {
    setTest({ phase: 'running' });
    const response = await send({ kind: 'provider:test', settings });
    if (response.ok && response.kind === 'provider-test') {
      const { provider, model, answer, latencyMs } = response.result;
      setTest({
        phase: 'ok',
        message: `${provider} · ${model} answered "${answer}" in ${(latencyMs / 1000).toFixed(1)}s.`,
      });
    } else {
      setTest({ phase: 'error', message: response.ok ? 'Unexpected response.' : response.error });
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>AI provider</h2>
      </div>

      <div className="row">
        <Field label="Provider" htmlFor="provider">
          <select
            id="provider"
            value={chosen}
            onChange={(event) => update('provider', event.target.value as ProviderChoice)}
          >
            {PROVIDER_CHOICES.map((choice) => (
              <option key={choice.value || 'default'} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Model"
          htmlFor="model"
          hint={
            compatible
              ? 'Required: the model name your endpoint serves.'
              : info?.defaultModel
                ? `Leave blank for ${info.defaultModel}.`
                : 'Leave blank to use the backend default.'
          }
        >
          <input
            id="model"
            type="text"
            value={settings.model}
            placeholder={compatible ? 'e.g. llama-3.1-8b-instruct' : info?.defaultModel || 'backend default'}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => update('model', event.target.value)}
          />
        </Field>
      </div>

      {chosen ? (
        <div className="row">
          <Field
            label="API key"
            htmlFor="aiApiKey"
            hint={
              info?.configured
                ? 'Optional: the backend already has a key for this provider. Enter yours to use your own account instead.'
                : 'Required: the backend has no key for this provider.'
            }
          >
            <div className="input-with-action">
              <input
                id="aiApiKey"
                type={showKey ? 'text' : 'password'}
                value={settings.aiApiKey}
                placeholder={info?.configured ? "using the backend's key" : 'paste your API key'}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => update('aiApiKey', event.target.value)}
              />
              <button
                type="button"
                className="ghost small"
                aria-pressed={showKey}
                onClick={() => setShowKey((value) => !value)}
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </Field>

          {compatible ? (
            <Field
              label="Endpoint base URL"
              htmlFor="aiBaseUrl"
              hint={
                baseUrlInvalid
                  ? 'Not a valid http(s) URL.'
                  : 'The OpenAI-compatible API root, e.g. https://openrouter.ai/api/v1 or http://127.0.0.1:11434/v1.'
              }
            >
              <input
                id="aiBaseUrl"
                type="url"
                value={settings.aiBaseUrl}
                placeholder="https://…/v1"
                spellCheck={false}
                aria-invalid={baseUrlInvalid}
                onChange={(event) => update('aiBaseUrl', event.target.value)}
              />
            </Field>
          ) : null}
        </div>
      ) : null}

      <div className="provider-test">
        <button
          type="button"
          className="small"
          onClick={() => void runTest()}
          disabled={test.phase === 'running' || missing !== null || baseUrlInvalid}
        >
          {test.phase === 'running' ? 'Testing…' : 'Test provider'}
        </button>
        {missing ? (
          <span className="status warn">{missing}</span>
        ) : test.phase === 'ok' ? (
          <span className="status ok">{test.message}</span>
        ) : test.phase === 'error' ? (
          <span className="status error">{test.message}</span>
        ) : (
          <span className="muted">Sends one small question through the backend. Settings need not be saved first.</span>
        )}
      </div>

      {backend && !backend.clientCredentials && settings.aiApiKey ? (
        <p className="notice">
          <strong>This backend does not accept keys from the extension</strong> (ALLOW_CLIENT_AI_KEYS
          is off), so requests with this key will be refused. Clear the key to use the backend's own.
        </p>
      ) : (
        <p className="notice">
          <strong>Your key stays in this browser.</strong> It is kept in this device's extension
          storage only - never synced and never shown to a web page - and sent only to your backend,
          which uses it for your requests and does not store or log it. Leave it blank to use the key
          in <code>server/.env</code>.
        </p>
      )}
    </section>
  );
}

/** Why the current settings cannot be tested yet, or null when they can. */
function missingFields(settings: ExtensionSettings): string | null {
  if (settings.provider !== 'openai-compatible' || !settings.aiApiKey.trim()) return null;
  if (!settings.aiBaseUrl.trim()) return 'Enter the endpoint base URL to use your own key.';
  if (!settings.model.trim()) return 'Enter the model name to use your own key.';
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
