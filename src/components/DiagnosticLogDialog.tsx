import { useEffect, useState } from 'react';
import type { DiagnosticLogEntry } from '../models/DiagnosticLog';
import { clearDiagnostics, loadDiagnostics } from '../services/diagnostics/DiagnosticClient';

interface Props { onClose: () => void; }

export default function DiagnosticLogDialog({ onClose }: Props) {
  const [entries, setEntries] = useState<DiagnosticLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    setError(null);
    try { setEntries(await loadDiagnostics()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load diagnostic log.'); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    void loadDiagnostics().then((loadedEntries) => {
      if (active) setEntries(loadedEntries);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Unable to load diagnostic log.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  return <div className="dialog-backdrop diagnostic-log-backdrop">
    <div className="dialog diagnostic-log-dialog">
      <header><div><h2>Diagnostic Log</h2><small>Newest first</small></div><button onClick={onClose}>Close</button></header>
      {loading && <p>Loading…</p>}
      {error && <p className="diagnostic-error">{error}</p>}
      {!loading && !error && entries.length === 0 && <p>No diagnostic entries.</p>}
      <div className="diagnostic-entry-list">
        {entries.map((entry) => <details key={entry.id} className={`diagnostic-entry diagnostic-${entry.level}`}>
          <summary>
            <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
            <strong>{entry.category.toUpperCase()}</strong>
            <span>{entry.message}</span>
          </summary>
          <div className="diagnostic-entry-detail">
            <div>{entry.event}</div>
            {entry.correlationId && <div>Correlation: {entry.correlationId}</div>}
            {entry.details && <pre>{JSON.stringify(entry.details, null, 2)}</pre>}
          </div>
        </details>)}
      </div>
      <footer className="dialog-buttons diagnostic-log-actions">
        <button onClick={() => void refresh()}>Refresh</button>
        <button onClick={() => void (async () => { await clearDiagnostics(); setEntries([]); })()}>Clear Log</button>
        <button onClick={onClose}>Close</button>
      </footer>
    </div>
  </div>;
}
