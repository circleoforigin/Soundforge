import type { LibraryManifest } from '../LibraryManifest';
import type { LibraryManifestRepository } from '../LibraryManifestRepository';
import { normalizeLibraryManifest } from '../normalizeLibraryManifest';

const MANIFEST_CACHE_KEY = 'sacscape.library.manifest';

export class BrowserLibraryManifestRepository
  implements LibraryManifestRepository
{
  private directoryHandle: FileSystemDirectoryHandle | null = null;

  setDirectoryHandle(handle: FileSystemDirectoryHandle | null): void {
    this.directoryHandle = handle;
  }

  async load(): Promise<LibraryManifest> {
    const cached = localStorage.getItem(MANIFEST_CACHE_KEY);

    if (!cached) {
      return normalizeLibraryManifest(null);
    }

    try {
      return normalizeLibraryManifest(JSON.parse(cached));
    } catch {
      return normalizeLibraryManifest(null);
    }
  }

  async loadFromDirectory(): Promise<LibraryManifest | null> {
    if (!this.directoryHandle) {
      return null;
    }

    try {
      const fileHandle = await this.directoryHandle.getFileHandle(
        'manifest.json'
      );
      const file = await fileHandle.getFile();
      return normalizeLibraryManifest(JSON.parse(await file.text()));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return null;
      }

      throw error;
    }
  }

  async save(manifest: LibraryManifest): Promise<void> {
    const serialized = JSON.stringify(
      manifest,
      (key, value) => key === 'playbackUrl' ? undefined : value,
      2
    );
    localStorage.setItem(MANIFEST_CACHE_KEY, serialized);

    if (!this.directoryHandle) {
      return;
    }

    try {
      const fileHandle = await this.directoryHandle.getFileHandle(
        'manifest.json',
        { create: true }
      );
      const writable = await fileHandle.createWritable();

      try {
        await writable.write(serialized);
      } finally {
        await writable.close();
      }
    } catch (error) {
      console.warn(
        'The local manifest was cached, but manifest.json could not be updated.',
        error
      );
    }
  }
}
