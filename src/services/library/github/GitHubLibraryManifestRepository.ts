import type { LibraryManifest } from '../LibraryManifest';
import type { LibraryManifestRepository } from '../LibraryManifestRepository';

import { normalizeLibraryManifest } from '../normalizeLibraryManifest';

export interface GitHubLibraryConfig {
  owner: string;
  repo: string;
  branch: string;
  manifestPath: string;
}

export class GitHubLibraryManifestRepository
  implements LibraryManifestRepository
{
  private readonly config: GitHubLibraryConfig;

  constructor(config: GitHubLibraryConfig) {
    this.config = config;
  }

  async load(): Promise<LibraryManifest> {
    const url =
      `https://raw.githubusercontent.com/` +
      `${this.config.owner}/` +
      `${this.config.repo}/` +
      `${this.config.branch}/` +
      `${this.config.manifestPath}`;

    const response = await fetch(url, {
      cache: 'no-store',
    });

    if (!response.ok) {
      if (response.status === 404) {
        return normalizeLibraryManifest({
          version: 1,
          updatedAt: new Date().toISOString(),
          assets: [],
        });
      }

      throw new Error(
        `Unable to load library manifest: ${response.status}`
      );
    }

    const raw = await response.json();

    return normalizeLibraryManifest(raw);
  }

  async save(): Promise<void> {
    throw new Error(
      'GitHub manifest writing is not implemented yet.'
    );
  }
}
