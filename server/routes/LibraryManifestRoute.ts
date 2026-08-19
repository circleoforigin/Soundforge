import type { Express } from 'express';

import { GitHubFileClient } from '../github/GitHubFileClient.ts';
import { githubSettings } from '../github/GitHubSettings.ts';

interface SoundLibraryManifest {
  version: number;
  updatedAt: string;
  assets: unknown[];
}

export function registerLibraryManifestRoute(
  app: Express
) {
  app.get(
    '/api/library/manifest',

    async (_request, response) => {
      try {
        const client =
          new GitHubFileClient();

        const manifestText =
          await client.readTextFile(
            githubSettings.manifestPath
          );

        if (!manifestText) {
          const emptyManifest: SoundLibraryManifest = {
            version: 1,
            updatedAt: new Date().toISOString(),
            assets: [],
          };

          response.json(emptyManifest);
          return;
        }

        const manifest =
          JSON.parse(manifestText);

        response.json(manifest);
      } catch (error) {
        console.error(error);

        response.status(500).json({
          ok: false,

          message:
            error instanceof Error
              ? error.message
              : 'Unable to load sound library.',
        });
      }
    }
  );
}