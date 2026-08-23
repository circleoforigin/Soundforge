import type { RoomAudioEndpoint } from '../../../src/models/RoomAudio.ts';
import type { RoomAudioEndpointTelemetry } from '../../../src/models/RoomAudio.ts';

export interface AudioEndpointConnection {
  readonly id: string;
  readonly endpoint: RoomAudioEndpoint;
  readonly encoderId?: string;
  getEncoderPid(): number | null;
  pushPcm(frame: Buffer, logicalFrameStartMonotonicTime: number): boolean;
  getTelemetry?(): RoomAudioEndpointTelemetry;
  close(): Promise<void>;
}

export interface AudioOutputProvider {
  readonly id: string;
  openEndpoint(
    endpoint: RoomAudioEndpoint,
    callbacks?: { onFailure?: (error: Error) => void }
  ): Promise<AudioEndpointConnection>;
}
