import { useEffect, useState } from 'react';
import type { DiagnosticLogEntry } from '../models/DiagnosticLog';
import { clearDiagnostics, loadDiagnostics } from '../services/diagnostics/DiagnosticClient';
import { formatDiagnosticReport } from '../services/diagnostics/DiagnosticReportFormatter';

interface Props { onClose: () => void; }

export default function DiagnosticLogDialog({ onClose }: Props) {
  const [entries, setEntries] = useState<DiagnosticLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'room' | 'research' | 'latency' | 'sonos'>('all');
  const filteredEntries = entries.filter((entry) => {
    if (filter === 'all') return true;
    if (filter === 'room') return entry.event.startsWith('room_audio.');
    if (filter === 'latency') return entry.event.startsWith('latency_lab.');
    if (filter === 'research') return entry.event.startsWith('latency_lab.')
      || entry.event.startsWith('research_lab.') || entry.event.startsWith('multi_speaker.');
    return entry.event.startsWith('sonos.') || entry.event.includes('sonos');
  });

  async function copyFullReport() {
    try {
      await navigator.clipboard.writeText(formatDiagnosticReport(filteredEntries));
      setCopyStatus('Full report copied to clipboard.');
      window.setTimeout(() => setCopyStatus(null), 2500);
    } catch { setCopyStatus('Unable to copy the diagnostic report.'); }
  }

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
      <label className="diagnostic-log-filter">Show <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
        <option value="all">All</option>
        <option value="room">Room Audio</option>
        <option value="research">Research Lab</option>
        <option value="latency">Latency Lab</option>
        <option value="sonos">Sonos</option>
      </select></label>
      {!loading && !error && entries.length === 0 && <p>No diagnostic entries.</p>}
      <div className="diagnostic-entry-list">
        {filteredEntries.map((entry) => <details key={entry.id} className={`diagnostic-entry diagnostic-${entry.level}`}>
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
        <button onClick={() => void copyFullReport()} disabled={filteredEntries.length === 0}>Copy Full Report</button>
        {copyStatus && <span role="status">{copyStatus}</span>}
        <button onClick={() => void refresh()}>Refresh</button>
        <button onClick={() => void (async () => { await clearDiagnostics(); setEntries([]); })()}>Clear Log</button>
        <button onClick={onClose}>Close</button>
      </footer>
    </div>
  </div>;
}
