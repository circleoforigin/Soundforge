import type { SoundAsset } from '../../models/SoundAsset';

import type { LibraryManifestRepository } from './LibraryManifestRepository';

export class SoundMetadataRepository {
  private readonly manifestRepository: LibraryManifestRepository;

  constructor(
    manifestRepository: LibraryManifestRepository
  ) {
    this.manifestRepository = manifestRepository;
  }

  async getAll(): Promise<SoundAsset[]> {
    const manifest =
      await this.manifestRepository.load();

    return manifest.assets;
  }

  async getById(
    id: string
  ): Promise<SoundAsset | null> {
    const assets = await this.getAll();

    return (
      assets.find((asset) => asset.id === id) ??
      null
    );
  }

  async save(
    asset: SoundAsset
  ): Promise<void> {
    const manifest =
      await this.manifestRepository.load();

    const existingIndex =
      manifest.assets.findIndex(
        (existing) => existing.id === asset.id
      );

    if (existingIndex >= 0) {
      manifest.assets[existingIndex] = asset;
    } else {
      manifest.assets.push(asset);
    }

    manifest.updatedAt =
      new Date().toISOString();

    await this.manifestRepository.save(
      manifest
    );
  }

  async delete(
    id: string
  ): Promise<void> {
    const manifest =
      await this.manifestRepository.load();

    manifest.assets =
      manifest.assets.filter(
        (asset) => asset.id !== id
      );

    manifest.updatedAt =
      new Date().toISOString();

    await this.manifestRepository.save(
      manifest
    );
  }
}