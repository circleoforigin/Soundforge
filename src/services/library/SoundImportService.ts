import type { SoundAsset } from '../../models/SoundAsset';

import type {
  AssetStorageProvider,
} from './AssetStorageProvider';

import type {
  SoundMetadataRepository,
} from './SoundMetadataRepository';

export interface ImportSoundData {
  name: string;
  categoryPaths: string[][];
  tags: string[];
}

export class SoundImportService {
    private readonly storage: AssetStorageProvider;
    private readonly metadata: SoundMetadataRepository;

    constructor(
        storage: AssetStorageProvider,
        metadata: SoundMetadataRepository
    ) {
  this.storage = storage;
  this.metadata = metadata;
}

  async importSound(
    file: File,
    data: ImportSoundData
  ): Promise<SoundAsset> {
    const id = crypto.randomUUID();

    const storedLocation =
      await this.storage.uploadAudio(
        id,
        file
      );

    const soundAsset: SoundAsset = {
      id,
      name: data.name,
      categoryPaths: data.categoryPaths,
      tags: data.tags,

      createdAt: new Date(),
      updatedAt: new Date(),

      source: {
        type: 'url',
        path:
          storedLocation.url ??
          storedLocation.path,
      },
    };

    await this.metadata.save(soundAsset);

    return soundAsset;
  }
}