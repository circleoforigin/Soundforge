import type { AppSettings } from '../models/AppSettings';

interface Props {
  settings: AppSettings;
  saving: boolean;
  onChange: (settings: AppSettings) => void;
  onViewLog: () => void;
  onClose: () => void;
}

export default function SettingsDialog({ settings, saving, onChange, onViewLog, onClose }: Props) {
  return <div className="dialog-backdrop">
    <div className="dialog settings-dialog">
      <h2>Settings</h2>
      <section>
        <h3>Diagnostics</h3>
        <label className="settings-checkbox">
          <input type="checkbox" checked={settings.diagnosticsEnabled} disabled={saving}
            onChange={(event) => onChange({ ...settings, diagnosticsEnabled: event.target.checked })} />
          Enable Diagnostics Logging
        </label>
        <button onClick={onViewLog}>View Diagnostic Log...</button>
      </section>
      <div className="dialog-buttons"><button onClick={onClose}>Close</button></div>
    </div>
  </div>;
}
