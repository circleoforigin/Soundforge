export type AudioTopologyKind =
  | 'household'
  | 'group'
  | 'logical-player'
  | 'physical-device';

export type AudioDeviceCapability =
  | 'audio-clip'
  | 'continuous-stream';

export type AudioTransportAvailability =
  | 'available'
  | 'experimental'
  | 'unavailable';

export type AudioTransportScope =
  | 'physical-device'
  | 'logical-player'
  | 'group';

export interface AudioTopologyNode {
  id: string;
  kind: AudioTopologyKind;
  name: string;
  parentId?: string;
  selected?: boolean;
}

export interface AudioTransportOption {
  id: string;
  name: string;
  operation: 'audio-clip' | 'persistent-stream';
  scope: AudioTransportScope;
  independentlyTargetable: boolean;
  availability: AudioTransportAvailability;
  limitation?: string;
}

export interface AudioDevice {
  id: string;
  provider: string;
  name: string;
  model?: string;
  capabilities: AudioDeviceCapability[];
  topology: AudioTopologyNode[];
  transports: AudioTransportOption[];
}

export interface AudioDeviceDiscoveryResponse {
  ok: true;
  devices: AudioDevice[];
}

export type AudioStreamLifecycleState =
  | 'starting'
  | 'waiting-for-client'
  | 'buffering'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'error';

export type AudioStreamSource = 'silence' | 'test-tone';

export type AudioStreamDiagnosticCategory =
  | 'lifecycle'
  | 'encoder'
  | 'http'
  | 'source'
  | 'backpressure'
  | 'error';

export interface AudioStreamDiagnosticEvent {
  timestamp: string;
  category: AudioStreamDiagnosticCategory;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AudioStreamEncoderSnapshot {
  state: 'starting' | 'running' | 'stopped' | 'error';
  pid: number | null;
  startedAt: string | null;
  sampleRate: number;
  channels: number;
  bitrate: number;
  framesGenerated: number;
  pcmBytesGenerated: number;
  encodedBytesProduced: number;
  stdinBackpressured: boolean;
}

export interface AudioStreamHttpClientSnapshot {
  connected: boolean;
  connectedAt: string | null;
  disconnectedAt: string | null;
  deliveredBytes: number;
  writableLength: number;
  backpressured: boolean;
}

export interface AudioStreamSnapshot {
  id: string;
  deviceId?: string;
  transportId?: string;
  lifecycle: AudioStreamLifecycleState;
  source: AudioStreamSource;
  encoder: AudioStreamEncoderSnapshot;
  httpClient: AudioStreamHttpClientSnapshot;
  createdAt: string;
  stoppedAt: string | null;
  lastError: string | null;
  recentEvents: AudioStreamDiagnosticEvent[];
}

export interface AudioStreamSnapshotResponse {
  ok: true;
  stream: AudioStreamSnapshot;
}

export interface AudioStreamListResponse {
  ok: true;
  streams: AudioStreamSnapshot[];
}
