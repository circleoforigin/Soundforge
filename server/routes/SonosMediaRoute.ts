import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Express, Request } from 'express';
import multer from 'multer';
import { logSonosError, logSonosInfo } from '../sonos/SonosDiagnosticLog.ts';
import { inspectAudioFormat } from '../sonos/AudioFormatInspector.ts';

const routeDirectory = path.dirname(fileURLToPath(import.meta.url));
const mediaDirectory = path.resolve(routeDirectory, '../../data/sonos-media');
const assetIdPattern = /^[a-zA-Z0-9-]{1,100}$/;
const supportedMedia = new Map([
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/wave', '.wav'],
]);
const mediaTypes = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

function getAssetId(request: Request): string {
  const rawAssetId = request.params.assetId;
  const assetId = Array.isArray(rawAssetId) ? rawAssetId[0] : rawAssetId;

  if (!assetIdPattern.test(assetId)) {
    throw new Error('Invalid Sonos media asset ID.');
  }

  return assetId;
}

function findMediaPath(assetId: string): string | null {
  for (const extension of mediaTypes.keys()) {
    const mediaPath = path.join(mediaDirectory, `${assetId}${extension}`);

    if (fs.existsSync(mediaPath)) {
      return mediaPath;
    }
  }

  return null;
}

function getPublicMediaUrl(request: Request, assetId: string): string {
  const configuredBaseUrl = process.env.PUBLIC_API_BASE_URL?.trim();
  const forwardedProtocol = request.header('x-forwarded-proto')?.split(',')[0];
  const protocol = forwardedProtocol?.trim() || request.protocol;
  const baseUrl = (configuredBaseUrl || `${protocol}://${request.get('host')}`)
    .replace(/\/+$/, '');

  return `${baseUrl}/api/sonos/media/${encodeURIComponent(assetId)}`;
}

async function logMediaFormat(assetId: string, mediaPath: string): Promise<void> {
  const handle = await fs.promises.open(mediaPath, 'r');
  try {
    const stats = await handle.stat();
    const probe = Buffer.alloc(Math.min(stats.size, 256 * 1024));
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    logSonosInfo('MEDIA', 'Sonos media format inspection.', {
      assetId,
      fileSizeBytes: stats.size,
      declaredMimeType: mediaTypes.get(path.extname(mediaPath)) ?? null,
      ...inspectAudioFormat(probe.subarray(0, bytesRead)),
    });
  } finally {
    await handle.close();
  }
}

export function registerSonosMediaRoute(app: Express) {
  app.use('/api/sonos/media/:assetId', (request, response, next) => {
    const startedAt = new Date().toISOString();

    response.on('finish', () => {
      logSonosInfo('MEDIA', 'Sonos media request.', {
        timestamp: startedAt,
        method: request.method,
        assetId: request.params.assetId,
        userAgent: request.header('user-agent') ?? null,
        range: request.header('range') ?? null,
        responseStatus: response.statusCode,
        bytesServed: response.locals.bytesServed ?? 0,
        servedRange: response.locals.servedRange ?? null,
        totalBytes: response.locals.totalBytes ?? null,
      });
    });

    next();
  });

  app.post(
    '/api/sonos/media/:assetId',
    upload.single('file'),
    async (request, response) => {
      try {
        const assetId = getAssetId(request);
        const file = request.file;

        if (!file) {
          response.status(400).json({ ok: false, message: 'No audio file was provided.' });
          return;
        }

        const extension = supportedMedia.get(file.mimetype.toLowerCase());

        if (!extension) {
          response.status(415).json({
            ok: false,
            message: 'Sonos One Shots currently support WAV and MP3 assets only.',
          });
          return;
        }

        await fs.promises.mkdir(mediaDirectory, { recursive: true });

        const existingPath = findMediaPath(assetId);
        const destination = path.join(mediaDirectory, `${assetId}${extension}`);
        const temporaryPath = `${destination}.${crypto.randomUUID()}.tmp`;

        try {
          await fs.promises.writeFile(temporaryPath, file.buffer, { flag: 'wx' });

          if (existingPath) {
            await fs.promises.rm(existingPath);
          }

          await fs.promises.rename(temporaryPath, destination);
        } catch (error) {
          await fs.promises.rm(temporaryPath, { force: true });
          throw error;
        }

        await logMediaFormat(assetId, destination);

        response.json({
          ok: true,
          assetId,
          streamUrl: getPublicMediaUrl(request, assetId),
        });
      } catch (error) {
        logSonosError('Sonos media synchronization failed.', {
          assetId: request.params.assetId,
          error,
        });
        response.status(400).json({
          ok: false,
          message: error instanceof Error ? error.message : 'Unable to synchronize Sonos media.',
        });
      }
    }
  );

  app.head('/api/sonos/media/:assetId', (request, response) => {
    try {
      const assetId = getAssetId(request);
      const mediaPath = findMediaPath(assetId);

      if (!mediaPath) {
        response.sendStatus(404);
        return;
      }

      const stats = fs.statSync(mediaPath);
      void logMediaFormat(assetId, mediaPath).catch((error) => {
        logSonosError('Sonos media format inspection failed.', { assetId, error });
      });
      response.locals.totalBytes = stats.size;
      response.set({
        'Accept-Ranges': 'bytes',
        'Content-Length': stats.size.toString(),
        'Content-Type': mediaTypes.get(path.extname(mediaPath)) ?? 'application/octet-stream',
      });
      response.status(200).end();
    } catch (error) {
      logSonosError('Sonos media HEAD failed.', {
        assetId: request.params.assetId,
        error,
      });
      response.sendStatus(400);
    }
  });

  app.get('/api/sonos/media/:assetId', (request, response) => {
    try {
      const assetId = getAssetId(request);
      const mediaPath = findMediaPath(assetId);

      if (!mediaPath) {
        response.status(404).json({ ok: false, message: 'Sonos media asset is not synchronized.' });
        return;
      }

      const stats = fs.statSync(mediaPath);
      response.locals.totalBytes = stats.size;
      const mimeType = mediaTypes.get(path.extname(mediaPath)) ?? 'application/octet-stream';
      const range = request.headers.range;

      response.set('Accept-Ranges', 'bytes');
      response.set('Content-Type', mimeType);

      if (!range) {
        response.locals.bytesServed = stats.size;
        response.locals.servedRange = `bytes 0-${stats.size - 1}/${stats.size}`;
        response.set('Content-Length', stats.size.toString());
        fs.createReadStream(mediaPath).pipe(response);
        return;
      }

      const match = /^bytes=(\d*)-(\d*)$/.exec(range);

      if (!match) {
        response.status(416).set('Content-Range', `bytes */${stats.size}`).end();
        return;
      }

      const suffixLength = !match[1] && match[2] ? Number(match[2]) : null;
      const start = suffixLength === null
        ? Number(match[1])
        : Math.max(0, stats.size - suffixLength);
      const end = suffixLength === null && match[2]
        ? Number(match[2])
        : stats.size - 1;

      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end ||
        end >= stats.size
      ) {
        response.status(416).set('Content-Range', `bytes */${stats.size}`).end();
        return;
      }

      response.status(206).set({
        'Content-Length': (end - start + 1).toString(),
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
      });
      response.locals.bytesServed = end - start + 1;
      response.locals.servedRange = `bytes ${start}-${end}/${stats.size}`;
      fs.createReadStream(mediaPath, { start, end }).pipe(response);
    } catch (error) {
      logSonosError('Sonos media request failed.', {
        assetId: request.params.assetId,
        error,
      });
      response.status(400).json({
        ok: false,
        message: error instanceof Error ? error.message : 'Unable to serve Sonos media.',
      });
    }
  });
}
