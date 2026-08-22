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

export interface ContinuousStreamTransportContext {
  device: AudioDevice;
  transport: AudioTransportOption;
  streamId: string;
  streamUrl: string;
  bindHttpClient(client: Writable & { destroyed: boolean; writableEnded: boolean; writableLength: number }): void;
  updateTransport(update: Partial<AudioStreamTransportSnapshot>, message?: string): void;
  addDiagnostic(message: string, details?: Record<string, unknown>): void;
  terminate(reason: string): void;
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
  start(context: ContinuousStreamTransportContext): Promise<ContinuousStreamTransportBinding>;
  stop(binding: ContinuousStreamTransportBinding): Promise<void>;
  handleRuntimeEvent?(
    streamId: string,
    event: AudioStreamDiagnosticEvent,
    snapshot: AudioStreamSnapshot | undefined
  ): void;
}
