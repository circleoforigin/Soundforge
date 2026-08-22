export type ContinuousAudioEncodingProfileId = 'mp3' | 'aac-adts';

export interface ContinuousAudioEncodingProfile {
  id: ContinuousAudioEncodingProfileId;
  sampleRate: number;
  channelCount: number;
  bitsPerSample: number;
  frameDurationMs: number;
  outputMimeType: string;
  outputBitrate: number;
  container: 'mp3' | 'adts';
  codec: 'mp3' | 'aac-lc';
  ffmpegOutputArguments: string[];
}

export const continuousAudioEncodingProfiles: Record<
  ContinuousAudioEncodingProfileId,
  ContinuousAudioEncodingProfile
> = {
  mp3: {
    id: 'mp3', sampleRate: 44_100, channelCount: 2, bitsPerSample: 16,
    frameDurationMs: 20, outputMimeType: 'audio/mpeg', outputBitrate: 192_000,
    container: 'mp3', codec: 'mp3',
    ffmpegOutputArguments: ['-codec:a', 'libmp3lame', '-b:a', '192k', '-write_xing', '0', '-flush_packets', '1', '-f', 'mp3'],
  },
  'aac-adts': {
    id: 'aac-adts', sampleRate: 48_000, channelCount: 2, bitsPerSample: 16,
    frameDurationMs: 20, outputMimeType: 'audio/aac', outputBitrate: 256_000,
    container: 'adts', codec: 'aac-lc',
    ffmpegOutputArguments: ['-codec:a', 'aac', '-profile:a', 'aac_low', '-b:a', '256k', '-flush_packets', '1', '-f', 'adts'],
  },
};

export function getContinuousAudioEncodingProfile(
  id: ContinuousAudioEncodingProfileId = 'mp3'
): ContinuousAudioEncodingProfile {
  return continuousAudioEncodingProfiles[id];
}
