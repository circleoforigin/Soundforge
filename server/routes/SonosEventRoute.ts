import crypto from 'node:crypto';
import express, { type Express, type Request } from 'express';
import {
  logAudioClipStatus,
  type SonosAudioClipStatus,
} from '../sonos/SonosAudioClipDiagnostics.ts';
import { logSonosError } from '../sonos/SonosDiagnosticLog.ts';

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

      if (
        header(request, 'X-Sonos-Namespace') !== 'audioClip' ||
        header(request, 'X-Sonos-Type') !== 'audioClipStatus'
      ) {
        return;
      }

      const playerId = header(request, 'X-Sonos-Target-Value');
      const body = request.body as { audioClips?: unknown };
      if (!Array.isArray(body.audioClips)) {
        logSonosError('Sonos audioClipStatus event had no audioClips array.', {
          playerId,
        });
        return;
      }

      for (const clip of body.audioClips) {
        if (clip && typeof clip === 'object') {
          logAudioClipStatus(playerId, clip as SonosAudioClipStatus);
        }
      }
    }
  );
}
