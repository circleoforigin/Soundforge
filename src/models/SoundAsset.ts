import type { LibraryEntity } from './PersistentEntity';

export type SoundSourceType = 'local' | 'url';

export interface SoundAssetSource {
  type: SoundSourceType;
  /** Managed relative path for local files, or the external URL. */
  path: string;
  /** Runtime-only object URL used to play a managed local file. */
  playbackUrl?: string;
}

export interface SoundAsset extends LibraryEntity {
  source: SoundAssetSource;

  durationMs?: number;

  originalFileName?: string;
  fileType?: string;
  mimeType?: string;
  fileSizeBytes?: number;

  description?: string;

  attribution?: string;
  license?: string;
  sourceUrl?: string;
}

export function getSoundAssetPlaybackUrl(asset: SoundAsset): string {
  return asset.source.playbackUrl ?? asset.source.path;
}
