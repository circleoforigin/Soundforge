import { json, type Express, type Request } from 'express';
import type {
  AudioStreamListResponse,
  AudioStreamSnapshotResponse,
} from '../../src/models/ResearchLab.ts';

import { continuousAudioFormat } from '../audio/ContinuousAudioStream.ts';
import {
  ContinuousAudioStreamManager,
  continuousAudioStreamManager,
} from '../audio/ContinuousAudioStreamManager.ts';
import {
  ResearchLabRequestError,
  ResearchLabStreamService,
  researchLabStreamService,
} from '../research-lab/ResearchLabStreamService.ts';

function getPublicBaseUrl(request: Request): string {
  const configuredBaseUrl = process.env.PUBLIC_API_BASE_URL?.trim();
  const forwardedProtocol = request.header('x-forwarded-proto')?.split(',')[0]?.trim();
  return (
    configuredBaseUrl || `${forwardedProtocol || request.protocol}://${request.get('host')}`
  ).replace(/\/+$/, '');
}

interface ResearchLabStreamRouteDependencies {
  manager: ContinuousAudioStreamManager;
  service: ResearchLabStreamService;
}

export function registerResearchLabStreamRoute(
  app: Express,
  dependencies: ResearchLabStreamRouteDependencies = {
    manager: continuousAudioStreamManager,
    service: researchLabStreamService,
  }
): void {
  const { manager, service } = dependencies;
  app.get('/api/research-lab/streams', (_request, response) => {
    const result: AudioStreamListResponse = {
      ok: true,
      streams: manager.listSnapshots(),
    };
    response.json(result);
  });

  app.get('/api/research-lab/streams/:streamId', (request, response) => {
    const stream = manager.getSnapshot(request.params.streamId);
    if (!stream) {
      response.status(404).json({
        ok: false,
        message: 'Continuous audio stream not found.',
      });
      return;
    }
    const result: AudioStreamSnapshotResponse = { ok: true, stream };
    response.json(result);
  });

  app.post('/api/research-lab/streams', json(), async (request, response) => {
    const { deviceId, transportId } = request.body as {
      deviceId?: unknown;
      transportId?: unknown;
    };
    if (typeof deviceId !== 'string' || typeof transportId !== 'string') {
      response.status(400).json({
        ok: false,
        message: 'deviceId and transportId are required.',
      });
      return;
    }
    try {
      const baseUrl = getPublicBaseUrl(request);
      const stream = await service.start(
        deviceId,
        transportId,
        (streamId) => `${baseUrl}/api/research-lab/streams/${encodeURIComponent(streamId)}/live.mp3`
      );
      response.status(201).json({ ok: true, stream });
    } catch (error) {
      response.status(error instanceof ResearchLabRequestError ? error.status : 500).json({
        ok: false,
        message: error instanceof Error ? error.message : 'Unable to start continuous stream.',
      });
    }
  });

  app.post('/api/research-lab/streams/:streamId/tone', json(), (request, response) => {
    try {
      response.json({ ok: true, stream: service.injectTone(request.params.streamId) });
    } catch (error) {
      response.status(error instanceof ResearchLabRequestError ? error.status : 500).json({
        ok: false,
        message: error instanceof Error ? error.message : 'Unable to inject diagnostic tone.',
      });
    }
  });

  app.delete('/api/research-lab/streams/:streamId', async (request, response) => {
    try {
      const result = await service.stop(request.params.streamId);
      if (result.transportError) {
        response.status(207).json({
          ok: false,
          partialFailure: true,
          message: `Local stream stopped, but transport cleanup failed: ${result.transportError}`,
          stream: result.snapshot,
        });
        return;
      }
      response.json({ ok: true, stream: result.snapshot });
    } catch (error) {
      response.status(error instanceof ResearchLabRequestError ? error.status : 500).json({
        ok: false,
        message: error instanceof Error ? error.message : 'Unable to stop continuous stream.',
      });
    }
  });

  app.get('/api/research-lab/streams/:streamId/live.mp3', (request, response) => {
    const stream = manager.getActive(request.params.streamId);
    if (!stream) {
      response.status(404).json({ ok: false, message: 'Continuous audio stream not found.' });
      return;
    }

    response.status(200).set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, no-transform',
      Connection: 'keep-alive',
      'Content-Type': continuousAudioFormat.outputMimeType,
      'Transfer-Encoding': 'chunked',
    });
    stream.addDiagnosticEvent('http', 'Research Lab stream HTTP request received.', {
      method: request.method,
      pathSegments: ['api', 'research-lab', 'streams', '[stream-id]', 'live.mp3'],
      userAgent: request.header('user-agent') ?? null,
      range: request.header('range') ?? null,
      accept: request.header('accept') ?? null,
      connection: request.header('connection') ?? null,
    }, 'http-request-metadata');
    stream.addDiagnosticEvent('http', 'Research Lab stream HTTP response prepared.', {
      statusCode: response.statusCode,
      contentType: response.getHeader('content-type') ?? null,
      transferEncoding: response.getHeader('transfer-encoding') ?? null,
      contentLength: response.getHeader('content-length') ?? null,
      acceptRanges: response.getHeader('accept-ranges') ?? null,
      cacheControl: response.getHeader('cache-control') ?? null,
      connection: response.getHeader('connection') ?? null,
    }, 'http-response-metadata');
    response.flushHeaders();

    try {
      stream.bindHttpClient(response);
    } catch (error) {
      if (!response.writableEnded) {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  });
}
