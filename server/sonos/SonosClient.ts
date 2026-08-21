import {
  getSonosTokens,
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
  devices: SonosDevice[];
}

export interface SonosDevice {
  id: string;
  name?: string;
  model?: string;
  modelDisplayName?: string;
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
  private getAccessToken(): string {
    const tokens = getSonosTokens();

    if (!tokens) {
      throw new Error(
        'SACscape is not connected to Sonos.'
      );
    }

    if (Date.now() >= tokens.expiresAt) {
      throw new Error(
        'Sonos access token has expired.'
      );
    }

    return tokens.accessToken;
  }

  async getHouseholds():
    Promise<SonosHouseholdsResponse> {
    const accessToken =
      this.getAccessToken();

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
    this.getAccessToken();

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
      this.getAccessToken();

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
    name: string
  ): Promise<unknown> {
    const accessToken = this.getAccessToken();
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
          volume: Math.max(1, Math.min(100, Math.round(volume))),
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

    if (!response.ok) {
      console.error('Sonos playAudioClip failed:', data);
      throw new SonosApiError(response.status, data);
    }

    return data;
  }
}
