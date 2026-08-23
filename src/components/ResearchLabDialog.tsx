import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { runtimeUrl } from '../config/runtime';
import { recordDiagnostic } from '../services/diagnostics/DiagnosticClient';
import { normalizeDiscoveredAudioDevices } from '../services/research-lab/normalizeAudioDevices';
import {
  audioDeviceSelectorTitle,
  formatAudioDeviceSelectorLabel,
} from '../services/research-lab/audioDeviceLabels';
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
  MultiSpeakerSessionSnapshot,
} from '../models/ResearchLab';
import {
  sonosLatencyExperimentProfiles,
  summarizeSonosLatencyResults,
  type SonosLatencyProfileId,
  type SonosLatencyResultSample,
} from '../models/SonosLatencyLab';

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

async function describeResearchLabFailure(error: unknown, operation: string): Promise<string> {
  if (!(error instanceof TypeError)) return sanitizedErrorMessage(error);
  try {
    const health = await fetch(runtimeUrl('/api/health'));
    if (health.ok) {
      return `Backend reachable; ${operation} failed before receiving an API response.`;
    }
    return `Backend health check also failed (${health.status}).`;
  } catch {
    return 'Backend health check also failed.';
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
        {device.identity.providerIdentifier && (
          <div>Physical Device ID: <code>{device.identity.providerIdentifier}</code></div>
        )}
        {device.identity.providerIdentifierSuffix && (
          <div>
            Provider ID suffix: <code>…{device.identity.providerIdentifierSuffix}</code>
          </div>
        )}
        <div>Logical player: {device.identity.logicalPlayerName}</div>
        {device.model && <div>Model: {device.model}</div>}
        {device.identity.modelNumber && <div>Model number: {device.identity.modelNumber}</div>}
        {device.identity.serialNumber && <div>Serial number: {device.identity.serialNumber}</div>}
        {device.identity.networkAddress && <div>IP address: <code>{device.identity.networkAddress}</code></div>}
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
            <DiagnosticValue
              label="Encoded"
              value={`${((stream.telemetry?.encodedBitsPerSecond ?? 0) / 1_000).toFixed(1)} kbps`}
            />
            <DiagnosticValue
              label="Delivered"
              value={`${((stream.telemetry?.deliveredBitsPerSecond ?? 0) / 1_000).toFixed(1)} kbps`}
            />
            <DiagnosticValue
              label="Encoded min / avg / max"
              value={stream.telemetry
                ? `${(stream.telemetry.encodedRate.minimum / 1_000).toFixed(1)} / ${(stream.telemetry.encodedRate.average / 1_000).toFixed(1)} / ${(stream.telemetry.encodedRate.maximum / 1_000).toFixed(1)} kbps`
                : '—'}
            />
            <DiagnosticValue
              label="Delivered min / avg / max"
              value={stream.telemetry
                ? `${(stream.telemetry.deliveredRate.minimum / 1_000).toFixed(1)} / ${(stream.telemetry.deliveredRate.average / 1_000).toFixed(1)} / ${(stream.telemetry.deliveredRate.maximum / 1_000).toFixed(1)} kbps`
                : '—'}
            />
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
  const [activeTab, setActiveTab] = useState<'streams' | 'multi' | 'latency'>('streams');
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
  const [speakerAId, setSpeakerAId] = useState('');
  const [speakerBId, setSpeakerBId] = useState('');
  const [multiSession, setMultiSession] = useState<MultiSpeakerSessionSnapshot | null>(null);
  const [multiBusy, setMultiBusy] = useState<string | null>(null);
  const [multiError, setMultiError] = useState<string | null>(null);
  const [multiMessage, setMultiMessage] = useState<string | null>(null);
  const [multiMode, setMultiMode] = useState<'standard' | 'wav-timing'>('standard');
  const [timingImpression, setTimingImpression] = useState<'simultaneous' | 'slight-echo' | 'double-hit'>('simultaneous');
  const [estimatedTimingSkew, setEstimatedTimingSkew] = useState('');
  const [latencyDeviceId, setLatencyDeviceId] = useState('');
  const [latencyProfileId, setLatencyProfileId] = useState<SonosLatencyProfileId>('aac-radio');
  const [latencyStreamId, setLatencyStreamId] = useState<string | null>(null);
  const [latencyBusy, setLatencyBusy] = useState<'start' | 'tone' | 'stop' | null>(null);
  const [latencyError, setLatencyError] = useState<string | null>(null);
  const [observedDelay, setObservedDelay] = useState('');
  const [latencyResults, setLatencyResults] = useState<SonosLatencyResultSample[]>([]);

  const multiEligibleDevices = useMemo(() => devices.filter((device) =>
    device.transports.some((transport) => transport.id === 'sonos-local-continuous'
      && transport.operation === 'persistent-stream'
      && transport.scope === 'physical-device'
      && transport.independentlyTargetable
      && transport.availability !== 'unavailable')
  ), [devices]);
  const latencyProfile = sonosLatencyExperimentProfiles.find(
    (profile) => profile.id === latencyProfileId
  )!;
  const latencyStream = streams.find((stream) => stream.id === latencyStreamId);
  const latencyToneCanAttempt = Boolean(
    latencyStream
    && !terminalLifecycles.has(latencyStream.lifecycle)
    && latencyStream.transport?.bound
    && latencyStream.httpClient.connected
    && latencyStream.httpClient.deliveredBytes > 0
    && !latencyStream.httpClient.backpressured
    && !latencyStream.encoder.stdinBackpressured
  );
  const latencyDevice = devices.find((device) => device.id === latencyDeviceId);
  const latencyStreamActive = Boolean(
    latencyStream && !terminalLifecycles.has(latencyStream.lifecycle)
  );
  const latencyToneCodes = latencyStream?.recentEvents.map((event) => event.code) ?? [];
  const lastToneRequest = latencyToneCodes.lastIndexOf('latency_lab.tone_requested');
  const lastToneStarted = latencyToneCodes.lastIndexOf('latency_lab.tone_pcm_started');
  const lastToneCompleted = latencyToneCodes.lastIndexOf('latency_lab.tone_pcm_completed');
  const latencyToneStatus = lastToneRequest < 0
    ? null
    : lastToneCompleted > lastToneRequest
      ? 'Tone completed — silence resumed'
      : lastToneStarted > lastToneRequest
        ? 'Tone entered PCM'
        : 'Tone requested';
  const latencySummaries = sonosLatencyExperimentProfiles.map((profile) =>
    summarizeSonosLatencyResults(profile.id, latencyResults));

  const refreshDevices = useCallback(async (forceRefresh = false) => {
    setDiscovering(true);
    setDiscoveryError(null);
    setDiscoveryWarning(null);
    try {
      const response = await fetch(runtimeUrl(
        `/api/research-lab/devices${forceRefresh ? '?refresh=true' : ''}`
      ));
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
      setDiscoveryError(await describeResearchLabFailure(error, 'Research Lab device discovery'));
    } finally {
      setDiscovering(false);
    }
  }, []);

  const refreshStreams = useCallback(async () => {
    try {
      const response = await fetch(runtimeUrl('/api/research-lab/streams'));
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
      void refreshDevices(false);
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

  const multiSessionId = multiSession?.id;
  const multiSessionState = multiSession?.state;

  useEffect(() => {
    if (!multiSessionId || multiSessionState === 'stopped') return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(runtimeUrl(`/api/research-lab/multi-speaker-sessions/${encodeURIComponent(multiSessionId)}`));
        if (response.ok) {
          const data = await response.json() as { ok: true; session: MultiSpeakerSessionSnapshot };
          setMultiSession(data.session);
        }
      } catch {
        // The next poll or an explicit action can recover transient diagnostics failures.
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [multiSessionId, multiSessionState]);

  async function multiAction(action: 'start' | 'alternating' | 'simultaneous' | 'migration' | 'stop'
    | 'identify-A' | 'identify-B' | 'wav-sync-pulse' | 'wav-repeated-sync' | 'timing-result') {
    setMultiBusy(action); setMultiError(null); setMultiMessage(null);
    try {
      const actionPath = action.startsWith('identify-')
        ? `/identify/${action.slice(-1)}`
        : action === 'timing-result' ? '/timing-result'
          : action === 'stop' ? '' : `/${action}`;
      const path = action === 'start'
        ? '/api/research-lab/multi-speaker-sessions'
        : `/api/research-lab/multi-speaker-sessions/${encodeURIComponent(multiSession!.id)}${actionPath}`;
      const response = await fetch(runtimeUrl(path), {
        method: action === 'stop' ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(action === 'start' ? {
          body: JSON.stringify({ deviceAId: speakerAId, deviceBId: speakerBId, mode: multiMode }),
        } : action === 'timing-result' ? {
          body: JSON.stringify({
            impression: timingImpression,
            ...(estimatedTimingSkew ? { estimatedSkewMs: Number(estimatedTimingSkew) } : {}),
          }),
        } : {}),
      });
      if (!response.ok) throw new Error(await readFailure(response, `Unable to ${action} multi-speaker session.`));
      const data = await response.json() as { ok: true; session: MultiSpeakerSessionSnapshot };
      setMultiSession(data.session);
      if (action === 'stop') {
        const cleanupErrors = data.session.teardown
          ? [data.session.teardown.participantA.error, data.session.teardown.participantB.error]
            .filter((message): message is string => Boolean(message))
          : [];
        if (cleanupErrors.length > 0) {
          setMultiError(`Session stopped with cleanup errors: ${cleanupErrors.join(' ')}`);
        } else {
          setMultiMessage('Session stopped.');
        }
      } else if (action === 'timing-result') {
        setMultiMessage('Timing observation recorded.');
        setEstimatedTimingSkew('');
      }
      void refreshStreams();
    } catch (error) {
      setMultiError(await describeResearchLabFailure(error, 'the multi-speaker operation'));
    } finally { setMultiBusy(null); }
  }

  async function startStream(device: AudioDevice, transport: AudioTransportOption) {
    const key = `${device.id}:${transport.id}`;
    setStartingKey(key);
    setActionError(null);
    try {
      const response = await fetch(runtimeUrl('/api/research-lab/streams'), {
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
      setActionError(await describeResearchLabFailure(error, 'continuous-stream startup'));
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
      const response = await fetch(runtimeUrl(
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
      const response = await fetch(runtimeUrl(
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
      const response = await fetch(runtimeUrl(
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

  async function runLatencyAction(action: 'start' | 'tone' | 'stop') {
    setLatencyBusy(action);
    setLatencyError(null);
    try {
      const url = action === 'start'
        ? '/api/research-lab/streams'
        : action === 'tone'
          ? `/api/research-lab/streams/${encodeURIComponent(latencyStreamId!)}/latency-tone`
          : `/api/research-lab/streams/${encodeURIComponent(latencyStreamId!)}`;
      const requestUrl = runtimeUrl(url);
      const toneCorrelationId = action === 'tone' ? crypto.randomUUID() : null;
      const requestStarted = performance.now();
      if (action === 'tone') {
        const details = {
          latencyLabSessionId: latencyStream?.latencyLabSessionId ?? null,
          correlationId: toneCorrelationId,
          profileId: latencyProfileId,
          physicalDeviceId: latencyDevice?.identity.providerIdentifier ?? latencyDeviceId,
          streamId: latencyStreamId,
          runtimeUrl: requestUrl,
          requestPath: url,
          requestStartedAt: new Date().toISOString(),
        };
        console.info('latency_lab.frontend_tone_request', details);
        await recordDiagnostic({
          category: 'audio', level: 'info', event: 'latency_lab.frontend_tone_request',
          message: 'Latency Lab frontend requested tone injection.',
          correlationId: toneCorrelationId ?? undefined,
          details,
        });
      }
      const response = await fetch(requestUrl, {
        method: action === 'stop' ? 'DELETE' : 'POST',
        ...(action === 'start' ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: latencyDeviceId,
            transportId: 'sonos-local-continuous',
            latencyProfileId,
          }),
        } : action === 'tone' ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            correlationId: toneCorrelationId,
            streamId: latencyStreamId,
            profileId: latencyProfileId,
            deviceId: latencyDeviceId,
            requestStartedAt: new Date().toISOString(),
          }),
        } : {}),
      });
      if (action === 'tone') {
        const responseBody = await response.clone().json().catch(() => null) as unknown;
        const details = {
          latencyLabSessionId: latencyStream?.latencyLabSessionId ?? null,
          streamId: latencyStreamId,
          profileId: latencyProfileId,
          physicalDeviceId: latencyDevice?.identity.providerIdentifier ?? latencyDeviceId,
          toneCorrelationId,
          correlationId: toneCorrelationId,
          httpStatus: response.status,
          responseBody,
          requestDurationMs: Math.round((performance.now() - requestStarted) * 10) / 10,
          success: response.ok,
        };
        console.info('latency_lab.frontend_tone_response', details);
        await recordDiagnostic({
          category: response.ok ? 'audio' : 'error',
          level: response.ok ? 'info' : 'error',
          event: 'latency_lab.frontend_tone_response',
          message: response.ok
            ? 'Latency Lab frontend received tone response.'
            : 'Latency Lab frontend received tone failure response.',
          correlationId: toneCorrelationId ?? undefined,
          details,
        });
      }
      if (!response.ok) throw new Error(await readFailure(response, `Unable to ${action} latency stream.`));
      const data = await response.json() as AudioStreamSnapshotResponse;
      setStreams((current) => [data.stream, ...current.filter((item) => item.id !== data.stream.id)]);
      if (action === 'start') setLatencyStreamId(data.stream.id);
      if (action === 'stop') setLatencyStreamId(null);
    } catch (error) {
      setLatencyError(await describeResearchLabFailure(error, `Latency Lab ${action}`));
    } finally {
      setLatencyBusy(null);
    }
  }

  async function recordLatencyResult() {
    const value = Number(observedDelay);
    if (!Number.isFinite(value) || value < 0) {
      setLatencyError('Observed delay must be a non-negative number of milliseconds.');
      return;
    }
    if (!latencyStreamId) {
      setLatencyError('Start a latency stream before recording a result.');
      return;
    }
    try {
      const response = await fetch(runtimeUrl(`/api/research-lab/streams/${encodeURIComponent(latencyStreamId)}/latency-result`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ observedDelayMs: value }),
      });
      if (!response.ok) throw new Error(await readFailure(response, 'Unable to record latency result.'));
      setLatencyResults((current) => [...current, {
        id: crypto.randomUUID(), profileId: latencyProfileId,
        observedDelayMs: value, recordedAt: new Date().toISOString(),
      }]);
      setObservedDelay('');
      setLatencyError(null);
    } catch (error) {
      setLatencyError(sanitizedErrorMessage(error));
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

        <nav className="research-lab-tabs" aria-label="Research Lab experiments">
          {([
            ['streams', 'Stream Experiments'],
            ['multi', 'Multi-Speaker Lab'],
            ['latency', 'Latency Transport Lab'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              className={activeTab === id ? 'active' : ''}
              aria-selected={activeTab === id}
              onClick={() => setActiveTab(id)}
            >{label}</button>
          ))}
        </nav>

        <div className={`research-lab-content research-tab-${activeTab}`}>
          {activeTab === 'streams' && <section className="research-lab-panel">
            <div className="research-section-heading">
              <div>
                <h3>Audio Devices</h3>
                <p>Choose a physical device and an available experimental transport.</p>
              </div>
              <button disabled={discovering} onClick={() => void refreshDevices(true)}>
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
          </section>}

          {activeTab === 'latency' && <section className="research-lab-panel research-latency-panel">
            <div className="research-section-heading">
              <div><h3>Latency Transport Lab</h3><p>Compare Sonos-local stream semantics and formats without changing production Room Audio.</p></div>
            </div>
            <div className="research-latency-controls">
              <label>Speaker<select value={latencyDeviceId} disabled={latencyStreamActive} onChange={(event) => setLatencyDeviceId(event.target.value)}>
                <option value="">Select standalone device…</option>
                {multiEligibleDevices.map((device) => <option key={device.id} value={device.id} title={audioDeviceSelectorTitle(device)}>{formatAudioDeviceSelectorLabel(device)}</option>)}
              </select></label>
              <label>Profile<select value={latencyProfileId} disabled={latencyStreamActive} onChange={(event) => setLatencyProfileId(event.target.value as SonosLatencyProfileId)}>
                {sonosLatencyExperimentProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
              </select></label>
              <div className="research-stream-actions">
                <button disabled={!latencyDeviceId || latencyStreamActive || Boolean(latencyBusy)} onClick={() => void runLatencyAction('start')}>{latencyBusy === 'start' ? 'Starting…' : 'Start Stream'}</button>
                <button disabled={!latencyStreamActive || Boolean(latencyBusy)} onClick={() => void runLatencyAction('stop')}>Stop Stream</button>
                <button disabled={!latencyToneCanAttempt || Boolean(latencyBusy)} onClick={() => void runLatencyAction('tone')}>Inject Latency Tone</button>
              </div>
            </div>
            {latencyDevice && <div className="research-latency-device-details">
              <span><strong>Name</strong>{latencyDevice.presentation?.alias ?? latencyDevice.name}</span>
              <span><strong>Model</strong>{latencyDevice.model ?? 'Unavailable'}</span>
              <span><strong>Physical Device ID</strong><code>{latencyDevice.identity.providerIdentifier ?? `…${latencyDevice.identity.providerIdentifierSuffix}`}</code></span>
              <span><strong>IP address</strong><code>{latencyDevice.identity.networkAddress ?? 'Unavailable'}</code></span>
            </div>}
            <div className="research-latency-profile">
              <span>{latencyProfile.codec} / {latencyProfile.container}</span>
              <span>{latencyProfile.sampleRate / 1_000} kHz · {latencyProfile.channelCount} ch</span>
              <span>{latencyProfile.bitrate ? `${latencyProfile.bitrate / 1_000} kbps` : 'Uncompressed'}</span>
              <span>{latencyProfile.uriScheme} · {latencyProfile.sonosStreamType}</span>
              <span>{latencyProfile.httpFraming}</span>
            </div>
            {latencyStream && <div className="research-latency-status">
              State: {titleCase(latencyStream.lifecycle)} · PID {latencyStream.encoder.pid ?? '—'} · {latencyStream.httpClient.connected ? 'Consumer connected' : 'Waiting for consumer'} · {latencyStream.telemetry.deliveredBitsPerSecond.toLocaleString()} delivered bps
            </div>}
            {latencyToneStatus && <div className="research-tone-status">{latencyToneStatus}</div>}
            {latencyError && <div className="research-error-message">{latencyError}</div>}
            <div className="research-latency-record">
              <label>Observed Delay <input type="number" min="0" step="1" value={observedDelay} onChange={(event) => setObservedDelay(event.target.value)} /> ms</label>
              <button disabled={!observedDelay || !latencyStreamId} onClick={() => void recordLatencyResult()}>Record Result</button>
            </div>
            <table className="research-latency-results"><thead><tr><th>Profile</th><th>Samples</th><th>Avg</th><th>Min</th><th>Max</th></tr></thead><tbody>
              {latencySummaries.map((summary) => <tr key={summary.profileId}><td>{sonosLatencyExperimentProfiles.find((profile) => profile.id === summary.profileId)?.label}</td><td>{summary.samples}</td><td>{summary.samples ? Math.round(summary.averageMs) : '—'}</td><td>{summary.samples ? summary.minimumMs : '—'}</td><td>{summary.samples ? summary.maximumMs : '—'}</td></tr>)}
            </tbody></table>
          </section>}

          {activeTab === 'multi' && <section className="research-lab-panel research-tab-full-panel">
            <div className="research-section-heading">
              <div><h3>Multi-Speaker Lab</h3><p>PCM/source-generation experiments for two independent physical streams.</p></div>
            </div>
            <div className="research-multi-selectors">
              <label>Experiment<select value={multiMode} disabled={Boolean(multiSession && multiSession.state !== 'stopped')} onChange={(event) => setMultiMode(event.target.value as typeof multiMode)}>
                <option value="standard">Standard Multi-Speaker</option>
                <option value="wav-timing">WAV Multi-Speaker Timing</option>
              </select></label>
              <label>Speaker A<select value={speakerAId} disabled={Boolean(multiSession && multiSession.state !== 'stopped')} onChange={(event) => setSpeakerAId(event.target.value)}>
                <option value="">Select device…</option>
                {multiEligibleDevices.map((device) => <option key={device.id} value={device.id} title={audioDeviceSelectorTitle(device)} disabled={device.id === speakerBId}>{formatAudioDeviceSelectorLabel(device)}</option>)}
              </select></label>
              <label>Speaker B<select value={speakerBId} disabled={Boolean(multiSession && multiSession.state !== 'stopped')} onChange={(event) => setSpeakerBId(event.target.value)}>
                <option value="">Select device…</option>
                {multiEligibleDevices.map((device) => <option key={device.id} value={device.id} title={audioDeviceSelectorTitle(device)} disabled={device.id === speakerAId}>{formatAudioDeviceSelectorLabel(device)}</option>)}
              </select></label>
            </div>
            <div className="research-stream-actions">
              <button disabled={!speakerAId || !speakerBId || speakerAId === speakerBId || Boolean(multiBusy) || Boolean(multiSession && multiSession.state !== 'stopped')} onClick={() => void multiAction('start')}>Start Both</button>
              <button disabled={!multiSession || multiSession.state === 'stopped' || Boolean(multiBusy)} onClick={() => void multiAction('stop')}>Stop All</button>
            </div>
            {multiError && <div className="research-error-message">{multiError}</div>}
            {multiMessage && <div className="research-device-action-message">{multiMessage}</div>}
            {multiSession && (
              <div className="research-multi-session">
                <strong>Session: {titleCase(multiSession.state)}</strong>
                <div className="research-diagnostic-grid">
                  {multiSession.participants.map((participant) => <DiagnosticValue key={participant.slot} label={`Speaker ${participant.slot}`} value={`${participant.deviceName} · ${titleCase(participant.state)} · PID ${participant.encoderPid ?? '—'} · ${participant.consumerConnected ? 'Connected' : 'Waiting'}`} />)}
                </div>
                <h4>Coordinated Tests</h4>
                <div className="research-stream-actions">
                  {multiSession.mode === 'wav-timing' ? <>
                    <button disabled={multiSession.state !== 'ready' || Boolean(multiBusy)} onClick={() => void multiAction('identify-A')}>Identify A</button>
                    <button disabled={multiSession.state !== 'ready' || Boolean(multiBusy)} onClick={() => void multiAction('identify-B')}>Identify B</button>
                    <button disabled={multiSession.state !== 'ready' || !multiSession.timingContinuityValid || Boolean(multiBusy)} onClick={() => void multiAction('wav-sync-pulse')}>Inject Simultaneous Pulse</button>
                    <button disabled={multiSession.state !== 'ready' || !multiSession.timingContinuityValid || Boolean(multiBusy)} onClick={() => void multiAction('wav-repeated-sync')}>Repeated Sync Test</button>
                  </> : <>
                    <button disabled={multiSession.state !== 'ready' || Boolean(multiBusy)} onClick={() => void multiAction('alternating')}>Run Alternating Test</button>
                    <button disabled={multiSession.state !== 'ready' || Boolean(multiBusy)} onClick={() => void multiAction('simultaneous')}>Run Simultaneous Test</button>
                    <button disabled={multiSession.state !== 'ready' || Boolean(multiBusy)} onClick={() => void multiAction('migration')}>Migrate A → B</button>
                  </>}
                </div>
                {multiSession.mode === 'wav-timing' && <>
                  <div className={multiSession.timingContinuityValid ? 'research-device-action-message' : 'research-warning-message'}>
                    Timing continuity: {multiSession.timingContinuityValid ? 'Valid' : 'Invalidated by reconnect — start a new session'}
                  </div>
                  {multiSession.lastWavSyncPulse && <div className="research-multi-result">
                    <strong>Last WAV Sync Pulse</strong>
                    <span>Shared frame: {multiSession.lastWavSyncPulse.scheduledFrame}</span>
                    {multiSession.lastWavSyncPulse.speakers.map((speaker) => <span key={speaker.slot}>Speaker {speaker.slot}: frame {speaker.firstToneFrame ?? 'pending'} · offset {speaker.logicalOffsetFrames ?? 'pending'} · connection {speaker.connectionOrdinal ?? '—'}</span>)}
                    <small>Logical PCM timing only; acoustic skew remains a manual observation.</small>
                  </div>}
                  <div className="research-latency-record">
                    <label>Observed Skew<select value={timingImpression} onChange={(event) => setTimingImpression(event.target.value as typeof timingImpression)}>
                      <option value="simultaneous">Indistinguishable / simultaneous</option>
                      <option value="slight-echo">Slight echo</option>
                      <option value="double-hit">Clear double hit</option>
                    </select></label>
                    <label>Estimated skew <input type="number" min="0" value={estimatedTimingSkew} onChange={(event) => setEstimatedTimingSkew(event.target.value)} /> ms</label>
                    <button disabled={multiSession.state !== 'ready' || Boolean(multiBusy)} onClick={() => void multiAction('timing-result')}>Record Result</button>
                  </div>
                </>}
                {multiSession.lastSimultaneousResult && <div className="research-multi-result">
                  <strong>Last Simultaneous PCM Result</strong>
                  <span>Event: {multiSession.lastSimultaneousResult.eventId}</span>
                  <span>A schedule error: {multiSession.lastSimultaneousResult.aScheduleErrorMs?.toFixed(2) ?? 'pending'} ms</span>
                  <span>B schedule error: {multiSession.lastSimultaneousResult.bScheduleErrorMs?.toFixed(2) ?? 'pending'} ms</span>
                  <span>Source-generation skew: {multiSession.lastSimultaneousResult.sourceGenerationSkewMs?.toFixed(2) ?? 'pending'} ms</span>
                  <small>This measures backend PCM generation, not acoustic speaker synchronization.</small>
                </div>}
                {multiSession.lastMigrationResult && <div className="research-multi-result">
                  <strong>Last Migration</strong>
                  <span>A → B</span>
                  <span>Duration: {(multiSession.lastMigrationResult.durationMs / 1_000).toFixed(1)} sec</span>
                  <span>A start error: {multiSession.lastMigrationResult.aScheduleErrorMs?.toFixed(2) ?? 'pending'} ms</span>
                  <span>B start error: {multiSession.lastMigrationResult.bScheduleErrorMs?.toFixed(2) ?? 'pending'} ms</span>
                  <span>Source start skew: {multiSession.lastMigrationResult.sourceGenerationSkewMs?.toFixed(2) ?? 'pending'} ms</span>
                  <span>{titleCase(multiSession.lastMigrationResult.status)}</span>
                </div>}
                <details className="research-event-console">
                  <summary>Session events ({multiSession.recentEvents.length})</summary>
                  <div className="research-events">{multiSession.recentEvents.map((event, index) =>
                    <div key={`${event.timestamp}:${event.code}:${index}`} className={`research-event ${event.category}`}>
                      <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
                      <span>{event.message}</span>
                      {event.details && <pre>{JSON.stringify(event.details, null, 2)}</pre>}
                    </div>)}</div>
                </details>
              </div>
            )}
          </section>}

          {activeTab === 'streams' && <section className="research-lab-panel research-streams-panel">
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
          </section>}
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
