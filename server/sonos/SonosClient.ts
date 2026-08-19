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
}