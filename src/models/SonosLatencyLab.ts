export type SonosLatencyProfileId =
  | 'known-working-baseline'
  | 'aac-radio'
  | 'wav-broadcast'
  | 'l16-broadcast';

export type SonosLatencyStreamType = 'radio' | 'broadcast';

export interface SonosLatencyExperimentProfile {
  id: SonosLatencyProfileId;
  label: string;
  encodingProfileId: 'aac-adts' | 'wav-pcm' | 'l16-pcm';
  codec: 'aac-lc' | 'pcm-s16le' | 'pcm-s16be';
  container: 'adts' | 'wav' | 'l16';
  mimeType: string;
  sampleRate: 48_000;
  channelCount: 2;
  bitrate?: number;
  sonosStreamType: SonosLatencyStreamType;
  uriScheme: 'x-rincon-mp3radio' | 'http';
  metadataMode: 'empty' | 'audio-broadcast';
  httpFraming: 'HTTP/1.0 connection-close';
  limitation?: string;
  useTransportDefaults?: boolean;
}

export const sonosLatencyExperimentProfiles: readonly SonosLatencyExperimentProfile[] = [
  {
    id: 'known-working-baseline', label: 'Known Working Baseline',
    encodingProfileId: 'aac-adts', codec: 'aac-lc', container: 'adts',
    mimeType: 'audio/aac', sampleRate: 48_000, channelCount: 2, bitrate: 256_000,
    sonosStreamType: 'radio', uriScheme: 'x-rincon-mp3radio', metadataMode: 'empty',
    httpFraming: 'HTTP/1.0 connection-close', useTransportDefaults: true,
  },
  {
    id: 'aac-radio', label: 'AAC / Radio (baseline)', encodingProfileId: 'aac-adts',
    codec: 'aac-lc', container: 'adts', mimeType: 'audio/aac', sampleRate: 48_000,
    channelCount: 2, bitrate: 256_000, sonosStreamType: 'radio',
    uriScheme: 'x-rincon-mp3radio', metadataMode: 'empty',
    httpFraming: 'HTTP/1.0 connection-close',
  },
  {
    id: 'wav-broadcast', label: 'WAV PCM / Broadcast', encodingProfileId: 'wav-pcm',
    codec: 'pcm-s16le', container: 'wav', mimeType: 'audio/wav', sampleRate: 48_000,
    channelCount: 2, bitrate: 1_536_000, sonosStreamType: 'broadcast',
    uriScheme: 'http', metadataMode: 'audio-broadcast',
    httpFraming: 'HTTP/1.0 connection-close',
    limitation: 'Experimental; compatibility and buffering vary by Sonos model and firmware.',
  },
  {
    id: 'l16-broadcast', label: 'L16 PCM / Broadcast', encodingProfileId: 'l16-pcm',
    codec: 'pcm-s16be', container: 'l16',
    mimeType: 'audio/L16;rate=48000;channels=2', sampleRate: 48_000,
    channelCount: 2, bitrate: 1_536_000, sonosStreamType: 'broadcast',
    uriScheme: 'http', metadataMode: 'audio-broadcast',
    httpFraming: 'HTTP/1.0 connection-close',
    limitation: 'Experimental raw network-order PCM; model and firmware support varies.',
  },
] as const;

export function getSonosLatencyExperimentProfile(
  id: string
): SonosLatencyExperimentProfile | undefined {
  return sonosLatencyExperimentProfiles.find((profile) => profile.id === id);
}

export interface SonosLatencyResultSample {
  id: string;
  profileId: SonosLatencyProfileId;
  observedDelayMs: number;
  recordedAt: string;
}

export interface SonosLatencyResultSummary {
  profileId: SonosLatencyProfileId;
  samples: number;
  averageMs: number;
  minimumMs: number;
  maximumMs: number;
}

export function summarizeSonosLatencyResults(
  profileId: SonosLatencyProfileId,
  samples: readonly SonosLatencyResultSample[]
): SonosLatencyResultSummary {
  const values = samples.filter((sample) => sample.profileId === profileId)
    .map((sample) => sample.observedDelayMs);
  if (values.length === 0) {
    return { profileId, samples: 0, averageMs: 0, minimumMs: 0, maximumMs: 0 };
  }
  return {
    profileId,
    samples: values.length,
    averageMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    minimumMs: Math.min(...values),
    maximumMs: Math.max(...values),
  };
}
