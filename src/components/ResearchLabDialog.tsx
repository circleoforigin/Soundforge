import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { apiUrl } from '../config/api';
import { normalizeDiscoveredAudioDevices } from '../services/research-lab/normalizeAudioDevices';
import {
  readResearchLabIdentifyFailure,
  sanitizeDiagnosticForDisplay,
  type DeviceActionMessage,
} from '../services/research-lab/researchLabErrors';
import type {
  AudioDevice,
  AudioDeviceActionResponse,
  AudioDeviceDiscoveryResponse,
  AudioDevicePresentationResponse,
  AudioStreamListResponse,
  AudioStreamSnapshot,
  AudioStreamSnapshotResponse,
  AudioTopologyKind,
  AudioTransportOption,
  AudioTransportScope,
  ContinuousHttpFramingMode,
} from '../models/ResearchLab';

interface ResearchLabDialogProps {
  onClose: () => void;
}

type ApiFailure = {
  message?: string;
  code?: string;
  diagnostic?: unknown;
  stream?: AudioStreamSnapshot;
};

const terminalLifecycles = new Set(['stopped', 'error']);

function sanitizedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(authorization|password|secret|token)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[redacted-path]')
    .slice(0, 240);
}

interface ResearchLabErrorBoundaryProps {
  children: ReactNode;
  fallback: (message: string, retry: () => void) => ReactNode;
}

class ResearchLabErrorBoundary extends Component<
  ResearchLabErrorBoundaryProps,
  { message: string | null }
> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: sanitizedErrorMessage(error) };
  }

  componentDidCatch(error: unknown) {
    console.error('Research Lab render error:', sanitizedErrorMessage(error));
  }

  render() {
    if (this.state.message) {
      return this.props.fallback(this.state.message, () => this.setState({ message: null }));
    }
    return this.props.children;
  }
}

function titleCase(value: string): string {
  return value
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatScope(scope: AudioTransportScope | null): string {
  return scope ? titleCase(scope) : 'Not resolved';
}

function formatTopologyKind(kind: AudioTopologyKind): string {
  return titleCase(kind);
}

function formatBytes(value: number): string {
  if (value < 1_024) {
    return `${value} B`;
  }
  if (value < 1_048_576) {
    return `${(value / 1_024).toFixed(1)} KB`;
  }
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

async function readFailure(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json() as ApiFailure;
    return data.message ?? fallback;
  } catch {
    return fallback;
  }
}

function TransportRow({
  device,
  transport,
  busy,
  onStart,
}: {
  device: AudioDevice;
  transport: AudioTransportOption;
  busy: boolean;
  onStart: (device: AudioDevice, transport: AudioTransportOption) => void;
}) {
  const canStart =
    transport.operation === 'persistent-stream' && transport.availability !== 'unavailable';
  return (
    <div className="research-transport-row">
      <div className="research-transport-main">
        <div className="research-transport-title">{transport.name}</div>
        <div className="research-inline-badges">
          <span className={`research-badge ${transport.availability}`}>
            {titleCase(transport.availability)}
          </span>
          <span className="research-badge neutral">{formatScope(transport.scope)}</span>
          <span className="research-badge neutral">
            {transport.independentlyTargetable ? 'Independent' : 'Shared target'}
          </span>
        </div>
        {transport.limitation && (
          <div className="research-transport-limitation">{transport.limitation}</div>
        )}
      </div>
      {canStart && (
        <button disabled={busy} onClick={() => onStart(device, transport)}>
          {busy ? 'Starting…' : 'Start Stream'}
        </button>
      )}
    </div>
  );
}

function ResearchDeviceCard({
  device,
  startingKey,
  identifying,
  actionMessage,
  onStart,
  onIdentify,
  editing,
  aliasDraft,
  savingAlias,
  renameError,
  onBeginRename,
  onAliasDraftChange,
  onSaveAlias,
  onCancelRename,
}: {
  device: AudioDevice;
  startingKey: string | null;
  identifying: boolean;
  actionMessage?: DeviceActionMessage;
  onStart: (device: AudioDevice, transport: AudioTransportOption) => void;
  onIdentify: (device: AudioDevice) => void;
  editing: boolean;
  aliasDraft: string;
  savingAlias: boolean;
  renameError?: string;
  onBeginRename: (device: AudioDevice) => void;
  onAliasDraftChange: (value: string) => void;
  onSaveAlias: (device: AudioDevice, alias: string | null) => void;
  onCancelRename: () => void;
}) {
  const alias = device.presentation?.alias;
  return (
    <article className="research-device-card">
      <header>
        <div>
          <h4>{alias ?? device.model ?? device.name}</h4>
          {alias && device.model && <div>{device.model}</div>}
          {(alias || device.model) && <div>{device.name}</div>}
          <div>{titleCase(device.provider)} · Physical Device</div>
        </div>
        <div className="research-device-header-actions">
          {device.diagnosticActions.map((action) => action.id === 'identify-speaker' && (
            <button
              key={action.id}
              disabled={action.availability !== 'available' || identifying}
              title={action.limitation ?? ''}
              onClick={() => onIdentify(device)}
            >
              {identifying ? 'Identifying…' : action.name}
            </button>
          ))}
          <button disabled={savingAlias} onClick={() => onBeginRename(device)}>
            {alias ? 'Rename' : 'Set Name'}
          </button>
        </div>
      </header>
      {editing && (
        <div className="research-alias-editor">
          <input
            autoFocus
            maxLength={80}
            placeholder="Friendly Research Lab name"
            value={aliasDraft}
            onChange={(event) => onAliasDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                onSaveAlias(device, aliasDraft);
              } else if (event.key === 'Escape') {
                onCancelRename();
              }
            }}
          />
          <button disabled={savingAlias} onClick={() => onSaveAlias(device, aliasDraft)}>
            {savingAlias ? 'Saving…' : 'Save'}
          </button>
          {alias && (
            <button disabled={savingAlias} onClick={() => onSaveAlias(device, null)}>
              Clear
            </button>
          )}
          <button disabled={savingAlias} onClick={onCancelRename}>Cancel</button>
        </div>
      )}
      {renameError && <div className="research-error-message">{renameError}</div>}
      {actionMessage && (
        <div className={actionMessage.error
          ? 'research-error-message'
          : 'research-device-action-message'}>
          {actionMessage.summary}
          {actionMessage.diagnostic && (
            <details className="research-action-diagnostic">
              <summary>Diagnostic details</summary>
              <pre>{actionMessage.diagnostic}</pre>
            </details>
          )}
        </div>
      )}
      <div className="research-transport-list">
        {device.transports.map((transport) => (
          <TransportRow
            key={transport.id}
            device={device}
            transport={transport}
            busy={startingKey === `${device.id}:${transport.id}`}
            onStart={onStart}
          />
        ))}
      </div>
      <details className="research-identity-details">
        <summary>Topology and identity</summary>
        <div>Device ID: <code>{device.id}</code></div>
        {device.identity.providerIdentifierSuffix && (
          <div>
            Provider ID suffix: <code>…{device.identity.providerIdentifierSuffix}</code>
          </div>
        )}
        <div>Logical player: {device.identity.logicalPlayerName}</div>
        {device.identity.componentRole && (
          <div>Component role: {device.identity.componentRole}</div>
        )}
        <div className="research-topology-list">
          {device.topology.map((node) => (
            <div key={node.id} className={node.selected ? 'selected' : ''}>
              <span>{formatTopologyKind(node.kind)}</span>
              <strong>{node.name}</strong>
              {node.selected && <em>Selected device</em>}
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}

function DiagnosticValue({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="research-diagnostic-value">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StreamExperiment({
  stream,
  device,
  busyAction,
  onTone,
  onStop,
}: {
  stream: AudioStreamSnapshot;
  device?: AudioDevice;
  busyAction?: 'tone' | 'stop';
  onTone: (streamId: string) => void;
  onStop: (streamId: string) => void;
}) {
  const terminal = terminalLifecycles.has(stream.lifecycle);
  const canTone = !terminal && stream.transport?.bound && stream.toneReady;
  return (
    <article className={`research-stream-card ${stream.lifecycle === 'error' ? 'error' : ''}`}>
      <header className="research-stream-header">
        <div>
          <h3>{device?.name ?? 'Audio stream experiment'}</h3>
          <div className="research-stream-subtitle">
            {stream.transportId ? titleCase(stream.transportId) : 'Unspecified transport'}
          </div>
        </div>
        <span className={`research-badge ${terminal ? 'unavailable' : 'available'}`}>
          {titleCase(stream.lifecycle)}
        </span>
      </header>

      <div className="research-stream-actions">
        <button
          disabled={!canTone || Boolean(busyAction)}
          title={!stream.httpClient.connected ? 'Waiting for the audio device to connect.' : ''}
          onClick={() => onTone(stream.id)}
        >
          {busyAction === 'tone' ? 'Sending…' : 'Play Test Tone'}
        </button>
        <button disabled={terminal || Boolean(busyAction)} onClick={() => onStop(stream.id)}>
          {busyAction === 'stop' ? 'Stopping…' : 'Stop Stream'}
        </button>
      </div>

      {!terminal && !stream.httpClient.connected && (
        <div className="research-waiting-message">
          Stream is attached; waiting for the audio device’s HTTP client.
        </div>
      )}

      <div className="research-diagnostic-sections">
        <section>
          <h4>Stream</h4>
          <div className="research-diagnostic-grid">
            <DiagnosticValue label="Lifecycle" value={titleCase(stream.lifecycle)} />
            <DiagnosticValue label="Source" value={titleCase(stream.source)} />
          </div>
        </section>
        <section>
          <h4>Transport</h4>
          <div className="research-diagnostic-grid">
            <DiagnosticValue label="State" value={titleCase(stream.transport?.state ?? 'none')} />
            <DiagnosticValue label="Target scope" value={formatScope(stream.transport?.targetScope ?? null)} />
            <DiagnosticValue label="Target" value={stream.transport?.targetDescription ?? '—'} />
            <DiagnosticValue
              label="Independent"
              value={stream.transport?.independentlyTargetable == null
                ? '—'
                : stream.transport.independentlyTargetable ? 'Yes' : 'No'}
            />
            <DiagnosticValue label="Bound" value={stream.transport?.bound ? 'Yes' : 'No'} />
            <DiagnosticValue label="Provider playback" value={stream.transport?.providerPlaybackState ?? '—'} />
          </div>
          {stream.transport?.lastError && (
            <div className="research-error-message">{stream.transport.lastError}</div>
          )}
        </section>
        <section>
          <h4>Encoder</h4>
          <div className="research-diagnostic-grid">
            <DiagnosticValue label="State" value={titleCase(stream.encoder.state)} />
            <DiagnosticValue label="Format" value={`${stream.encoder.sampleRate.toLocaleString()} Hz · ${stream.encoder.channels} ch · ${(stream.encoder.bitrate / 1_000).toFixed(0)} kbps`} />
            <DiagnosticValue label="Frames" value={stream.encoder.framesGenerated.toLocaleString()} />
            <DiagnosticValue label="PCM bytes" value={formatBytes(stream.encoder.pcmBytesGenerated)} />
            <DiagnosticValue label="Encoded bytes" value={formatBytes(stream.encoder.encodedBytesProduced)} />
            <DiagnosticValue label="Startup buffer" value={formatBytes(stream.encoder.startupBufferBytes)} />
            <DiagnosticValue label="Startup ready" value={stream.encoder.startupBufferReady ? 'Yes' : 'No'} />
            <DiagnosticValue label="PCM paused" value={stream.encoder.pcmPausedForReady ? 'Yes' : 'No'} />
            <DiagnosticValue label="Input backpressure" value={stream.encoder.stdinBackpressured ? 'Yes' : 'No'} />
          </div>
        </section>
        <section>
          <h4>Connection</h4>
          <div className="research-diagnostic-grid">
            <DiagnosticValue label="Connected" value={stream.httpClient.connected ? 'Yes' : 'No'} />
            <DiagnosticValue label="Framing" value={titleCase(stream.httpClient.framingMode ?? 'chunked')} />
            <DiagnosticValue label="Connected at" value={formatTimestamp(stream.httpClient.connectedAt)} />
            <DiagnosticValue label="Disconnected at" value={formatTimestamp(stream.httpClient.disconnectedAt)} />
            <DiagnosticValue label="Delivered" value={formatBytes(stream.httpClient.deliveredBytes)} />
            <DiagnosticValue label="Writable queue" value={formatBytes(stream.httpClient.writableLength)} />
            <DiagnosticValue label="Backpressure" value={stream.httpClient.backpressured ? 'Yes' : 'No'} />
            <DiagnosticValue label="HTTP consumers" value={stream.httpClient.connectionCount ?? 0} />
            <DiagnosticValue label="Current consumer" value={stream.httpClient.currentConnectionOrdinal ? `#${stream.httpClient.currentConnectionOrdinal}` : '—'} />
            <DiagnosticValue label="Awaiting reconnect" value={stream.httpClient.awaitingReconnect ? 'Yes' : 'No'} />
          </div>
          {(stream.httpClient.connections ?? []).slice(-2).map((connection) => (
            <div className="research-connection-summary" key={connection.ordinal}>
              <strong>Consumer #{connection.ordinal}</strong>
              <span>{connection.role === 'startup-reconnect' ? 'Startup reconnect' : 'Startup consumer'}</span>
              <span>{connection.radioStyleUserAgent ? 'Radio-style User-Agent: Yes' : 'Radio-style User-Agent: No'}</span>
              <span>{connection.disconnectedAt
                ? `${connection.durationMs ?? 0} ms · ${formatBytes(connection.bytesDelivered)} · ${connection.disconnectReason ?? 'Disconnected'}`
                : `Connected · ${formatBytes(connection.bytesDelivered)}`}</span>
            </div>
          ))}
        </section>
      </div>

      <details className="research-event-console">
        <summary>Events ({stream.recentEvents.length})</summary>
        <div className="research-events">
          {stream.recentEvents.length === 0 ? (
            <div className="research-empty">No diagnostic events yet.</div>
          ) : stream.recentEvents.map((event, index) => (
            <div key={`${event.timestamp}:${event.code}:${index}`} className={`research-event ${event.category}`}>
              <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
              <span className="research-event-category">{event.category}</span>
              <span>{event.message}</span>
              {event.details && Object.keys(event.details).length > 0 && (
                <pre>{JSON.stringify(event.details, null, 2)}</pre>
              )}
            </div>
          ))}
        </div>
      </details>

      <details className="research-identity-details">
        <summary>Technical details</summary>
        <div>Stream ID: <code>{stream.id}</code></div>
        <div>Device ID: <code>{stream.deviceId ?? '—'}</code></div>
        <div>Transport ID: <code>{stream.transportId ?? '—'}</code></div>
        <div>Encoder PID: <code>{stream.encoder.pid ?? '—'}</code></div>
        <div>Created: {formatTimestamp(stream.createdAt)}</div>
        <div>Stopped: {formatTimestamp(stream.stoppedAt)}</div>
      </details>
    </article>
  );
}

function ResearchLabDialogContent({ onClose }: ResearchLabDialogProps) {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [streams, setStreams] = useState<AudioStreamSnapshot[]>([]);
  const [discovering, setDiscovering] = useState(true);
  const [discoveryVersion, setDiscoveryVersion] = useState(0);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryWarning, setDiscoveryWarning] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [startingKey, setStartingKey] = useState<string | null>(null);
  const [identifyingDeviceId, setIdentifyingDeviceId] = useState<string | null>(null);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState('');
  const [savingAlias, setSavingAlias] = useState(false);
  const [renameErrors, setRenameErrors] = useState<Record<string, string>>({});
  const [deviceActionMessages, setDeviceActionMessages] = useState<
    Record<string, DeviceActionMessage>
  >({});
  const [busyActions, setBusyActions] = useState<Record<string, 'tone' | 'stop'>>({});
  const [httpFramingMode, setHttpFramingMode] = useState<ContinuousHttpFramingMode>('chunked');

  const refreshDevices = useCallback(async () => {
    setDiscovering(true);
    setDiscoveryError(null);
    setDiscoveryWarning(null);
    try {
      const response = await fetch(apiUrl('/api/research-lab/devices'));
      if (!response.ok) {
        throw new Error(await readFailure(response, 'Unable to discover audio devices.'));
      }
      const data = await response.json() as AudioDeviceDiscoveryResponse;
      const normalized = normalizeDiscoveredAudioDevices(data);
      setDevices(normalized.devices);
      setDiscoveryVersion((current) => current + 1);
      setDiscoveryWarning(normalized.warnings.length > 0
        ? normalized.warnings.join(' ')
        : null);
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : 'Unable to discover audio devices.');
    } finally {
      setDiscovering(false);
    }
  }, []);

  const refreshStreams = useCallback(async () => {
    try {
      const response = await fetch(apiUrl('/api/research-lab/streams'));
      if (!response.ok) {
        throw new Error(await readFailure(response, 'Unable to load stream diagnostics.'));
      }
      const data = await response.json() as AudioStreamListResponse;
      setStreams(data.streams);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to load stream diagnostics.');
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshDevices();
      void refreshStreams();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshDevices, refreshStreams]);

  const hasActiveStreams = useMemo(
    () => streams.some((stream) => !terminalLifecycles.has(stream.lifecycle)),
    [streams]
  );

  useEffect(() => {
    if (!hasActiveStreams) {
      return;
    }
    const timer = window.setInterval(() => void refreshStreams(), 1_000);
    return () => window.clearInterval(timer);
  }, [hasActiveStreams, refreshStreams]);

  async function startStream(device: AudioDevice, transport: AudioTransportOption) {
    const key = `${device.id}:${transport.id}`;
    setStartingKey(key);
    setActionError(null);
    try {
      const response = await fetch(apiUrl('/api/research-lab/streams'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: device.id,
          transportId: transport.id,
          httpFramingMode,
        }),
      });
      if (!response.ok) {
        throw new Error(await readFailure(response, 'Unable to start stream.'));
      }
      const data = await response.json() as AudioStreamSnapshotResponse;
      setStreams((current) => [data.stream, ...current.filter((item) => item.id !== data.stream.id)]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to start stream.');
    } finally {
      setStartingKey(null);
    }
  }

  async function identifySpeaker(device: AudioDevice) {
    setIdentifyingDeviceId(device.id);
    setDeviceActionMessages((current) => {
      const next = { ...current };
      delete next[device.id];
      return next;
    });
    try {
      const response = await fetch(apiUrl(
        `/api/research-lab/devices/${encodeURIComponent(device.id)}/identify`
      ), { method: 'POST' });
      if (!response.ok) {
        const failure = await readResearchLabIdentifyFailure(response);
        setDeviceActionMessages((current) => ({ ...current, [device.id]: failure }));
        return;
      }
      await response.json() as AudioDeviceActionResponse;
      setDeviceActionMessages((current) => ({
        ...current,
        [device.id]: {
          summary: 'Identification chime accepted.',
          error: false,
        },
      }));
    } catch (error) {
      setDeviceActionMessages((current) => ({
        ...current,
        [device.id]: {
          summary: error instanceof Error
            ? sanitizedErrorMessage(error)
            : 'Unable to identify this speaker.',
          diagnostic: sanitizeDiagnosticForDisplay({
            timestamp: new Date().toISOString(),
            code: 'NETWORK_OR_CLIENT_ERROR',
          }),
          error: true,
        },
      }));
    } finally {
      setIdentifyingDeviceId(null);
    }
  }

  function beginRename(device: AudioDevice) {
    setEditingDeviceId(device.id);
    setAliasDraft(device.presentation?.alias ?? '');
    setRenameErrors((current) => {
      const next = { ...current };
      delete next[device.id];
      return next;
    });
  }

  async function saveAlias(device: AudioDevice, alias: string | null) {
    setSavingAlias(true);
    setRenameErrors((current) => {
      const next = { ...current };
      delete next[device.id];
      return next;
    });
    try {
      const response = await fetch(apiUrl(
        `/api/research-lab/devices/${encodeURIComponent(device.id)}/presentation`
      ), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias }),
      });
      if (!response.ok) {
        throw new Error(await readFailure(response, 'Unable to save device name.'));
      }
      const result = await response.json() as AudioDevicePresentationResponse;
      setDevices((current) => current.map((candidate) =>
        candidate.id === device.id
          ? {
              ...candidate,
              ...(result.presentation.alias
                ? { presentation: { alias: result.presentation.alias } }
                : { presentation: undefined }),
            }
          : candidate
      ));
      setEditingDeviceId(null);
      setAliasDraft('');
    } catch (error) {
      setRenameErrors((current) => ({
        ...current,
        [device.id]: error instanceof Error
          ? sanitizedErrorMessage(error)
          : 'Unable to save device name.',
      }));
    } finally {
      setSavingAlias(false);
    }
  }

  async function runStreamAction(streamId: string, action: 'tone' | 'stop') {
    setBusyActions((current) => ({ ...current, [streamId]: action }));
    setActionError(null);
    try {
      const response = await fetch(apiUrl(
        action === 'tone'
          ? `/api/research-lab/streams/${encodeURIComponent(streamId)}/tone`
          : `/api/research-lab/streams/${encodeURIComponent(streamId)}`
      ), { method: action === 'tone' ? 'POST' : 'DELETE' });
      const data = await response.json() as ApiFailure & Partial<AudioStreamSnapshotResponse>;
      if (data.stream) {
        setStreams((current) => current.map((stream) =>
          stream.id === data.stream?.id ? data.stream : stream
        ));
      }
      if (!response.ok) {
        throw new Error(data.message ?? `Unable to ${action} stream.`);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Unable to ${action} stream.`);
    } finally {
      setBusyActions((current) => {
        const next = { ...current };
        delete next[streamId];
        return next;
      });
    }
  }

  return (
    <div className="dialog-backdrop research-lab-backdrop">
      <div className="research-lab-dialog">
        <header className="research-lab-header">
          <div>
            <h2>Research Lab</h2>
            <p>Experimental audio devices, transports, streams, and diagnostics.</p>
          </div>
          <button onClick={onClose}>Close</button>
        </header>

        <div className="research-lab-content">
          <section className="research-lab-panel">
            <div className="research-section-heading">
              <div>
                <h3>Audio Devices</h3>
                <p>Choose a physical device and an available experimental transport.</p>
              </div>
              <button disabled={discovering} onClick={() => void refreshDevices()}>
                {discovering ? 'Discovering…' : 'Refresh Devices'}
              </button>
            </div>
            <div className="research-framing-control">
              <label>
                <span>HTTP Stream Framing</span>
                <select
                  value={httpFramingMode}
                  disabled={startingKey !== null}
                  onChange={(event) => setHttpFramingMode(
                    event.target.value as ContinuousHttpFramingMode
                  )}
                >
                  <option value="chunked">Node Chunked</option>
                  <option value="indefinite-content-length">Indefinite Content-Length</option>
                </select>
              </label>
              <small>
                {httpFramingMode === 'chunked'
                  ? 'Current default HTTP streaming behavior.'
                  : 'Experimental non-chunked framing for compatibility testing.'}
              </small>
            </div>
            {discoveryError && <div className="research-error-message">{discoveryError}</div>}
            {discoveryWarning && (
              <div className="research-warning-message">{discoveryWarning}</div>
            )}
            {!discovering && !discoveryError && devices.length === 0 && (
              <div className="research-empty">No physical audio devices were discovered.</div>
            )}
            <div className="research-device-list">
              {devices.map((device) => (
                <ResearchLabErrorBoundary
                  key={`${discoveryVersion}:${device.id}`}
                  fallback={(message) => (
                    <article className="research-device-card error">
                      <h4>Unable to render audio device</h4>
                      <div className="research-error-message">{message}</div>
                    </article>
                  )}
                >
                  <ResearchDeviceCard
                    device={device}
                    startingKey={startingKey}
                    identifying={identifyingDeviceId === device.id}
                    actionMessage={deviceActionMessages[device.id]}
                    onStart={(targetDevice, targetTransport) =>
                      void startStream(targetDevice, targetTransport)}
                    onIdentify={(targetDevice) => void identifySpeaker(targetDevice)}
                    editing={editingDeviceId === device.id}
                    aliasDraft={editingDeviceId === device.id ? aliasDraft : ''}
                    savingAlias={savingAlias && editingDeviceId === device.id}
                    renameError={renameErrors[device.id]}
                    onBeginRename={beginRename}
                    onAliasDraftChange={setAliasDraft}
                    onSaveAlias={(targetDevice, alias) => void saveAlias(targetDevice, alias)}
                    onCancelRename={() => {
                      setEditingDeviceId(null);
                      setAliasDraft('');
                    }}
                  />
                </ResearchLabErrorBoundary>
              ))}
            </div>
          </section>

          <section className="research-lab-panel research-streams-panel">
            <div className="research-section-heading">
              <div>
                <h3>Stream Experiments</h3>
                <p>Live controls and sanitized runtime diagnostics.</p>
              </div>
            </div>
            {actionError && <div className="research-error-message">{actionError}</div>}
            {streams.length === 0 ? (
              <div className="research-empty">Start an available continuous transport to begin.</div>
            ) : (
              <div className="research-stream-list">
                {streams.map((stream) => (
                  <StreamExperiment
                    key={stream.id}
                    stream={stream}
                    device={devices.find((device) => device.id === stream.deviceId)}
                    busyAction={busyActions[stream.id]}
                    onTone={(streamId) => void runStreamAction(streamId, 'tone')}
                    onStop={(streamId) => void runStreamAction(streamId, 'stop')}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export default function ResearchLabDialog(props: ResearchLabDialogProps) {
  return (
    <ResearchLabErrorBoundary
      fallback={(message, retry) => (
        <div className="dialog-backdrop research-lab-backdrop">
          <div className="research-lab-dialog research-lab-failure">
            <h2>Research Lab could not render</h2>
            <div className="research-error-message">{message}</div>
            <div className="research-stream-actions">
              <button onClick={retry}>Try Again</button>
              <button onClick={props.onClose}>Close</button>
            </div>
          </div>
        </div>
      )}
    >
      <ResearchLabDialogContent {...props} />
    </ResearchLabErrorBoundary>
  );
}
