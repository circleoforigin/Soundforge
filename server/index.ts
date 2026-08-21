import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

const envPath =
  path.resolve(
    __dirname,
    '../.env.local'
  );

dotenv.config({
  path: envPath,
});

import express from 'express';

import { GitHubFileClient } from './github/GitHubFileClient.ts';

import {
  registerLibraryImportRoute,
} from './routes/LibraryImportRoute.ts';

import {
  registerLibraryManifestRoute,
} from './routes/LibraryManifestRoute.ts';

import {
  registerSonosAuthRoute,
} from './routes/SonosAuthRoute.ts';

import {
  registerSonosDiscoveryRoute,
} from './routes/SonosDiscoveryRoute.ts';

import {
  registerSonosMediaRoute,
} from './routes/SonosMediaRoute.ts';
import {
  registerSonosGroupStreamRoute,
} from './routes/SonosGroupStreamRoute.ts';
import {
  registerSonosEventRoute,
} from './routes/SonosEventRoute.ts';
import { registerResearchLabDeviceRoute } from './routes/ResearchLabDeviceRoute.ts';
import { registerResearchLabStreamRoute } from './routes/ResearchLabStreamRoute.ts';
import { initializeSonosTokenStore } from './sonos/SonosTokenStore.ts';

const app = express();

const allowedClientOrigins = new Set([
  'http://localhost:5173',
  process.env.CLIENT_ORIGIN
    ?.trim()
    .replace(/\/+$/, ''),
].filter((origin): origin is string =>
  Boolean(origin)
));

app.use((request, response, next) => {
  const requestOrigin =
    request.headers.origin;

  if (
    requestOrigin &&
    allowedClientOrigins.has(requestOrigin)
  ) {
    response.header(
      'Access-Control-Allow-Origin',
      requestOrigin
    );

    response.header(
      'Vary',
      'Origin'
    );

    response.header(
      'Access-Control-Allow-Headers',
      'Content-Type'
    );

    response.header(
      'Access-Control-Allow-Methods',
      'GET, HEAD, POST, OPTIONS'
    );
  }

  if (request.method === 'OPTIONS') {
    response.sendStatus(204);
    return;
  }

  next();
});

const PORT = 3001;

app.get(
  '/api/health',
  (_request, response) => {
    response.json({
      ok: true,
      message: 'Soundforge server is running',
    });
  }
);

/*
 * Temporary GitHub write test.
 * We can remove this once the library
 * system is fully established.
 */
app.post(
  '/api/test-github-write',

  async (_request, response) => {
    try {
      const client =
        new GitHubFileClient();

      const content =
        new TextEncoder().encode(
          'Soundforge GitHub upload test'
        );

      await client.writeFile(
        'library/upload-test.txt',
        content,
        'Test Soundforge GitHub upload'
      );

      response.json({
        ok: true,
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

await initializeSonosTokenStore();

registerLibraryImportRoute(app);
registerLibraryManifestRoute(app);
registerSonosAuthRoute(app);
registerSonosDiscoveryRoute(app);
registerSonosMediaRoute(app);
registerSonosGroupStreamRoute(app);
registerSonosEventRoute(app);
registerResearchLabDeviceRoute(app);
registerResearchLabStreamRoute(app);

app.listen(PORT, () => {
  console.log(
    `Soundforge server running at http://localhost:${PORT}`
  );
});
