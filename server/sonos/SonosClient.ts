import crypto from 'node:crypto';
import {
  getValidSonosAccessToken,
} from './SonosTokenStore.ts';
import { logSonosError, logSonosInfo } from './SonosDiagnosticLog.ts';
import { rememberAudioClip } from './SonosAudioClipDiagnostics.ts';

const SONOS_API_BASE =
  'https://api.ws.sonos.com/control/api/v1';
export const SONOS_TOPOLOGY_REQUEST_TIMEOUT_MS = 7_500;

export interface SonosRateLimitMetadata {
  limit: string | null;
  remaining: string | null;
  reset: string | null;
  retryAfter: string | null;
}

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
  capabilities?: string[];
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

export interface SonosLogicalPlayerResolution {
  playerId: string;
  playerName: string;
}

export interface SonosGroupStreamTestResult {
  groupId: string;
  sessionId: string;
  streamUrl: string;
  playbackSubscription: unknown;
  sessionResponse: unknown;
  sessionSubscription: unknown;
  loadStreamResponse: unknown;
}

export class SonosApiError extends Error {
  status: number;
  details: unknown;
  rateLimit: SonosRateLimitMetadata | null;

  constructor(
    status: number,
    details: unknown,
    rateLimit: SonosRateLimitMetadata | null = null
  ) {
    const retrySeconds = rateLimit?.retryAfter;
    super(status === 429
      ? `Sonos Cloud rate limit reached.${retrySeconds ? ` Retry after ${retrySeconds} seconds.` : ''}`
      : `Sonos request failed: ${status}`);
    this.name = 'SonosApiError';
    this.status = status;
    this.details = details;
    this.rateLimit = rateLimit;
  }
}

export class SonosTopologyTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Sonos Cloud ${operation} request timed out after ${timeoutMs} ms.`);
    this.name = 'SonosTopologyTimeoutError';
  }
}

export function getSonosErrorCode(details: unknown): string | null {
  if (!details || typeof details !== 'object') {
    return null;
  }
  const value = details as {
    errorCode?: unknown;
    code?: unknown;
    error?: { code?: unknown };
  };
  const code = value.errorCode ?? value.code ?? value.error?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : null;
}

export class SonosClient {
  private readonly topologyFetch: typeof fetch;
  private readonly topologyTimeoutMs: number;
  private readonly accessTokenProvider: () => Promise<string>;

  constructor(options: {
    fetch?: typeof fetch;
    topologyTimeoutMs?: number;
    accessTokenProvider?: () => Promise<string>;
  } = {}) {
    this.topologyFetch = options.fetch ?? fetch;
    this.topologyTimeoutMs = options.topologyTimeoutMs ?? SONOS_TOPOLOGY_REQUEST_TIMEOUT_MS;
    this.accessTokenProvider = options.accessTokenProvider ?? getValidSonosAccessToken;
  }

  private async getAccessToken(): Promise<string> {
    return this.accessTokenProvider();
  }

  private async topologyRequest<T>(url: string, operation: string): Promise<T> {
    const accessToken = await this.getAccessToken();
    let response: Response;
    try {
      response = await this.topologyFetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(this.topologyTimeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        const timeout = new SonosTopologyTimeoutError(operation, this.topologyTimeoutMs);
        logSonosError(`Sonos ${operation} timed out.`, { timeoutMs: this.topologyTimeoutMs });
        throw timeout;
      }
      throw new Error(
        `Sonos Cloud ${operation} request failed before receiving a response: ` +
        `${error instanceof Error ? error.message : 'network error'}.`,
        { cause: error }
      );
    }
    const responseText = await response.text();
    let data: unknown = null;
    if (responseText) {
      try { data = JSON.parse(responseText); } catch { data = responseText; }
    }
    const rateLimit: SonosRateLimitMetadata = {
      limit: response.headers.get('RateLimit-Limit'),
      remaining: response.headers.get('RateLimit-Remaining'),
      reset: response.headers.get('RateLimit-Reset'),
      retryAfter: response.headers.get('Retry-After'),
    };
    logSonosInfo('TOPOLOGY', `Sonos ${operation} response.`, {
      httpStatus: response.status,
      rateLimit,
    });
    if (!response.ok) {
      logSonosError(`Sonos ${operation} failed.`, {
        httpStatus: response.status,
        rateLimit,
        responseBody: data,
      });
      throw new SonosApiError(response.status, data, rateLimit);
    }
    return data as T;
  }

  async getHouseholds():
    Promise<SonosHouseholdsResponse> {
    return this.topologyRequest<SonosHouseholdsResponse>(
      `${SONOS_API_BASE}/households`,
      'getHouseholds'
    );
  }

  async getGroups(
  householdId: string
): Promise<SonosGroupsResponse> {
  return this.topologyRequest<SonosGroupsResponse>(
      `${SONOS_API_BASE}/households/${encodeURIComponent(
        householdId
      )}/groups`,
      'getGroups'
    );
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
    const diagnosticBase = {
      timestamp: new Date().toISOString(),
      playerId,
      playerIdSuffix: playerId.slice(-10),
      clipType: 'CHIME',
      volume: 20,
    };
    logSonosInfo('AUDIO_CLIP', 'Sonos identification CHIME attempt.', diagnosticBase);

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
            name: 'SACscape test tone',
            appId: 'com.circleoforigin.sacscape',
            priority: 'LOW',
            clipType: 'CHIME',
            volume: 20,
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

      logSonosInfo('AUDIO_CLIP', 'Sonos identification CHIME response.', {
        ...diagnosticBase,
        completedAt: new Date().toISOString(),
        httpStatus: response.status,
        errorCode: getSonosErrorCode(data),
        responseBody: data,
      });
      if (!response.ok) {
        throw new SonosApiError(response.status, data);
      }
      return data;
    } catch (error) {
      logSonosError('Sonos identification CHIME failed.', {
        ...diagnosticBase,
        failedAt: new Date().toISOString(),
        httpStatus: error instanceof SonosApiError ? error.status : null,
        errorCode: error instanceof SonosApiError ? getSonosErrorCode(error.details) : null,
        reason: error instanceof Error ? error.message : error,
      });
      throw error;
    }
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

  /** Temporary group-stream experiment; deliberately never falls back to audioClip. */
  async attachGroupStreamPlayback(
    groupId: string,
    streamUrl: string,
    appContext = `group-stream-test-${crypto.randomUUID()}`
  ): Promise<SonosGroupStreamTestResult> {
    const accessToken = await this.getAccessToken();
    const diagnosticBase = { groupId, streamUrl };

    logSonosInfo(
      'GROUP_PLAYBACK',
      'Starting Sonos group stream playback.',
      diagnosticBase
    );

    const playbackSubscription = await this.groupPlaybackRequest(
      `/groups/${encodeURIComponent(groupId)}/playback/subscription`,
      accessToken,
      undefined,
      'Group playback subscription',
      diagnosticBase
    );

    const sessionResponse = await this.groupPlaybackRequest(
      `/groups/${encodeURIComponent(groupId)}/playbackSession`,
      accessToken,
      {
        appId: 'com.circleoforigin.sacscape',
        appContext,
      },
      'Group playback session creation',
      diagnosticBase
    );
    const sessionObject = sessionResponse.data && typeof sessionResponse.data === 'object'
      ? sessionResponse.data as {
        sessionId?: unknown;
        sessionStatus?: { sessionId?: unknown };
      }
      : null;
    const sessionId = sessionObject?.sessionId ?? sessionObject?.sessionStatus?.sessionId;

    if (typeof sessionId !== 'string' || !sessionId) {
      logSonosError('Sonos group playback session response had no session ID.', {
        ...diagnosticBase,
        responseBody: sessionResponse.data,
      });
      throw new Error('Sonos did not return a playback session ID.');
    }

    const sessionDiagnostic = { ...diagnosticBase, sessionId };
    const sessionSubscription = await this.groupPlaybackRequest(
      `/playbackSessions/${encodeURIComponent(sessionId)}/playbackSession/subscription`,
      accessToken,
      undefined,
      'Playback-session subscription',
      sessionDiagnostic
    );
    const loadStreamResponse = await this.groupPlaybackRequest(
      `/playbackSessions/${encodeURIComponent(sessionId)}/playbackSession/loadStreamUrl`,
      accessToken,
      { streamUrl, playOnCompletion: true },
      'Group loadStreamUrl',
      sessionDiagnostic
    );

    return {
      groupId,
      sessionId,
      streamUrl,
      playbackSubscription: playbackSubscription.data,
      sessionResponse: sessionResponse.data,
      sessionSubscription: sessionSubscription.data,
      loadStreamResponse: loadStreamResponse.data,
    };
  }

  async pauseGroupPlayback(groupId: string): Promise<unknown> {
    const accessToken = await this.getAccessToken();
    const result = await this.groupPlaybackRequest(
      `/groups/${encodeURIComponent(groupId)}/playback/pause`,
      accessToken,
      undefined,
      'Group playback pause',
      { groupId }
    );
    return result.data;
  }

  private async groupPlaybackRequest(
    path: string,
    accessToken: string,
    body: unknown | undefined,
    operation: string,
    diagnostics: Record<string, unknown>
  ): Promise<{ status: number; data: unknown }> {
    try {
      const response = await fetch(`${SONOS_API_BASE}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const responseText = await response.text();
      let data: unknown = null;

      if (responseText) {
        try {
          data = JSON.parse(responseText);
        } catch {
          data = responseText;
        }
      }

      logSonosInfo('GROUP_PLAYBACK', `${operation} response.`, {
        ...diagnostics,
        httpStatus: response.status,
        responseBody: data,
      });

      if (!response.ok) {
        throw new SonosApiError(response.status, data);
      }

      return { status: response.status, data };
    } catch (error) {
      if (!(error instanceof SonosApiError)) {
        logSonosError(`${operation} request failed.`, {
          ...diagnostics,
          error,
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
