import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SETTINGS } from '../shared/constants';
import type { ExtensionSettings } from '../shared/types';
import { getSettings, saveSettings, send } from './api';
import { MonitorTab } from './tabs/MonitorTab';
import { SettingsTab } from './tabs/SettingsTab';
import { SitesTab } from './tabs/SitesTab';
import { LogsTab } from './tabs/LogsTab';

type TabId = 'monitor' | 'settings' | 'sites' | 'logs';

interface TabDefinition {
  id: TabId;
  label: string;
  title: string;
  subtitle: string;
  /** Single glyph in the sidebar. Monochrome, so shape does the work. */
  glyph: string;
}

const TABS: readonly TabDefinition[] = [
  {
    id: 'monitor',
    label: 'Monitor',
    title: 'Monitor',
    subtitle: 'What the extension is doing right now.',
    glyph: '◉',
  },
  {
    id: 'settings',
    label: 'Settings',
    title: 'Settings',
    subtitle: 'Provider, timing, behaviour and the backend it talks to.',
    glyph: '⚙',
  },
  {
    id: 'sites',
    label: 'Sites',
    title: 'Sites',
    subtitle: 'Where the extension is allowed to run.',
    glyph: '⬒',
  },
  {
    id: 'logs',
    label: 'Activity log',
    title: 'Activity log',
    subtitle: 'Every question, answer and failure, recorded locally.',
    glyph: '☰',
  },
];

type Status = { tone: 'ok' | 'error'; message: string } | null;

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [tab, setTab] = useState<TabId>('monitor');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    void (async () => {
      const current = await getSettings();
      if (current) {
        setSettings(current);
        setSaved(current);
      }
      setLoaded(true);
    })();
  }, []);

  const update = useCallback(
    <K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) => {
      setSettings((current) => ({ ...current, [key]: value }));
      setStatus(null);
    },
    [],
  );

  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);
  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  const save = async () => {
    setBusy(true);
    try {
      const result = await saveSettings(settings);
      if (result) {
        setSettings(result);
        setSaved(result);
        setStatus({ tone: 'ok', message: 'Settings saved.' });
      } else {
        setStatus({ tone: 'error', message: 'The settings could not be saved.' });
      }
    } finally {
      setBusy(false);
    }
  };

  const revert = () => {
    setSettings(saved);
    setStatus(null);
  };

  const clearCache = async () => {
    await send({ kind: 'cache:clear' });
    setStatus({ tone: 'ok', message: 'Cached answers cleared.' });
  };

  if (!loaded) {
    return (
      <div className="boot">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const editable = tab === 'settings' || tab === 'sites';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            ?
          </span>
          <span className="brand-name">
            Browser
            <strong>Assistant</strong>
          </span>
        </div>

        <nav className="sidebar-nav" aria-label="Sections">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`nav-item ${tab === entry.id ? 'nav-item-on' : ''}`}
              aria-current={tab === entry.id ? 'page' : undefined}
              onClick={() => setTab(entry.id)}
            >
              <span className="nav-glyph" aria-hidden="true">
                {entry.glyph}
              </span>
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <p>Answers come from your own backend.</p>
          <p className="sidebar-url">{saved.backendUrl}</p>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1>{active!.title}</h1>
            <p>{active!.subtitle}</p>
          </div>

          {editable ? (
            <div className="topbar-actions">
              {status ? (
                <span className={`status ${status.tone}`}>{status.message}</span>
              ) : dirty ? (
                <span className="status warn">Unsaved changes</span>
              ) : (
                <span className="muted">All changes saved</span>
              )}

              <button type="button" className="ghost" onClick={() => void clearCache()}>
                Clear cached answers
              </button>
              <button type="button" className="ghost" onClick={revert} disabled={!dirty || busy}>
                Revert
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void save()}
                disabled={!dirty || busy}
              >
                Save changes
              </button>
            </div>
          ) : null}
        </header>

        <main className="content">
          {tab === 'monitor' ? <MonitorTab settings={saved} /> : null}
          {tab === 'settings' ? <SettingsTab settings={settings} update={update} /> : null}
          {tab === 'sites' ? <SitesTab settings={settings} update={update} /> : null}
          {tab === 'logs' ? <LogsTab /> : null}
        </main>
      </div>
    </div>
  );
}
