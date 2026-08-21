import crypto from 'node:crypto';
import express, { type Express, type Request } from 'express';
import {
  logAudioClipStatus,
  type SonosAudioClipStatus,
} from '../sonos/SonosAudioClipDiagnostics.ts';
import { logSonosError, logSonosInfo } from '../sonos/SonosDiagnosticLog.ts';
import { sonosContinuousGroupStream } from '../sonos/SonosContinuousGroupStream.ts';

function header(request: Request, name: string): string {
  const value = request.header(name);
  return value ?? '';
}

function hasValidSignature(request: Request): boolean {
  const clientId = process.env.SONOS_CLIENT_ID;
  const clientSecret = process.env.SONOS_CLIENT_SECRET;
  const suppliedSignature = header(request, 'X-Sonos-Event-Signature');

  if (!clientId || !clientSecret || !suppliedSignature) {
    return false;
  }

  const digest = crypto.createHash('sha256');
  for (const value of [
    header(request, 'X-Sonos-Event-Seq-Id'),
    header(request, 'X-Sonos-Namespace'),
    header(request, 'X-Sonos-Type'),
    header(request, 'X-Sonos-Target-Type'),
    header(request, 'X-Sonos-Target-Value'),
    clientId,
    clientSecret,
  ]) {
    digest.update(value, 'utf8');
  }

  const expectedSignature = digest.digest('base64url');
  const expected = Buffer.from(expectedSignature);
  const supplied = Buffer.from(suppliedSignature);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

export function registerSonosEventRoute(app: Express): void {
  app.post(
    /^\/api\/sonos\/events(?:\/.*)?$/,
    express.json(),
    (request, response) => {
      if (!hasValidSignature(request)) {
        logSonosError('Rejected Sonos event with an invalid signature.', {
          namespace: header(request, 'X-Sonos-Namespace'),
          type: header(request, 'X-Sonos-Type'),
          playerId: header(request, 'X-Sonos-Target-Value'),
        });
        response.sendStatus(401);
        return;
      }

      response.sendStatus(200);

      const namespace = header(request, 'X-Sonos-Namespace');
      const type = header(request, 'X-Sonos-Type');
      const targetType = header(request, 'X-Sonos-Target-Type');
      const targetValue = header(request, 'X-Sonos-Target-Value');

      if (namespace === 'playback' || namespace === 'playbackSession') {
        logSonosInfo('GROUP_PLAYBACK', 'Sonos group playback event.', {
          namespace,
          type,
          targetType,
          groupId: targetType === 'groupId' ? targetValue : null,
          sessionId: targetType === 'sessionId' ? targetValue : null,
          targetValue,
          eventSequenceId: header(request, 'X-Sonos-Event-Seq-Id'),
          body: request.body,
        });
        const eventBody = request.body as { playbackState?: unknown };
        if (namespace === 'playback' && type === 'playbackError') {
          sonosContinuousGroupStream.invalidateGroupStream(
            targetValue,
            'Sonos playbackError event'
          );
        } else if (
          namespace === 'playback' &&
          type === 'playbackStatus' &&
          typeof eventBody.playbackState === 'string'
        ) {
          sonosContinuousGroupStream.handlePlaybackState(
            targetValue,
            eventBody.playbackState
          );
        } else if (namespace === 'playbackSession' && /error/i.test(type)) {
          sonosContinuousGroupStream.invalidateAttachmentBySessionId(
            targetValue,
            `Sonos playback-session ${type} event`
          );
        }
        return;
      }

      if (
        namespace !== 'audioClip' ||
        type !== 'audioClipStatus'
      ) {
        return;
      }

      const playerId = header(request, 'X-Sonos-Target-Value');
      const body = request.body as {
        audioClips?: unknown;
        errorCode?: unknown;
        error?: { errorCode?: unknown };
      };
      logSonosInfo('AUDIO_CLIP', 'Raw Sonos audioClipStatus event.', {
        playerId,
        eventSequenceId: header(request, 'X-Sonos-Event-Seq-Id'),
        body,
      });
      if (!Array.isArray(body.audioClips)) {
        logSonosError('Sonos audioClipStatus event had no audioClips array.', {
          playerId,
        });
        return;
      }

      for (const clip of body.audioClips) {
        if (clip && typeof clip === 'object') {
          logAudioClipStatus(
            playerId,
            clip as SonosAudioClipStatus,
            body.errorCode ?? body.error?.errorCode
          );
        }
      }
    }
  );
}
