export type ContinuousAudioEncodingProfileId = 'mp3' | 'aac-adts' | 'wav-pcm' | 'l16-pcm';

export interface ContinuousAudioEncodingProfile {
  id: ContinuousAudioEncodingProfileId;
  sampleRate: number;
  channelCount: number;
  bitsPerSample: number;
  frameDurationMs: number;
  outputMimeType: string;
  outputBitrate: number;
  container: 'mp3' | 'adts' | 'wav' | 'l16';
  codec: 'mp3' | 'aac-lc' | 'pcm-s16le' | 'pcm-s16be';
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
    ffmpegOutputArguments: ['-codec:a', 'aac_mf', '-b:a', '256k', '-flush_packets', '1', '-f', 'adts'],
  },
  'wav-pcm': {
    id: 'wav-pcm', sampleRate: 48_000, channelCount: 2, bitsPerSample: 16,
    frameDurationMs: 20, outputMimeType: 'audio/wav', outputBitrate: 1_536_000,
    container: 'wav', codec: 'pcm-s16le',
    ffmpegOutputArguments: ['-codec:a', 'pcm_s16le', '-f', 'wav'],
  },
  'l16-pcm': {
    id: 'l16-pcm', sampleRate: 48_000, channelCount: 2, bitsPerSample: 16,
    frameDurationMs: 20, outputMimeType: 'audio/L16;rate=48000;channels=2', outputBitrate: 1_536_000,
    container: 'l16', codec: 'pcm-s16be',
    ffmpegOutputArguments: ['-codec:a', 'pcm_s16be', '-f', 's16be'],
  },
};

export function getContinuousAudioEncodingProfile(
  id: ContinuousAudioEncodingProfileId = 'mp3'
): ContinuousAudioEncodingProfile {
  return continuousAudioEncodingProfiles[id];
}
