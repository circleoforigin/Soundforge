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

export interface AudioDeviceDiagnosticAction {
  id: 'identify-speaker';
  name: string;
  availability: AudioTransportAvailability;
  limitation?: string;
}

export interface AudioDeviceIdentityDetails {
  providerIdentifierSuffix: string;
  providerIdentifier?: string;
  logicalPlayerName: string;
  componentRole?: string;
  modelNumber?: string;
  serialNumber?: string;
  networkAddress?: string;
}

export interface AudioDevicePresentationMetadata {
  deviceId: string;
  alias?: string;
}

export interface AudioDevice {
  id: string;
  provider: string;
  name: string;
  model?: string;
  presentation?: Omit<AudioDevicePresentationMetadata, 'deviceId'>;
  identity: AudioDeviceIdentityDetails;
  capabilities: AudioDeviceCapability[];
  diagnosticActions: AudioDeviceDiagnosticAction[];
  topology: AudioTopologyNode[];
  transports: AudioTransportOption[];
}

export interface AudioDeviceDiscoveryResponse {
  ok: true;
  devices: AudioDevice[];
}

export interface AudioDeviceActionResponse {
  ok: true;
  deviceId: string;
  actionId: AudioDeviceDiagnosticAction['id'];
}

export interface AudioDevicePresentationResponse {
  ok: true;
  presentation: AudioDevicePresentationMetadata;
}

export type AudioStreamLifecycleState =
  | 'starting'
  | 'preparing'
  | 'ready-for-client'
  | 'waiting-for-client'
  | 'flushing-startup'
  | 'buffering'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'error';

export type AudioStreamSource = 'silence' | 'test-tone';

export type ContinuousHttpFramingMode =
  | 'chunked'
  | 'indefinite-content-length';

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
  codec: string;
  container: string;
  mimeType: string;
  framesGenerated: number;
  pcmBytesGenerated: number;
  encodedBytesProduced: number;
  startupBufferBytes: number;
  startupBufferReady: boolean;
  pcmPausedForReady: boolean;
  stdinBackpressured: boolean;
}

export interface AudioStreamRateSummary {
  current: number;
  minimum: number;
  maximum: number;
  average: number;
  samples: number;
}

export interface AudioStreamTelemetrySnapshot {
  measuredAt: string | null;
  sourceMode: AudioStreamSource;
  pcmFramesGeneratedLastSecond: number;
  pcmBytesGeneratedLastSecond: number;
  encodedFramesProducedLastSecond: number;
  encodedBytesProducedLastSecond: number;
  encodedBitsPerSecond: number;
  bytesDeliveredLastSecond: number;
  deliveredBitsPerSecond: number;
  consumerConnected: boolean;
  encodedRate: AudioStreamRateSummary;
  deliveredRate: AudioStreamRateSummary;
}

export interface AudioStreamHttpClientSnapshot {
  framingMode: ContinuousHttpFramingMode;
  connected: boolean;
  connectedAt: string | null;
  disconnectedAt: string | null;
  deliveredBytes: number;
  writableLength: number;
  backpressured: boolean;
  connectionCount: number;
  currentConnectionOrdinal: number | null;
  awaitingReconnect: boolean;
  connections: AudioStreamHttpConnectionSnapshot[];
}

export interface AudioStreamHttpConnectionSnapshot {
  ordinal: number;
  connectedAt: string;
  disconnectedAt: string | null;
  durationMs: number | null;
  remoteAddress: string | null;
  httpVersion: string | null;
  userAgent: string | null;
  range: string | null;
  radioStyleUserAgent: boolean;
  bytesDelivered: number;
  disconnectReason: string | null;
  phaseAtConnection: string;
  role: 'startup-consumer' | 'startup-reconnect' | 'playback-consumer';
}

export type AudioStreamTransportState =
  | 'starting'
  | 'binding'
  | 'bound'
  | 'active'
  | 'stopping'
  | 'stopped'
  | 'error';

export interface AudioStreamTransportSnapshot {
  state: AudioStreamTransportState;
  targetScope: AudioTransportScope | null;
  targetDescription: string | null;
  independentlyTargetable: boolean | null;
  bound: boolean;
  providerPlaybackState: string | null;
  hasBinding: boolean;
  lastError: string | null;
}

export interface AudioStreamSnapshot {
  id: string;
  latencyLabSessionId?: string;
  deviceId?: string;
  transportId?: string;
  lifecycle: AudioStreamLifecycleState;
  source: AudioStreamSource;
  toneReady: boolean;
  telemetry: AudioStreamTelemetrySnapshot;
  encoder: AudioStreamEncoderSnapshot;
  httpClient: AudioStreamHttpClientSnapshot;
  transport: AudioStreamTransportSnapshot | null;
  createdAt: string;
  stoppedAt: string | null;
  lastError: string | null;
  recentEvents: AudioStreamDiagnosticEvent[];
  scheduledEvents: ScheduledResearchAudioEventResult[];
}

export interface ScheduledResearchAudioEventResult {
  eventId: string;
  targetMonotonicTime: number;
  frequencyHz: number;
  durationMs: number;
  gainEnvelope: ScheduledResearchAudioGainEnvelope | null;
  status: 'scheduled' | 'started' | 'completed' | 'cancelled';
  actualPcmStartMonotonicTime: number | null;
  actualPcmFrameIndex?: number | null;
  scheduleErrorMs: number | null;
}

export interface ScheduledResearchAudioGainEnvelope {
  startGain: number;
  endGain: number;
  curve: 'equal-power';
}

export type MultiSpeakerParticipantSlot = 'A' | 'B';

export interface MultiSpeakerParticipantSnapshot {
  slot: MultiSpeakerParticipantSlot;
  deviceId: string;
  deviceName: string;
  streamId: string;
  state: string;
  encoderPid: number | null;
  consumerConnected: boolean;
  connectionOrdinal?: number | null;
  reconnectCount?: number;
  model?: string;
}

export interface WavSyncPulseParticipantResult {
  slot: MultiSpeakerParticipantSlot;
  deviceId: string;
  streamId: string;
  scheduledFrame: number;
  firstToneFrame: number | null;
  logicalOffsetFrames: number | null;
  connectionOrdinal: number | null;
  encodedBytes: number;
  httpBytesDelivered: number;
}

export interface WavSyncPulseResult {
  sessionId: string;
  pulseOrdinal: number;
  eventId: string;
  scheduledFrame: number;
  speakers: WavSyncPulseParticipantResult[];
}

export interface WavTimingObservation {
  id: string;
  recordedAt: string;
  impression: 'simultaneous' | 'slight-echo' | 'double-hit';
  estimatedSkewMs?: number;
  measuredAcousticSkewMs?: number;
}

export interface MultiSpeakerSimultaneousResult {
  eventId: string;
  scheduledMonotonicTime: number;
  aActualStart: number | null;
  bActualStart: number | null;
  aScheduleErrorMs: number | null;
  bScheduleErrorMs: number | null;
  sourceGenerationSkewMs: number | null;
}

export interface MultiSpeakerMigrationResult {
  eventId: string;
  direction: 'A-to-B';
  targetMonotonicTime: number;
  frequencyHz: number;
  durationMs: number;
  curve: 'equal-power';
  aActualStart: number | null;
  bActualStart: number | null;
  aScheduleErrorMs: number | null;
  bScheduleErrorMs: number | null;
  sourceGenerationSkewMs: number | null;
  status: 'scheduled' | 'running' | 'completed' | 'cancelled';
}

export interface MultiSpeakerSessionSnapshot {
  id: string;
  state: 'starting' | 'ready' | 'degraded' | 'stopping' | 'stopped';
  participants: MultiSpeakerParticipantSnapshot[];
  recentEvents: AudioStreamDiagnosticEvent[];
  lastSimultaneousResult: MultiSpeakerSimultaneousResult | null;
  lastMigrationResult: MultiSpeakerMigrationResult | null;
  teardown: MultiSpeakerTeardownSummary | null;
  mode?: 'standard' | 'wav-timing';
  timingContinuityValid?: boolean;
  lastWavSyncPulse?: WavSyncPulseResult | null;
  timingObservations?: WavTimingObservation[];
}

export interface MultiSpeakerParticipantTeardown {
  stopped: boolean;
  transportStopped: boolean;
  listenerClosed: boolean;
  encoderStopped: boolean;
  error?: string;
}

export interface MultiSpeakerTeardownSummary {
  sessionId: string;
  participantA: MultiSpeakerParticipantTeardown;
  participantB: MultiSpeakerParticipantTeardown;
  pendingEventsCancelled: number;
}

export interface AudioStreamSnapshotResponse {
  ok: true;
  stream: AudioStreamSnapshot;
}

export interface AudioStreamListResponse {
  ok: true;
  streams: AudioStreamSnapshot[];
}
