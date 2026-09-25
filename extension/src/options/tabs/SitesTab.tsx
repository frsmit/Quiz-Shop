import type { ExtensionSettings } from '../../shared/types';
import { OriginManager } from '../components/OriginManager';

interface SitesTabProps {
  settings: ExtensionSettings;
  update: <K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) => void;
}

export function SitesTab({ settings, update }: SitesTabProps) {
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Where the extension runs</h2>
        </div>

        <p className="hint">
          Nothing runs anywhere until you say so. The quickest way to enable a site is the{' '}
          <strong>Enable on this site</strong> button in the toolbar popup while you are on it —
          Chrome asks for access there and then. You can also add one by hand below.
        </p>

        <OriginManager
          origins={settings.enabledOrigins}
          onChange={(origins) => update('enabledOrigins', origins)}
        />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Always enabled</h2>
        </div>
        <p className="hint">
          <code>localhost</code> and <code>127.0.0.1</code> are covered by the extension's manifest
          so the bundled demo works out of the box. They cannot be removed here, and they are not
          listed above because doing so would run the content script twice.
        </p>
      </section>
    </div>
  );
}
