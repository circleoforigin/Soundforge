import { json, type Express, type Request } from 'express';

import { SonosApiError, SonosClient } from '../sonos/SonosClient.ts';
import { sonosContinuousGroupStream } from '../sonos/SonosContinuousGroupStream.ts';
import { logSonosError, logSonosInfo } from '../sonos/SonosDiagnosticLog.ts';

const attachedGroups = new Map<string, { sessionId: string; streamUrl: string }>();

function getPublicStreamUrl(request: Request): string {
  const configuredBaseUrl = process.env.PUBLIC_API_BASE_URL?.trim();
  const forwardedProtocol = request.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const baseUrl = (
    configuredBaseUrl || `${forwardedProtocol || request.protocol}://${request.get('host')}`
  ).replace(/\/+$/, '');
  return `${baseUrl}/api/sonos/group-stream/live.mp3`;
}

export function registerSonosGroupStreamRoute(app: Express): void {
  app.get('/api/sonos/group-stream/live.mp3', (request, response) => {
    response.status(200).set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
    });
    response.flushHeaders();

    try {
      sonosContinuousGroupStream.addClient(response, {
        userAgent: request.header('user-agent') ?? null,
        remoteAddress: request.ip,
      });
    } catch (error) {
      logSonosError('Unable to open continuous Sonos group stream.', { error });
      response.end();
    }
  });

  app.post(
    '/api/sonos/group-stream-test/:groupId',
    json(),
    async (request, response) => {
      const groupId = request.params.groupId;
      const existing = attachedGroups.get(groupId);
      if (existing) {
        response.json({ ok: true, alreadyAttached: true, groupId, ...existing });
        return;
      }

      const streamUrl = getPublicStreamUrl(request);
      try {
        const result = await new SonosClient().attachGroupStreamPlayback(groupId, streamUrl);
        attachedGroups.set(groupId, { sessionId: result.sessionId, streamUrl });
        logSonosInfo('GROUP_PLAYBACK', 'Continuous stream attached to Sonos group.', {
          groupId,
          sessionId: result.sessionId,
          streamUrl,
        });
        response.json({ ok: true, alreadyAttached: false, result });
      } catch (error) {
        logSonosError('Continuous Sonos group stream attach failed.', {
          groupId,
          streamUrl,
          error,
        });
        if (error instanceof SonosApiError) {
          response.status(error.status).json({
            ok: false,
            message: error.message,
            details: error.details,
          });
          return;
        }
        response.status(500).json({
          ok: false,
          message: error instanceof Error
            ? error.message
            : 'Unable to attach the continuous Sonos group stream.',
        });
      }
    }
  );

  app.post('/api/sonos/group-stream-test/:groupId/tone', json(), (request, response) => {
    const groupId = request.params.groupId;
    const attachment = attachedGroups.get(groupId);
    if (!attachment) {
      response.status(409).json({
        ok: false,
        message: 'Attach the continuous stream to this Sonos group before injecting a tone.',
      });
      return;
    }

    try {
      const tone = sonosContinuousGroupStream.injectTone({
        groupId,
        sessionId: attachment.sessionId,
      });
      response.json({ ok: true, groupId, ...tone });
    } catch (error) {
      logSonosError('Continuous Sonos group stream tone injection failed.', { error });
      response.status(500).json({
        ok: false,
        message: error instanceof Error ? error.message : 'Unable to inject test tone.',
      });
    }
  });
}
