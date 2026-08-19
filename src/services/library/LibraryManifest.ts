import type { SoundAsset } from '../../models/SoundAsset';

export interface LibraryManifest {
  version: number;
  updatedAt: string;
  assets: SoundAsset[];
}