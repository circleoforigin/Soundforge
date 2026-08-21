import {
  getValidSonosAccessToken,
} from './SonosTokenStore.ts';
import { logSonosError, logSonosInfo } from './SonosDiagnosticLog.ts';
import { rememberAudioClip } from './SonosAudioClipDiagnostics.ts';

const SONOS_API_BASE =
  'https://api.ws.sonos.com/control/api/v1';

export interface SonosHousehold {
  id: string;
}

export interface SonosHouseholdsResponse {
  households: SonosHousehold[];
}
export interface SonosPlayer {
  id: string;
  name: string;
  deviceIds: string[];
}

export interface SonosGroup {
  id: string;
  name: string;
  playerIds: string[];
}

export interface SonosGroupsResponse {
  groups: SonosGroup[];
  players: SonosPlayer[];
}

export interface SonosLogicalPlayerResolution {
  playerId: string;
  playerName: string;
}

export class SonosApiError extends Error {
  status: number;
  details: unknown;

  constructor(
    status: number,
    details: unknown
  ) {
    super(`Sonos request failed: ${status}`);
    this.name = 'SonosApiError';
    this.status = status;
    this.details = details;
  }
}

export class SonosClient {
  private async getAccessToken(): Promise<string> {
    return getValidSonosAccessToken();
  }

  async getHouseholds():
    Promise<SonosHouseholdsResponse> {
    const accessToken =
      await this.getAccessToken();

    const response =
      await fetch(
        `${SONOS_API_BASE}/households`,
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            'Content-Type':
              'application/json',
          },
        }
      );

    const data = await response.json();

    if (!response.ok) {
      logSonosError('Sonos getHouseholds failed.', data);

      throw new Error(
        `Sonos request failed: ${response.status}`
      );
    }

    return data as SonosHouseholdsResponse;
  }

  async getGroups(
  householdId: string
): Promise<SonosGroupsResponse> {
  const accessToken =
    await this.getAccessToken();

  const response =
    await fetch(
      `${SONOS_API_BASE}/households/${encodeURIComponent(
        householdId
      )}/groups`,
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          'Content-Type':
            'application/json',
        },
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    logSonosError('Sonos getGroups failed.', data);

    throw new Error(
      `Sonos request failed: ${response.status}`
    );
  }

  return data as SonosGroupsResponse;
}

  async resolveLogicalPlayerForDevices(
    deviceIds: string[]
  ): Promise<SonosLogicalPlayerResolution> {
    const requestedDeviceIds = [...new Set(deviceIds.filter(Boolean))];
    if (requestedDeviceIds.length === 0) {
      throw new Error('No Sonos physical device IDs were provided.');
    }

    const households = await this.getHouseholds();
    const owningPlayers = new Map<string, SonosPlayer>();

    for (const household of households.households) {
      const groups = await this.getGroups(household.id);
      for (const deviceId of requestedDeviceIds) {
        const player = groups.players.find((candidate) =>
          candidate.deviceIds?.includes(deviceId)
        );
        if (player) {
          owningPlayers.set(deviceId, player);
        }
      }
    }

    const unresolvedDeviceIds = requestedDeviceIds.filter(
      (deviceId) => !owningPlayers.has(deviceId)
    );
    if (unresolvedDeviceIds.length > 0) {
      throw new Error(
        `Unable to resolve the logical Sonos player for: ${unresolvedDeviceIds.join(', ')}.`
      );
    }

    const playerIds = new Set(
      [...owningPlayers.values()].map((player) => player.id)
    );
    if (playerIds.size !== 1) {
      throw new Error(
        'Center-circle Sonos speakers span multiple logical players. ' +
        'Balanced Field cannot synchronize across multiple logical players yet.'
      );
    }

    const player = owningPlayers.get(requestedDeviceIds[0]);
    if (!player) {
      throw new Error('Unable to determine the owning logical Sonos player.');
    }

    return { playerId: player.id, playerName: player.name };
  }

  async playTestTone(
    playerId: string
  ): Promise<unknown> {
    const accessToken =
      await this.getAccessToken();

    const response = await fetch(
      `${SONOS_API_BASE}/players/${encodeURIComponent(
        playerId
      )}/audioClip`,
      {
        method: 'POST',
        headers: {
          Authorization:
            `Bearer ${accessToken}`,
          'Content-Type':
            'application/json',
        },
        body: JSON.stringify({
          name: 'SACscape test tone',
          appId: 'com.circleoforigin.sacscape',
          priority: 'LOW',
          clipType: 'CHIME',
          volume: 20,
        }),
      }
    );

    const responseText =
      await response.text();

    let data: unknown = null;

    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch {
        data = responseText;
      }
    }

    if (!response.ok) {
      logSonosError('Sonos playTestTone failed.', data);

      throw new SonosApiError(
        response.status,
        data
      );
    }

    return data;
  }

  async playAudioClip(
    playerId: string,
    streamUrl: string,
    volume: number,
    name: string,
    assetId: string,
    assetName: string,
    routingKind?: 'logical-player center' | 'physical-device directional'
  ): Promise<unknown> {
    const calculatedVolume = Math.max(1, Math.min(100, Math.round(volume)));
    const diagnosticBase = {
      timestamp: new Date().toISOString(),
      playerId,
      assetId,
      assetName,
      clipName: name,
      volume: calculatedVolume,
      streamUrl,
      routingKind: routingKind ?? null,
    };

    logSonosInfo('AUDIO_CLIP', 'Sonos custom audioClip attempt.', diagnosticBase);

    try {
      const accessToken = await this.getAccessToken();
      await this.subscribeToAudioClipStatus(playerId, accessToken);
      const response = await fetch(
        `${SONOS_API_BASE}/players/${encodeURIComponent(playerId)}/audioClip`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name,
            appId: 'com.circleoforigin.sacscape',
            priority: 'LOW',
            clipType: 'CUSTOM',
            streamUrl,
            volume: calculatedVolume,
          }),
        }
      );
      const responseText = await response.text();
      let data: unknown = null;

      if (responseText) {
        try {
          data = JSON.parse(responseText);
        } catch {
          data = responseText;
        }
      }

      const responseObject = data && typeof data === 'object'
        ? data as { id?: unknown; audioClip?: { id?: unknown } }
        : null;

      logSonosInfo('AUDIO_CLIP', 'Sonos custom audioClip response.', {
        ...diagnosticBase,
        timestamp: new Date().toISOString(),
        httpStatus: response.status,
        responseBody: data,
        clipId: responseObject?.id ?? responseObject?.audioClip?.id ?? null,
      });

      if (!response.ok) {
        throw new SonosApiError(response.status, data);
      }

      const clipId = responseObject?.id ?? responseObject?.audioClip?.id;
      if (typeof clipId === 'string') {
        rememberAudioClip(playerId, clipId, assetId, assetName);
      }

      return data;
    } catch (error) {
      if (!(error instanceof SonosApiError)) {
        logSonosError('Sonos custom audioClip request error.', {
          ...diagnosticBase,
          timestamp: new Date().toISOString(),
          httpStatus: null,
          responseBody: error instanceof Error ? error.message : error,
          clipId: null,
        });
      }

      throw error;
    }
  }

  private async subscribeToAudioClipStatus(
    playerId: string,
    accessToken: string
  ): Promise<void> {
    try {
      const response = await fetch(
        `${SONOS_API_BASE}/players/${encodeURIComponent(playerId)}/audioClip/subscription`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
      const responseText = await response.text();

      logSonosInfo('AUDIO_CLIP', 'Sonos audioClip subscription response.', {
        playerId,
        httpStatus: response.status,
        responseBody: responseText || null,
      });

      if (!response.ok) {
        logSonosError('Sonos audioClip subscription failed; continuing playback.', {
          playerId,
          httpStatus: response.status,
          responseBody: responseText || null,
        });
      }
    } catch (error) {
      logSonosError('Sonos audioClip subscription failed; continuing playback.', {
        playerId,
        error,
      });
    }
  }
}
