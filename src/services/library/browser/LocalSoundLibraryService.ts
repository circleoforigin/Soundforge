import type { SoundAsset } from '../../../models/SoundAsset';
import type { LibraryManifest } from '../LibraryManifest';
import { SoundMetadataRepository } from '../SoundMetadataRepository';
import { BrowserLibraryManifestRepository } from './BrowserLibraryManifestRepository';
import { FileSystemAssetStorageProvider } from './FileSystemAssetStorageProvider';
import { LibraryDirectoryHandleStore } from './LibraryDirectoryHandleStore';

interface PermissionCapableDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

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

export class LocalSoundLibraryService {
  private readonly handleStore = new LibraryDirectoryHandleStore();
  private readonly manifestRepository =
    new BrowserLibraryManifestRepository();
  private readonly metadataRepository =
    new SoundMetadataRepository(this.manifestRepository);
  private directoryHandle: FileSystemDirectoryHandle | null = null;

  get directoryConfigured(): boolean {
    return this.directoryHandle !== null;
  }

  get directoryPickerSupported(): boolean {
    return typeof window.showDirectoryPicker === 'function';
  }

  async initialize(): Promise<SoundAsset[]> {
    try {
      this.directoryHandle = await this.handleStore.load();
      this.manifestRepository.setDirectoryHandle(this.directoryHandle);

      if (
        this.directoryHandle &&
        await this.ensurePermission(this.directoryHandle, false)
      ) {
        await this.mergeDirectoryManifest();
      }
    } catch (error) {
      console.warn('Unable to restore SACscape Library directory.', error);
    }

    return this.loadAssets();
  }

  async chooseDirectory(): Promise<SoundAsset[]> {
    if (!window.showDirectoryPicker) {
      throw new Error(
        'This browser does not support choosing a persistent library folder.'
      );
    }

    const handle = await window.showDirectoryPicker({
      id: 'sacscape-library',
      mode: 'readwrite',
    });

    if (!await this.ensurePermission(handle, true)) {
      throw new Error('Read/write permission for the library folder was denied.');
    }

    await handle.getDirectoryHandle('Audio', { create: true });

    this.directoryHandle = handle;
    this.manifestRepository.setDirectoryHandle(handle);
    await this.handleStore.save(handle);
    await this.mergeDirectoryManifest();
    return this.loadAssets();
  }

  async importLocalFile(
    file: File,
    input: SoundAssetMetadataInput
  ): Promise<SoundAsset> {
    const handle = await this.requireWritableDirectory();
    const id = crypto.randomUUID();
    const storage = new FileSystemAssetStorageProvider(handle);
    const location = await storage.uploadAudio(id, file);
    const now = new Date();
    const asset: SoundAsset = {
      id,
      name: input.name,
      description: input.description,
      categoryPaths: input.categoryPaths,
      tags: input.tags,
      durationMs: input.durationMs,
      originalFileName: input.originalFileName ?? file.name,
      fileType: input.fileType,
      mimeType: input.mimeType ?? file.type,
      fileSizeBytes: input.fileSizeBytes ?? file.size,
      attribution: input.attribution,
      license: input.license,
      sourceUrl: input.sourceUrl,
      createdAt: now,
      updatedAt: now,
      source: {
        type: 'local',
        path: location.path,
        playbackUrl: await storage.resolveAudio(location.path),
      },
    };

    await this.metadataRepository.save(asset);
    return asset;
  }

  async importWebUrl(
    url: string,
    input: SoundAssetMetadataInput
  ): Promise<SoundAsset> {
    const now = new Date();
    const asset: SoundAsset = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description,
      categoryPaths: input.categoryPaths,
      tags: input.tags,
      durationMs: input.durationMs,
      originalFileName: input.originalFileName,
      fileType: input.fileType,
      mimeType: input.mimeType,
      fileSizeBytes: input.fileSizeBytes,
      attribution: input.attribution,
      license: input.license,
      sourceUrl: input.sourceUrl ?? url,
      createdAt: now,
      updatedAt: now,
      source: {
        type: 'url',
        path: url,
      },
    };

    await this.metadataRepository.save(asset);
    return asset;
  }

  async loadAssets(): Promise<SoundAsset[]> {
    const assets = await this.metadataRepository.getAll();

    if (
      !this.directoryHandle ||
      !await this.ensurePermission(this.directoryHandle, false)
    ) {
      return assets;
    }

    const storage = new FileSystemAssetStorageProvider(this.directoryHandle);

    return Promise.all(
      assets.map(async (asset) => {
        if (asset.source.type !== 'local') {
          return asset;
        }

        try {
          return {
            ...asset,
            source: {
              ...asset.source,
              playbackUrl: await storage.resolveAudio(asset.source.path),
            },
          };
        } catch (error) {
          console.warn(`Unable to resolve managed sound ${asset.id}.`, error);
          return asset;
        }
      })
    );
  }

  private async mergeDirectoryManifest(): Promise<void> {
    const cached = await this.manifestRepository.load();
    const directoryManifest =
      await this.manifestRepository.loadFromDirectory();

    if (!directoryManifest) {
      await this.manifestRepository.save({
        ...cached,
        assets: cached.assets.filter((asset) => asset.source.type === 'url'),
      });
      return;
    }

    const assets = new Map(
      cached.assets
        .filter((asset) => asset.source.type === 'url')
        .map((asset) => [asset.id, asset])
    );

    for (const asset of directoryManifest.assets) {
      assets.set(asset.id, asset);
    }

    const merged: LibraryManifest = {
      version: Math.max(cached.version, directoryManifest.version),
      updatedAt: new Date().toISOString(),
      assets: [...assets.values()],
    };
    await this.manifestRepository.save(merged);
  }

  private async requireWritableDirectory(): Promise<FileSystemDirectoryHandle> {
    if (!this.directoryHandle) {
      throw new Error('Choose a SACscape Library folder before importing a file.');
    }

    if (!await this.ensurePermission(this.directoryHandle, true)) {
      throw new Error('Read/write permission for the library folder was denied.');
    }

    return this.directoryHandle;
  }

  private async ensurePermission(
    handle: FileSystemDirectoryHandle,
    request: boolean
  ): Promise<boolean> {
    const permissionHandle = handle as PermissionCapableDirectoryHandle;

    if (!permissionHandle.queryPermission) {
      return true;
    }

    const descriptor = { mode: 'readwrite' as const };
    const current = await permissionHandle.queryPermission(descriptor);

    if (current === 'granted') {
      return true;
    }

    if (!request || !permissionHandle.requestPermission) {
      return false;
    }

    return await permissionHandle.requestPermission(descriptor) === 'granted';
  }
}

export const localSoundLibrary = new LocalSoundLibraryService();
