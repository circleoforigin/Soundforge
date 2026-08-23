import { json, type Express, type Request } from 'express';
import type {
  AudioStreamListResponse,
  AudioStreamSnapshotResponse,
  ContinuousHttpFramingMode,
} from '../../src/models/ResearchLab.ts';

import {
  ContinuousAudioStreamManager,
  continuousAudioStreamManager,
} from '../audio/ContinuousAudioStreamManager.ts';
import {
  ResearchLabRequestError,
  ResearchLabStreamService,
  researchLabStreamService,
} from '../research-lab/ResearchLabStreamService.ts';
import { SonosTopologyCooldownError } from '../research-lab/SonosAudioDeviceDiscovery.ts';
import { SonosApiError, SonosTopologyTimeoutError } from '../sonos/SonosClient.ts';

function researchLabStatus(error: unknown): number {
  if (error instanceof ResearchLabRequestError || error instanceof SonosTopologyCooldownError) {
    return error.status;
  }
  return error instanceof SonosApiError ? error.status : 500;
}

function researchLabErrorCode(error: unknown): string {
  if (error instanceof ResearchLabRequestError) return error.code;
  if (error instanceof SonosApiError && error.status === 429) return 'SONOS_RATE_LIMITED';
  if (error instanceof SonosTopologyCooldownError) return 'SONOS_RATE_LIMIT_COOLDOWN';
  if (error instanceof SonosTopologyTimeoutError) return 'SONOS_TOPOLOGY_TIMEOUT';
  return 'RESEARCH_LAB_OPERATION_FAILED';
}

function getPublicBaseUrl(request: Request): string {
  const configuredBaseUrl = process.env.PUBLIC_API_BASE_URL?.trim();
  const forwardedProtocol = request.header('x-forwarded-proto')?.split(',')[0]?.trim();
  return (
    configuredBaseUrl || `${forwardedProtocol || request.protocol}://${request.get('host')}`
  ).replace(/\/+$/, '');
}

// Four-plus days of 192 kbps audio: deliberately much longer than a Lab experiment,
// while remaining a conservative valid integer for Node and HTTP clients.
export const indefiniteStreamContentLength = 8 * 1_024 * 1_024 * 1_024;

function isHttpFramingMode(value: unknown): value is ContinuousHttpFramingMode {
  return value === 'chunked' || value === 'indefinite-content-length';
}

export interface ResearchLabStreamRouteDependencies {
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
    const { deviceId, transportId, httpFramingMode, latencyProfileId } = request.body as {
      deviceId?: unknown;
      transportId?: unknown;
      httpFramingMode?: unknown;
      latencyProfileId?: unknown;
    };
    if (typeof deviceId !== 'string' || typeof transportId !== 'string') {
      response.status(400).json({
        ok: false,
        message: 'deviceId and transportId are required.',
      });
      return;
    }
    if (httpFramingMode !== undefined && !isHttpFramingMode(httpFramingMode)) {
      response.status(400).json({
        ok: false,
        message: 'Unknown HTTP stream framing mode.',
      });
      return;
    }
    if (latencyProfileId !== undefined && typeof latencyProfileId !== 'string') {
      response.status(400).json({ ok: false, message: 'latencyProfileId must be a string.' });
      return;
    }
    try {
      const baseUrl = getPublicBaseUrl(request);
      const stream = await service.start(
        deviceId,
        transportId,
        (streamId) => `${baseUrl}/api/research-lab/streams/${encodeURIComponent(streamId)}/live.mp3`,
        httpFramingMode ?? 'chunked',
        latencyProfileId as string | undefined
      );
      response.status(201).json({ ok: true, stream });
    } catch (error) {
      response.status(researchLabStatus(error)).json({
        ok: false,
        code: researchLabErrorCode(error),
        message: error instanceof Error ? error.message : 'Unable to start continuous stream.',
      });
    }
  });

  app.post('/api/research-lab/streams/:streamId/latency-tone', json(), (request, response) => {
    try {
      const body = request.body && typeof request.body === 'object'
        ? request.body as Record<string, unknown>
        : {};
      response.json({
        ok: true,
        stream: service.injectLatencyTone(request.params.streamId, {
          correlationId: typeof body.correlationId === 'string' ? body.correlationId : undefined,
          uiStreamId: typeof body.streamId === 'string' ? body.streamId : undefined,
          profileId: typeof body.profileId === 'string' ? body.profileId : undefined,
          deviceId: typeof body.deviceId === 'string' ? body.deviceId : undefined,
          requestStartedAt: typeof body.requestStartedAt === 'string' ? body.requestStartedAt : undefined,
          requestPath: request.path,
        }),
      });
    } catch (error) {
      response.status(error instanceof ResearchLabRequestError ? error.status : 500).json({
        ok: false,
        code: researchLabErrorCode(error),
        message: error instanceof Error ? error.message : 'Unable to inject latency tone.',
        ...(error instanceof ResearchLabRequestError && error.details ? error.details : {}),
      });
    }
  });

  app.post('/api/research-lab/streams/:streamId/latency-result', json(), (request, response) => {
    try {
      const observedDelayMs = Number((request.body as { observedDelayMs?: unknown }).observedDelayMs);
      response.json({
        ok: true,
        stream: service.recordLatencyObservation(request.params.streamId, observedDelayMs),
      });
    } catch (error) {
      response.status(error instanceof ResearchLabRequestError ? error.status : 500).json({
        ok: false,
        message: error instanceof Error ? error.message : 'Unable to record latency result.',
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

    const httpFramingMode = stream.getSnapshot().httpClient.framingMode;
    const responseHeaders: Record<string, string> = {
      'Cache-Control': 'no-store, no-cache, must-revalidate, no-transform',
      Connection: 'keep-alive',
      'Content-Type': stream.getOutputFormat().outputMimeType,
    };
    if (httpFramingMode === 'chunked') {
      responseHeaders['Transfer-Encoding'] = 'chunked';
    } else {
      responseHeaders['Content-Length'] = String(indefiniteStreamContentLength);
    }
    response.status(200).set(responseHeaders);
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
      httpFramingMode,
    }, 'http-response-metadata');
    if (httpFramingMode === 'indefinite-content-length') {
      stream.addDiagnosticEvent(
        'http',
        'Experimental non-chunked HTTP stream response started.',
        {
          declaredContentLength: indefiniteStreamContentLength,
          actualBytesWritten: 0,
        },
        'indefinite-response-started'
      );
    }
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
