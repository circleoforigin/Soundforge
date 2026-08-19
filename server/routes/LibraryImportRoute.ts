import type { Express } from 'express';
import multer from 'multer';

import { GitHubFileClient } from '../github/GitHubFileClient.ts';
import { githubSettings } from '../github/GitHubSettings.ts';

const upload = multer({
  storage: multer.memoryStorage(),
});

interface StoredSoundAsset {
  id: string;

  createdAt: string;
  updatedAt: string;

  name: string;

  categoryPaths: string[][];
  tags: string[];

  source: {
    type: 'url';
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

interface SoundLibraryManifest {
  version: number;
  updatedAt: string;
  assets: StoredSoundAsset[];
}

export function registerLibraryImportRoute(
  app: Express
) {
  app.post(
    '/api/library/import',
    upload.single('file'),

    async (request, response) => {
      try {
        const file = request.file;

        if (!file) {
          response.status(400).json({
            ok: false,
            message: 'No audio file was provided.',
          });

          return;
        }

        const assetId =
          crypto.randomUUID();

        const now =
          new Date().toISOString();

        const originalName =
          file.originalname;

        const extension =
          originalName.includes('.')
            ? originalName.substring(
                originalName.lastIndexOf('.')
              )
            : '';

        const githubPath =
          `${githubSettings.audioPath}/` +
          `${assetId}${extension}`;

        const client =
          new GitHubFileClient();

        /*
         * STEP 1:
         * Upload the actual audio file.
         */
        await client.writeFile(
          githubPath,
          file.buffer,
          `Import sound: ${originalName}`
        );

        /*
         * STEP 2:
         * Parse metadata sent by Soundforge.
         */
        const categoryPaths =
          request.body.categoryPaths
            ? JSON.parse(
                request.body.categoryPaths
              )
            : [];

        const tags =
          request.body.tags
            ? JSON.parse(
                request.body.tags
              )
            : [];

        /*
         * This URL is what the browser will
         * eventually use to stream the sound.
         */
        const rawAudioUrl =
          `https://raw.githubusercontent.com/` +
          `${githubSettings.owner}/` +
          `${githubSettings.repo}/` +
          `${githubSettings.branch}/` +
          `${githubPath}`;

        const soundAsset: StoredSoundAsset = {
          id: assetId,

          createdAt: now,
          updatedAt: now,

          name:
            request.body.name ||
            originalName,

          categoryPaths,
          tags,

          source: {
            type: 'url',
            path: rawAudioUrl,
          },

          originalFileName:
            request.body.originalFileName ||
            originalName,

          fileType:
            request.body.fileType ||
            extension.replace('.', '').toLowerCase(),

          mimeType:
            request.body.mimeType ||
            file.mimetype,

          fileSizeBytes:
            request.body.fileSizeBytes
              ? Number(
                  request.body.fileSizeBytes
                )
              : file.size,
        };

        if (request.body.durationMs) {
          soundAsset.durationMs =
            Number(
              request.body.durationMs
            );
        }

        if (request.body.description) {
          soundAsset.description =
            request.body.description;
        }

        if (request.body.attribution) {
          soundAsset.attribution =
            request.body.attribution;
        }

        if (request.body.license) {
          soundAsset.license =
            request.body.license;
        }

        if (request.body.sourceUrl) {
          soundAsset.sourceUrl =
            request.body.sourceUrl;
        }

        /*
         * STEP 3:
         * Load the existing manifest.
         *
         * If it doesn't exist yet,
         * create the first one.
         */
        const existingManifestText =
          await client.readTextFile(
            githubSettings.manifestPath
          );

        let manifest:
          SoundLibraryManifest;

        if (existingManifestText) {
          manifest =
            JSON.parse(
              existingManifestText
            ) as SoundLibraryManifest;
        } else {
          manifest = {
            version: 1,
            updatedAt: now,
            assets: [],
          };
        }

        /*
         * STEP 4:
         * Add this SoundAsset.
         */
        manifest.assets.push(
          soundAsset
        );

        manifest.updatedAt = now;

        /*
         * STEP 5:
         * Write the complete manifest
         * back to GitHub.
         */
        const manifestJson =
          JSON.stringify(
            manifest,
            null,
            2
          );

        await client.writeFile(
          githubSettings.manifestPath,

          new TextEncoder().encode(
            manifestJson
          ),

          `Update sound library: ${soundAsset.name}`
        );

        /*
         * STEP 6:
         * Tell Soundforge what was created.
         */
        response.json({
          ok: true,
          asset: soundAsset,
        });
      } catch (error) {
        console.error(error);

        response.status(500).json({
          ok: false,

          message:
            error instanceof Error
              ? error.message
              : 'Unknown error',
        });
      }
    }
  );
}