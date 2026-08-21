import { json, type Express, type Request } from 'express';

import { SonosApiError, SonosClient } from '../sonos/SonosClient.ts';
import { sonosContinuousGroupStream } from '../sonos/SonosContinuousGroupStream.ts';
import { logSonosError, logSonosInfo } from '../sonos/SonosDiagnosticLog.ts';

function getPublicStreamUrl(request: Request, groupId: string): string {
  const configuredBaseUrl = process.env.PUBLIC_API_BASE_URL?.trim();
  const forwardedProtocol = request.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const baseUrl = (
    configuredBaseUrl || `${forwardedProtocol || request.protocol}://${request.get('host')}`
  ).replace(/\/+$/, '');
  return `${baseUrl}/api/sonos/group-stream/live.mp3?groupId=${encodeURIComponent(groupId)}`;
}

export function registerSonosGroupStreamRoute(app: Express): void {
  app.get('/api/sonos/group-stream/live.mp3', (request, response) => {
    const groupId = typeof request.query.groupId === 'string'
      ? request.query.groupId
      : '';
    if (!groupId) {
      response.status(400).json({ ok: false, message: 'A Sonos groupId is required.' });
      return;
    }

    response.status(200).set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
    });
    response.flushHeaders();

    try {
      sonosContinuousGroupStream.addClient(groupId, response, {
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
      const existing = sonosContinuousGroupStream.getAttachment(groupId);
      if (existing && sonosContinuousGroupStream.hasActiveClient(groupId)) {
        response.json({ ok: true, alreadyAttached: true, groupId, ...existing });
        return;
      }
      if (existing) {
        sonosContinuousGroupStream.invalidateAttachment(
          groupId,
          'reattachment requested without an active stream client'
        );
      }

      const streamUrl = getPublicStreamUrl(request, groupId);
      sonosContinuousGroupStream.beginAttachment(groupId);
      try {
        const result = await new SonosClient().attachGroupStreamPlayback(groupId, streamUrl);
        sonosContinuousGroupStream.markAttached(groupId, result.sessionId, streamUrl);
        logSonosInfo('GROUP_PLAYBACK', 'Continuous stream attached to Sonos group.', {
          groupId,
          sessionId: result.sessionId,
          streamUrl,
        });
        response.json({ ok: true, alreadyAttached: false, result });
      } catch (error) {
        sonosContinuousGroupStream.invalidateAttachment(
          groupId,
          'group stream attachment request failed'
        );
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
    const attachment = sonosContinuousGroupStream.getAttachment(groupId);
    if (!attachment || !sonosContinuousGroupStream.hasActiveClient(groupId)) {
      if (attachment) {
        sonosContinuousGroupStream.invalidateAttachment(
          groupId,
          'tone rejected because no active stream client is connected'
        );
      }
      logSonosInfo('GROUP_PLAYBACK', 'Continuous group stream tone rejected.', {
        groupId,
        reason: 'no active stream client is connected',
      });
      response.status(409).json({
        ok: false,
        message: 'Sonos group stream is not currently connected. Reattach the group first.',
      });
      return;
    }

    try {
      const tone = sonosContinuousGroupStream.injectTone(groupId, {
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
