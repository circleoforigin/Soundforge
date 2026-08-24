import type {
  AudioDevice,
  AudioStreamDiagnosticEvent,
  AudioStreamSnapshot,
  AudioStreamTransportSnapshot,
  AudioTransportOption,
  AudioTransportScope,
} from '../../../src/models/ResearchLab.ts';
import type { Writable } from 'node:stream';
import type { ContinuousAudioEncodingProfileId } from '../ContinuousAudioEncodingProfile.ts';
import type { SonosLatencyExperimentProfile } from '../../../src/models/SonosLatencyLab.ts';

export interface ContinuousStreamTransportContext {
  device: AudioDevice;
  transport: AudioTransportOption;
  streamId: string;
  streamUrl: string;
  latencyProfile?: SonosLatencyExperimentProfile;
  wavSettleDelayMs?: number;
  bindHttpClient(
    client: Writable & { destroyed: boolean; writableEnded: boolean; writableLength: number },
    metadata?: HttpStreamConnectionMetadata
  ): void;
  updateTransport(update: Partial<AudioStreamTransportSnapshot>, message?: string): void;
  addDiagnostic(message: string, details?: Record<string, unknown>, code?: string): void;
  getSnapshot?(): AudioStreamSnapshot | undefined;
  terminate(reason: string): void;
}

export interface HttpStreamConnectionMetadata {
  remoteAddress?: string;
  httpVersion?: string;
  userAgent?: string;
  range?: string;
  phase?: string;
  role?: 'startup-consumer' | 'startup-reconnect' | 'playback-consumer';
}

export interface ContinuousStreamTransportBinding {
  transportId: string;
  targetScope: AudioTransportScope;
  targetDescription: string;
  independentlyTargetable: boolean;
  providerBinding: unknown;
}

export interface ContinuousStreamTransport {
  readonly id: string;
  readonly encodingProfileId?: ContinuousAudioEncodingProfileId;
  readonly clientReconnectGraceMs?: number;
  readonly minimumConnectionsForTone?: number;
  start(context: ContinuousStreamTransportContext): Promise<ContinuousStreamTransportBinding>;
  stop(binding: ContinuousStreamTransportBinding): Promise<void>;
  handleRuntimeEvent?(
    streamId: string,
    event: AudioStreamDiagnosticEvent,
    snapshot: AudioStreamSnapshot | undefined
  ): void;
}
