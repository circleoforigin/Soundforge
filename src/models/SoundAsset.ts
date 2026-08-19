import type { LibraryEntity } from './PersistentEntity';

export type SoundSourceType = 'local' | 'url';

export interface SoundAsset extends LibraryEntity {
  source: {
    type: SoundSourceType;
    path: string;
  };

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