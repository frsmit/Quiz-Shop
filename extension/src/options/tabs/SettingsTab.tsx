import {
  ANSWER_DELAY_PRESETS,
  LOG_LIMIT_BOUNDS,
  PROVIDER_CHOICES,
  START_DELAY_PRESETS,
} from '../../shared/constants';
import type { ExtensionSettings, ProviderChoice } from '../../shared/types';
import { Field, Toggle } from '../components/Field';
import { DelayPicker } from '../components/DelayPicker';

interface SettingsTabProps {
  settings: ExtensionSettings;
  update: <K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) => void;
}

export function SettingsTab({ settings, update }: SettingsTabProps) {
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>AI provider</h2>
        </div>

        <div className="row">
          <Field label="Provider" htmlFor="provider">
            <select
              id="provider"
              value={settings.provider}
              onChange={(event) => update('provider', event.target.value as ProviderChoice)}
            >
              {PROVIDER_CHOICES.map((choice) => (
                <option key={choice.value || 'default'} value={choice.value}>
                  {choice.label}
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
        <div className="card-head">
          <h2>Timing</h2>
        </div>

        <DelayPicker
          label="Start answering"
          hint="Counted from when you resume from the toolbar. Useful when you would rather read a page yourself first."
          id="startDelay"
          value={settings.startDelayMs}
          presets={START_DELAY_PRESETS}
          onChange={(value) => update('startDelayMs', value)}
        />

        <DelayPicker
          label="Delay between answers"
          hint="Minimum gap between two answers, across every tab. Paces requests so a page full of questions is not a burst."
          id="answerDelay"
          value={settings.answerDelayMs}
          presets={ANSWER_DELAY_PRESETS}
          onChange={(value) => update('answerDelayMs', value)}
        />

        <Field
          label="Request timeout (ms)"
          htmlFor="requestTimeoutMs"
          hint="How long to wait for the backend. Between 2000 and 120000."
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
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Behaviour</h2>
        </div>

        <Toggle
          label="Detect questions automatically"
          hint="Watches enabled pages and answers questions as they appear."
          checked={settings.autoDetect}
          onChange={(value) => update('autoDetect', value)}
        />
        <Toggle
          label="Fill answers into the page"
          hint="Selects the matching option or types into the answer field, using ordinary DOM events. It never clicks Next, Submit or any other control."
          checked={settings.autoFill}
          onChange={(value) => update('autoFill', value)}
        />
        <Toggle
          label="Cache answers"
          hint="Reuses the answer when the same question is seen again, including after navigating back to it."
          checked={settings.cacheEnabled}
          onChange={(value) => update('cacheEnabled', value)}
        />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Backend</h2>
        </div>

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

        <Field
          label="Maximum context length"
          htmlFor="maxContextLength"
          hint="Characters of surrounding page content sent with a question. 0 sends the question only."
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
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Activity log</h2>
        </div>

        <Toggle
          label="Record activity"
          hint="Keeps a local record of questions, answers and errors. Stored in this browser only and never transmitted."
          checked={settings.logEnabled}
          onChange={(value) => update('logEnabled', value)}
        />

        <Field
          label="Entries to keep"
          htmlFor="logLimit"
          hint={`Between ${LOG_LIMIT_BOUNDS.min} and ${LOG_LIMIT_BOUNDS.max}. The oldest are dropped first.`}
        >
          <input
            id="logLimit"
            type="number"
            min={LOG_LIMIT_BOUNDS.min}
            max={LOG_LIMIT_BOUNDS.max}
            step={50}
            value={settings.logLimit}
            onChange={(event) => update('logLimit', Number(event.target.value))}
          />
        </Field>
      </section>
    </div>
  );
}
