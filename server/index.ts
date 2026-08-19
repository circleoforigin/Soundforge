import dotenv from 'dotenv';

dotenv.config({
  path: '.env.local',
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

const app = express();

app.use((_request, response, next) => {
  response.header(
    'Access-Control-Allow-Origin',
    'http://localhost:5173'
  );

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

registerLibraryImportRoute(app);
registerLibraryManifestRoute(app);
registerSonosAuthRoute(app);
registerSonosDiscoveryRoute(app);

app.listen(PORT, () => {
  console.log(
    `Soundforge server running at http://localhost:${PORT}`
  );
});