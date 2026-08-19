import type { Express } from 'express';

import {
  SonosApiError,
  SonosClient,
} from '../sonos/SonosClient.ts';

export function registerSonosDiscoveryRoute(
  app: Express
) {
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
        console.error(error);

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
        console.error(error);

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
        console.error(error);

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
