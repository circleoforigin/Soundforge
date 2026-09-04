import type { SoundPosition } from '../utils/soundStageMath.ts';

export const ROOM_AUDIO_FORMAT = {
  sampleRate: 48_000,
  channels: 2,
  frameDurationMs: 20,
} as const;

export type RoomAudioSessionState = 'starting' | 'ready' | 'degraded' | 'stopping' | 'stopped' | 'error';

export interface RoomAudioEndpoint {
  endpointId: string;
  speakerId: string;
  providerId: string;
  deviceId: string;
  displayName: string;
  enabled: boolean;
  trimDb: number;
  role?: 'spatial-endpoint' | 'master-mix';
  timingOffsetMs?: number;
}

export interface RoomAudioSessionRequest {
  roomId: string;
  roomName: string;
  endpoints: RoomAudioEndpoint[];
}

export interface RoomAudioEndpointSnapshot extends RoomAudioEndpoint {
  state: 'starting' | 'ready' | 'error' | 'stopped';
  connectionId?: string;
  encoderId?: string;
  encoderPid?: number | null;
  lastError?: string;
}

export interface RoomAudioSessionSnapshot {
  roomId: string;
  sessionId: string;
  state: RoomAudioSessionState;
  createdAt: string;
  logicalFrameIndex: number;
  activeSourceCount: number;
  endpoints: RoomAudioEndpointSnapshot[];
}

export interface RoomSpeakerVolumeResult {
  volume: number;
  targetedSpeakerCount: number;
  updatedSpeakerCount: number;
  failures: Array<{ endpointId: string; displayName: string; operation: 'discover' | 'get' | 'set'; message: string }>;
  message?: string;
}

export interface RoomAudioSourceRequest {
  correlationId: string;
  sceneInstanceId: string;
  sceneName?: string;
  sourceNodeId: string;
  objectInstanceId: string;
  assetId: string;
  assetName: string;
  playbackMode: 'oneShot' | 'loop';
  volumeType: 'oneShot' | 'loop' | 'ambience';
  position?: SoundPosition;
  nodeGainDb: number;
  muted: boolean;
  fadeInEnabled: boolean;
  fadeInMs: number;
  fadeOutEnabled: boolean;
  fadeOutMs: number;
  randomStart: boolean;
  typeVolume: number;
  sceneMasterVolume: number;
  sceneTransitionGain?: number;
  endpointGains: Record<string, number>;
  updateCorrelationId?: string;
  frontendRequestInitiatedAt?: string;
}

export interface RoomAudioEndpointTelemetry {
  pcmFramesSubmitted: number;
  pcmBytesSubmitted: number;
  encodedBytesProduced?: number;
  httpBytesDelivered?: number;
  httpWritableLength?: number;
  estimatedQueuedAudioMs?: number;
  estimatedEncodedDeliveryLeadMs?: number;
}

export interface RoomAudioSourceSnapshot extends RoomAudioSourceRequest {
  playbackId: string;
  logicalStartFrame: number;
  playheadSamples: number;
  startCount: number;
  state: 'playing' | 'completed' | 'stopped' | 'error';
}
