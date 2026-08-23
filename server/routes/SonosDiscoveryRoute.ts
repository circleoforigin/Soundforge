import { json, type Express } from 'express';

import {
  SonosApiError,
  SonosClient,
} from '../sonos/SonosClient.ts';
import { logSonosError } from '../sonos/SonosDiagnosticLog.ts';

export function registerSonosTopologyRoutes(app: Express): void {
  app.get(
    '/api/sonos/households',
    async (_request, response) => {
      try {
        const client =
          new SonosClient();

        const households =
          await client.getHouseholds();

        response.json({
          ok: true,
          ...households,
        });
      } catch (error) {
        logSonosError('Sonos test-tone route failed.', error);

        response.status(500).json({
          ok: false,

          message:
            error instanceof Error
              ? error.message
              : 'Unable to discover Sonos households.',
        });
      }
    }
  );

  app.get(
    '/api/sonos/households/:householdId/groups',
    async (request, response) => {
      try {
        const client =
          new SonosClient();

        const groups =
          await client.getGroups(
            request.params.householdId
          );

        response.json({
          ok: true,
          ...groups,
        });
      } catch (error) {
        logSonosError('Sonos custom audioClip route failed.', error);

        response.status(500).json({
          ok: false,

          message:
            error instanceof Error
              ? error.message
              : 'Unable to discover Sonos players.',
        });
      }
    }
  );

}

export function registerSonosTestToneRoute(app: Express): void {
  app.post(
    '/api/sonos/test-tone/:playerId',
    async (request, response) => {
      try {
        const client =
          new SonosClient();

        const sonosResponse =
          await client.playTestTone(
            request.params.playerId
          );

        response.json(sonosResponse);
      } catch (error) {
        logSonosError('Sonos household discovery route failed.', error);

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
          message:
            error instanceof Error
              ? error.message
              : 'Unable to play Sonos test tone.',
        });
      }
    }
  );

}

export function registerLegacySonosAudioClipRoutes(app: Express): void {
  app.post(
    '/api/sonos/resolve-logical-player',
    json(),
    async (request, response) => {
      try {
        const { deviceIds } = request.body as { deviceIds?: unknown };
        if (
          !Array.isArray(deviceIds) ||
          !deviceIds.every((deviceId) => typeof deviceId === 'string')
        ) {
          response.status(400).json({
            ok: false,
            message: 'An array of Sonos physical device IDs is required.',
          });
          return;
        }

        const client = new SonosClient();
        const resolution = await client.resolveLogicalPlayerForDevices(deviceIds);
        response.json({ ok: true, ...resolution });
      } catch (error) {
        logSonosError('Sonos logical-player resolution failed.', error);
        response.status(409).json({
          ok: false,
          message: error instanceof Error
            ? error.message
            : 'Unable to resolve the logical Sonos player.',
        });
      }
    }
  );

  app.post(
    '/api/sonos/audio-clip/:playerId',
    json(),
    async (request, response) => {
      try {
        const { streamUrl, volume, name, assetId, assetName, routingKind } = request.body as {
          streamUrl?: string;
          volume?: number;
          name?: string;
          assetId?: string;
          assetName?: string;
          routingKind?: string;
        };

        if (
          !streamUrl ||
          !URL.canParse(streamUrl) ||
          !streamUrl.startsWith('https://')
        ) {
          logSonosError('Sonos custom audioClip rejected invalid stream URL.', {
            playerId: request.params.playerId,
            assetId: assetId?.trim() || 'unknown',
          });
          response.status(400).json({
            ok: false,
            message: 'A public HTTPS streamUrl is required.',
          });
          return;
        }

        if (!Number.isFinite(volume) || Number(volume) <= 0) {
          logSonosError('Sonos custom audioClip rejected invalid volume.', {
            playerId: request.params.playerId,
            assetId: assetId?.trim() || 'unknown',
            volume,
          });
          response.status(400).json({
            ok: false,
            message: 'A positive clip volume is required.',
          });
          return;
        }

        const client = new SonosClient();
        const sonosResponse = await client.playAudioClip(
          request.params.playerId,
          streamUrl,
          Number(volume),
          name?.trim() || 'SACscape One Shot',
          assetId?.trim() || 'unknown',
          assetName?.trim() || name?.trim() || 'Unknown asset',
          routingKind === 'logical-player center' ||
            routingKind === 'physical-device directional'
            ? routingKind
            : undefined
        );

        response.json({ ok: true, sonosResponse });
      } catch (error) {
        logSonosError('Sonos group discovery route failed.', error);

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
            : 'Unable to play Sonos audio clip.',
        });
      }
    }
  );
}

export function registerSonosDiscoveryRoute(app: Express): void {
  registerSonosTopologyRoutes(app);
  registerSonosTestToneRoute(app);
  registerLegacySonosAudioClipRoutes(app);
}
