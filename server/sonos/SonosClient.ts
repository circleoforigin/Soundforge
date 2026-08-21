import {
  getValidSonosAccessToken,
} from './SonosTokenStore.ts';

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
      console.error(
        'Sonos getHouseholds failed:',
        data
      );

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
    console.error(
      'Sonos getGroups failed:',
      data
    );

    throw new Error(
      `Sonos request failed: ${response.status}`
    );
  }

  return data as SonosGroupsResponse;
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
      console.error(
        'Sonos playTestTone failed:',
        data
      );

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
    assetName: string
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
    };

    console.info('Sonos custom audioClip attempt:', diagnosticBase);

    try {
      const accessToken = await this.getAccessToken();
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

      console.info('Sonos custom audioClip response:', {
        ...diagnosticBase,
        timestamp: new Date().toISOString(),
        httpStatus: response.status,
        responseBody: data,
        clipId: responseObject?.id ?? responseObject?.audioClip?.id ?? null,
      });

      if (!response.ok) {
        throw new SonosApiError(response.status, data);
      }

      return data;
    } catch (error) {
      if (!(error instanceof SonosApiError)) {
        console.error('Sonos custom audioClip request error:', {
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
}
