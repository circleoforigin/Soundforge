import type {
  AudioDevice,
  AudioStreamTransportSnapshot,
  AudioTransportOption,
  AudioTransportScope,
} from '../../../src/models/ResearchLab.ts';

export interface ContinuousStreamTransportContext {
  device: AudioDevice;
  transport: AudioTransportOption;
  streamId: string;
  streamUrl: string;
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
  start(context: ContinuousStreamTransportContext): Promise<ContinuousStreamTransportBinding>;
  stop(binding: ContinuousStreamTransportBinding): Promise<void>;
}
