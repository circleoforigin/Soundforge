import type { LibraryManifest } from './LibraryManifest';

export interface LibraryManifestRepository {
  load(): Promise<LibraryManifest>;

  save(
    manifest: LibraryManifest
  ): Promise<void>;
}