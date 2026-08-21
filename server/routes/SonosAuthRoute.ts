import type { Express } from 'express';
import crypto from 'node:crypto';
import { setSonosTokens } from '../sonos/SonosTokenStore.ts';
import { logSonosError } from '../sonos/SonosDiagnosticLog.ts';

export function registerSonosAuthRoute(
  app: Express
) {
  app.get(
    '/api/sonos/login',
    (_request, response) => {
      const clientId =
        process.env.SONOS_CLIENT_ID;

      const redirectUri =
        process.env.SONOS_REDIRECT_URI;

      if (!clientId || !redirectUri) {
        response.status(500).json({
          ok: false,
          message:
            'Sonos configuration is missing.',
        });

        return;
      }

      const state =
        crypto.randomBytes(24).toString('hex');

      const params =
        new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          state,
          scope: 'playback-control-all',
          redirect_uri: redirectUri,
        });

      response.redirect(
        `https://api.sonos.com/login/v3/oauth?${params.toString()}`
      );
    }
  );

  app.get(
  '/api/sonos/callback',
  async (request, response) => {
    const code = request.query.code;

    if (typeof code !== 'string') {
      response.status(400).send(
        'Sonos authorization code is missing.'
      );

      return;
    }

    const clientId =
      process.env.SONOS_CLIENT_ID;

    const clientSecret =
      process.env.SONOS_CLIENT_SECRET;

    const redirectUri =
      process.env.SONOS_REDIRECT_URI;

    if (
      !clientId ||
      !clientSecret ||
      !redirectUri
    ) {
      response.status(500).send(
        'Sonos configuration is missing.'
      );

      return;
    }

    try {
      const credentials =
        Buffer.from(
          `${clientId}:${clientSecret}`
        ).toString('base64');

      const body =
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        });

      const tokenResponse =
        await fetch(
          'https://api.sonos.com/login/v3/oauth/access',
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/x-www-form-urlencoded;charset=utf-8',

              Authorization:
                `Basic ${credentials}`,
            },

            body,
          }
        );

      const tokenData =
        await tokenResponse.json();

      if (!tokenResponse.ok) {
        logSonosError('Sonos token exchange failed.', tokenData);

        response.status(500).send(
          'Sonos authorization failed.'
        );

        return;
      }

      const tokenResult =
  tokenData as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

if (
  !tokenResult.access_token ||
  !tokenResult.refresh_token ||
  typeof tokenResult.expires_in !== 'number'
) {
  response.status(500).send(
    'Sonos returned incomplete token data.'
  );

  return;
}

await setSonosTokens({
  accessToken: tokenResult.access_token,
  refreshToken: tokenResult.refresh_token,

  expiresAt:
    Date.now() +
    tokenResult.expires_in * 1000,
});

      response.send(
        'SACscape successfully connected to Sonos.'
      );
    } catch (error) {
      logSonosError('Sonos OAuth callback failed.', error);

      response.status(500).send(
        'Unable to connect SACscape to Sonos.'
      );
    }
  }
);
}
