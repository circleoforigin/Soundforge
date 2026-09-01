import type {
  SoundAsset,
} from '../../models/SoundAsset';

import {
  hostedCollectionRepository,
} from '../../host/HostedCollectionRepository';

import {
  hostedFileRepository,
} from '../../host/HostedFileRepository';

export interface SoundAssetMetadataInput {
  name: string;
  description: string;
  categoryPaths: string[][];
  tags: string[];
  durationMs?: number;
  originalFileName?: string;
  fileType?: string;
  mimeType?: string;
  fileSizeBytes?: number;
  attribution?: string;
  license?: string;
  sourceUrl?: string;
}

const SOUND_ASSETS_COLLECTION =
  'soundAssets';

const AUDIO_FOLDER =
  'audio';

export class HostedSoundLibraryService {
  private readonly playbackUrls =
    new Map<string, string>();
  private readonly hydrationRequests =
    new Map<string, Promise<SoundAsset>>();

  async initialize(): Promise<SoundAsset[]> {
    return this.loadAssets();
  }

  async loadAssets(): Promise<SoundAsset[]> {
    return hostedCollectionRepository.loadAll<SoundAsset>(
      SOUND_ASSETS_COLLECTION
    );
  }

  async ensurePlaybackUrl(asset: SoundAsset): Promise<SoundAsset> {
    if (asset.source.type !== 'local' || asset.source.playbackUrl) {
      return asset;
    }

    const cachedUrl = this.playbackUrls.get(asset.id);

    if (cachedUrl) {
      return {
        ...asset,
        source: {
          ...asset.source,
          playbackUrl: cachedUrl,
        },
      };
    }

    const pending = this.hydrationRequests.get(asset.id);
    if (pending) return pending;

    const request = this.hydrateAsset(asset).finally(() => {
      this.hydrationRequests.delete(asset.id);
    });
    this.hydrationRequests.set(asset.id, request);
    return request;
  }

  async importLocalFile(
    file: File,
    input: SoundAssetMetadataInput
  ): Promise<SoundAsset> {
    const id =
      crypto.randomUUID();

    const fileName =
      this.createManagedFileName(
        id,
        file.name
      );

    await hostedFileRepository.saveFile(
      AUDIO_FOLDER,
      fileName,
      file
    );

    const now =
      new Date();

    const playbackUrl =
      this.createPlaybackUrl(
        id,
        file
      );

    const asset: SoundAsset = {
      id,
      name: input.name,
      description:
        input.description,
      categoryPaths:
        input.categoryPaths,
      tags:
        input.tags,
      durationMs:
        input.durationMs,
      originalFileName:
        input.originalFileName ??
        file.name,
      fileType:
        input.fileType,
      mimeType:
        input.mimeType ??
        file.type,
      fileSizeBytes:
        input.fileSizeBytes ??
        file.size,
      attribution:
        input.attribution,
      license:
        input.license,
      sourceUrl:
        input.sourceUrl,
      createdAt:
        now,
      updatedAt:
        now,

      source: {
        type:
          'local',

        path:
          fileName,

        playbackUrl,
      },
    };

    await this.saveMetadata(
      asset
    );

    return asset;
  }

  async importWebUrl(
    url: string,
    input: SoundAssetMetadataInput
  ): Promise<SoundAsset> {
    const now =
      new Date();

    const asset: SoundAsset = {
      id:
        crypto.randomUUID(),

      name:
        input.name,

      description:
        input.description,

      categoryPaths:
        input.categoryPaths,

      tags:
        input.tags,

      durationMs:
        input.durationMs,

      originalFileName:
        input.originalFileName,

      fileType:
        input.fileType,

      mimeType:
        input.mimeType,

      fileSizeBytes:
        input.fileSizeBytes,

      attribution:
        input.attribution,

      license:
        input.license,

      sourceUrl:
        input.sourceUrl ??
        url,

      createdAt:
        now,

      updatedAt:
        now,

      source: {
        type:
          'url',

        path:
          url,
      },
    };

    await this.saveMetadata(
      asset
    );

    return asset;
  }

  async readManagedAsset(
    asset: SoundAsset
  ): Promise<File> {
    if (
      asset.source.type !==
      'local'
    ) {
      throw new Error(
        'Only managed local assets can be read as files.'
      );
    }

    const blob =
      await hostedFileRepository
        .readBlob(
          AUDIO_FOLDER,
          asset.source.path,
          asset.mimeType ??
            'application/octet-stream'
        );

    if (!blob) {
      throw new Error(
        `Managed sound file "${asset.source.path}" was not found.`
      );
    }

    return new File(
      [
        blob,
      ],
      asset.originalFileName ??
        asset.source.path,
      {
        type:
          asset.mimeType ??
          blob.type ??
          'application/octet-stream',
      }
    );
  }

  private async hydrateAsset(
    asset: SoundAsset
  ): Promise<SoundAsset> {
    const blob =
      await hostedFileRepository
        .readBlob(
          AUDIO_FOLDER,
          asset.source.path,
          asset.mimeType ??
            'application/octet-stream'
        );

    if (!blob) {
      console.warn(
        `Unable to load managed sound ${asset.id}.`
      );

      return asset;
    }

    return {
      ...asset,

      source: {
        ...asset.source,

        playbackUrl:
          this.createPlaybackUrl(
            asset.id,
            blob
          ),
      },
    };
  }

  private async saveMetadata(
    asset: SoundAsset
  ): Promise<void> {
    const persistentAsset: SoundAsset = {
      ...asset,

      source: {
        type:
          asset.source.type,

        path:
          asset.source.path,
      },
    };

    await hostedCollectionRepository.save(
      SOUND_ASSETS_COLLECTION,
      asset.id,
      persistentAsset
    );
  }

  private createManagedFileName(
    id: string,
    originalFileName: string
  ): string {
    const match =
      originalFileName.match(
        /\.([A-Za-z0-9]+)$/
      );

    if (!match) {
      return id;
    }

    return `${id}.${match[1].toLowerCase()}`;
  }

  private createPlaybackUrl(
    assetId: string,
    blob: Blob
  ): string {
    const previous =
      this.playbackUrls.get(
        assetId
      );

    if (previous) {
      URL.revokeObjectURL(
        previous
      );
    }

    const playbackUrl =
      URL.createObjectURL(
        blob
      );

    this.playbackUrls.set(
      assetId,
      playbackUrl
    );

    return playbackUrl;
  }
}

export const hostedSoundLibrary =
  new HostedSoundLibraryService();
