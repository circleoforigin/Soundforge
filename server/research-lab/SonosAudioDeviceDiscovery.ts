import crypto from 'node:crypto';

import type {
  AudioDevice,
  AudioTopologyNode,
  AudioTransportOption,
} from '../../src/models/ResearchLab.ts';
import {
  SonosApiError,
  SonosClient,
  type SonosGroup,
  type SonosPlayer,
} from '../sonos/SonosClient.ts';
import { logSonosError, logSonosInfo } from '../sonos/SonosDiagnosticLog.ts';

export interface SonosDiscoveryClient {
  getHouseholds(): ReturnType<SonosClient['getHouseholds']>;
  getGroups(householdId: string): ReturnType<SonosClient['getGroups']>;
}

interface SonosIdentificationClient extends SonosDiscoveryClient {
  playTestTone(playerId: string): Promise<unknown>;
}

export class SonosDeviceIdentificationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'SonosDeviceIdentificationError';
  }
}

export interface ResolvedSonosAudioDevice {
  device: AudioDevice;
  physicalDeviceId: string;
  player: SonosPlayer;
  group: SonosGroup | undefined;
  householdId: string;
}

export interface SonosTopologySnapshot {
  fetchedAt: number;
  devices: readonly AudioDevice[];
  resolvedByDeviceId: ReadonlyMap<string, ResolvedSonosAudioDevice>;
  households: readonly { id: string }[];
  groupsByHousehold: ReadonlyMap<string, Awaited<ReturnType<SonosDiscoveryClient['getGroups']>>>;
}

export interface SonosTopologyDiagnostics {
  cacheHits: number;
  cacheMisses: number;
  refreshesStarted: number;
  joinedInflightRefreshes: number;
  getHouseholdsRequests: number;
  getGroupsRequests: number;
  cooldownUntil: number | null;
}

export const SONOS_TOPOLOGY_CACHE_TTL_MS = 30_000;

export class SonosTopologyCooldownError extends Error {
  readonly status = 429;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`Sonos Cloud temporarily rate limited. Retry available in ${retryAfterSeconds} seconds.`);
    this.name = 'SonosTopologyCooldownError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function opaqueId(kind: string, providerId: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`sonos:${kind}:${providerId}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `sonos-${kind}-${digest}`;
}

function findOwningGroup(groups: SonosGroup[], playerId: string): SonosGroup | undefined {
  return groups.find((group) => group.playerIds.includes(playerId));
}

function createTopology(
  householdId: string,
  group: SonosGroup | undefined,
  player: SonosPlayer,
  deviceId: string
): AudioTopologyNode[] {
  const householdNodeId = opaqueId('household', householdId);
  const playerNodeId = opaqueId('logical-player', player.id);
  const physicalNodeId = opaqueId('physical-device', deviceId);
  const groupNodeId = group ? opaqueId('group', group.id) : undefined;

  return [
    {
      id: householdNodeId,
      kind: 'household',
      name: 'Sonos household',
    },
    ...(group && groupNodeId ? [{
      id: groupNodeId,
      kind: 'group' as const,
      name: group.name,
      parentId: householdNodeId,
    }] : []),
    {
      id: playerNodeId,
      kind: 'logical-player',
      name: player.name,
      parentId: groupNodeId ?? householdNodeId,
    },
    ...player.deviceIds.map((memberId, index) => ({
      id: opaqueId('physical-device', memberId),
      kind: 'physical-device' as const,
      name: player.deviceIds.length === 1
        ? player.name
        : `${player.name} — bonded component ${index + 1}`,
      parentId: playerNodeId,
      selected: opaqueId('physical-device', memberId) === physicalNodeId,
    })),
  ];
}

function createTransports(
  player: SonosPlayer,
  group: SonosGroup | undefined
): AudioTransportOption[] {
  const supportsAudioClip = player.capabilities?.includes('AUDIO_CLIP') ?? false;
  const physicalDeviceCount = player.deviceIds.length;
  const logicalPlayerCount = group?.playerIds.length ?? 0;
  const cloudContinuousIndependent = Boolean(
    group && physicalDeviceCount === 1 && logicalPlayerCount === 1
  );

  return [
    {
      id: 'sonos-cloud-audio-clip',
      name: 'Sonos Cloud audio clip',
      operation: 'audio-clip',
      scope: 'physical-device',
      independentlyTargetable: true,
      availability: supportsAudioClip ? 'available' : 'unavailable',
      ...(!supportsAudioClip ? {
        limitation: 'Sonos discovery did not report the AUDIO_CLIP capability.',
      } : {}),
    },
    {
      id: 'sonos-cloud-continuous',
      name: 'Sonos Cloud continuous stream',
      operation: 'persistent-stream',
      scope: 'group',
      independentlyTargetable: cloudContinuousIndependent,
      availability: group ? 'available' : 'unavailable',
      limitation: group
        ? cloudContinuousIndependent
          ? 'The cloud API targets the device’s single-player Sonos group.'
          : 'The cloud API targets the owning Sonos group, not this physical component independently.'
        : 'No owning Sonos group was returned by cloud discovery.',
    },
    {
      id: 'sonos-local-continuous',
      name: 'Sonos local continuous stream',
      operation: 'persistent-stream',
      scope: 'physical-device',
      independentlyTargetable: physicalDeviceCount === 1 && logicalPlayerCount === 1,
      availability: 'experimental',
      limitation: physicalDeviceCount === 1 && logicalPlayerCount === 1
        ? 'Experimental direct-LAN AVTransport stream for a standalone physical Sonos player.'
        : 'Experimental local streaming cannot independently target this bonded/group component; SACscape will not redirect it to a coordinator.',
    },
  ];
}

function createAudioDevice(
  householdId: string,
  group: SonosGroup | undefined,
  player: SonosPlayer,
  deviceId: string,
  index: number
): AudioDevice {
  const componentRole = player.deviceIds.length === 1
    ? undefined
    : `Bonded component ${index + 1}`;
  const name = player.deviceIds.length === 1
    ? player.name
    : componentRole ?? player.name;
  const supportsAudioClip = player.capabilities?.includes('AUDIO_CLIP') ?? false;
  const model = player.modelDisplayName?.trim() || player.model?.trim();
  return {
    id: opaqueId('device', deviceId),
    provider: 'sonos',
    name,
    ...(model ? { model } : {}),
    identity: {
      providerIdentifierSuffix: deviceId.slice(-10),
      logicalPlayerName: player.name,
      ...(componentRole ? { componentRole } : {}),
    },
    capabilities: [
      ...(supportsAudioClip ? ['audio-clip' as const] : []),
      ...(group ? ['continuous-stream' as const] : []),
    ],
    diagnosticActions: [{
      id: 'identify-speaker',
      name: 'Identify Speaker',
      availability: supportsAudioClip ? 'available' : 'unavailable',
      ...(!supportsAudioClip ? {
        limitation: 'Physical-device AudioClip is not available for this device.',
      } : {}),
    }],
    topology: createTopology(householdId, group, player, deviceId),
    transports: createTransports(player, group),
  };
}

async function buildTopologySnapshot(
  client: SonosDiscoveryClient,
  onHouseholdsRequest?: () => void,
  onGroupsRequest?: () => void,
  fetchedAt = Date.now()
): Promise<SonosTopologySnapshot> {
  onHouseholdsRequest?.();
  const householdsResponse = await client.getHouseholds();
  const devices: AudioDevice[] = [];
  const resolvedByDeviceId = new Map<string, ResolvedSonosAudioDevice>();
  const groupsByHousehold = new Map<string, Awaited<ReturnType<SonosDiscoveryClient['getGroups']>>>();

  for (const household of householdsResponse.households) {
    onGroupsRequest?.();
    const topology = await client.getGroups(household.id);
    groupsByHousehold.set(household.id, topology);
    for (const player of topology.players) {
      const group = findOwningGroup(topology.groups, player.id);
      for (const [index, physicalDeviceId] of player.deviceIds.entries()) {
        const device = createAudioDevice(household.id, group, player, physicalDeviceId, index);
        devices.push(device);
        resolvedByDeviceId.set(device.id, {
          device, physicalDeviceId, player, group, householdId: household.id,
        });
      }
    }
  }
  return Object.freeze({
    fetchedAt,
    devices: Object.freeze(devices),
    resolvedByDeviceId,
    households: Object.freeze([...householdsResponse.households]),
    groupsByHousehold,
  });
}

function cooldownDeadline(error: unknown, now: number): number | null {
  if (!(error instanceof SonosApiError) || error.status !== 429) {
    return null;
  }
  const retryAfter = error.rateLimit?.retryAfter?.trim();
  if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)) {
    return now + Math.max(1, Number(retryAfter)) * 1_000;
  }
  if (retryAfter) {
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date) && date > now) return date;
  }
  const reset = Number(error.rateLimit?.reset);
  if (Number.isFinite(reset) && reset > 0) {
    return reset > now / 1_000 ? reset * 1_000 : now + reset * 1_000;
  }
  return now + 60_000;
}

export class SonosTopologyService {
  private readonly client: SonosDiscoveryClient;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private snapshot: SonosTopologySnapshot | null = null;
  private refreshPromise: Promise<SonosTopologySnapshot> | null = null;
  private cooldownUntil: number | null = null;
  private readonly counters: Omit<SonosTopologyDiagnostics, 'cooldownUntil'> = {
    cacheHits: 0, cacheMisses: 0, refreshesStarted: 0,
    joinedInflightRefreshes: 0, getHouseholdsRequests: 0, getGroupsRequests: 0,
  };

  constructor(
    client: SonosDiscoveryClient = new SonosClient(),
    ttlMs = SONOS_TOPOLOGY_CACHE_TTL_MS,
    now: () => number = Date.now
  ) {
    this.client = client;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  async getSnapshot(options: { forceRefresh?: boolean } = {}): Promise<SonosTopologySnapshot> {
    const now = this.now();
    if (this.cooldownUntil && now < this.cooldownUntil) {
      const seconds = Math.max(1, Math.ceil((this.cooldownUntil - now) / 1_000));
      logSonosInfo('TOPOLOGY', 'Sonos topology refresh blocked by provider cooldown.', {
        retryAfterSeconds: seconds,
      });
      throw new SonosTopologyCooldownError(seconds);
    }
    if (!options.forceRefresh && this.snapshot && now - this.snapshot.fetchedAt < this.ttlMs) {
      this.counters.cacheHits += 1;
      logSonosInfo('TOPOLOGY', 'Sonos topology cache hit.', this.getDiagnostics());
      return this.snapshot;
    }
    if (this.refreshPromise) {
      this.counters.joinedInflightRefreshes += 1;
      logSonosInfo('TOPOLOGY', 'Joined in-flight Sonos topology refresh.', this.getDiagnostics());
      return this.refreshPromise;
    }
    this.counters.cacheMisses += 1;
    this.counters.refreshesStarted += 1;
    logSonosInfo('TOPOLOGY', 'Sonos topology refresh started.', {
      forceRefresh: Boolean(options.forceRefresh),
      diagnostics: this.getDiagnostics(),
    });
    const refresh = buildTopologySnapshot(
      this.client,
      () => { this.counters.getHouseholdsRequests += 1; },
      () => { this.counters.getGroupsRequests += 1; },
      now
    ).then((snapshot) => {
      this.snapshot = snapshot;
      this.cooldownUntil = null;
      return snapshot;
    }).catch((error) => {
      const deadline = cooldownDeadline(error, this.now());
      if (deadline) this.cooldownUntil = deadline;
      throw error;
    }).finally(() => {
      if (this.refreshPromise === refresh) this.refreshPromise = null;
    });
    this.refreshPromise = refresh;
    return refresh;
  }

  getDiagnostics(): SonosTopologyDiagnostics {
    return { ...this.counters, cooldownUntil: this.cooldownUntil };
  }
}

export const sonosTopologyService = new SonosTopologyService();

export async function discoverSonosAudioDevices(
  client: SonosDiscoveryClient = new SonosClient()
): Promise<AudioDevice[]> {
  return [...(await buildTopologySnapshot(client)).devices];
}

export async function getSonosAudioDevices(
  options: { forceRefresh?: boolean } = {}
): Promise<AudioDevice[]> {
  return [...(await sonosTopologyService.getSnapshot(options)).devices];
}


export async function resolveSonosAudioDevice(
  genericDeviceId: string,
  client?: SonosDiscoveryClient
): Promise<ResolvedSonosAudioDevice | undefined> {
  const snapshot = client
    ? await buildTopologySnapshot(client)
    : await sonosTopologyService.getSnapshot();
  return snapshot.resolvedByDeviceId.get(genericDeviceId);
}

export async function identifySonosAudioDevice(
  genericDeviceId: string,
  client?: SonosIdentificationClient
): Promise<void> {
  const actionClient = client ?? new SonosClient();
  const attempt = {
    timestamp: new Date().toISOString(),
    genericDeviceId,
    provider: 'sonos',
  };
  logSonosInfo('AUDIO_CLIP', 'Research Lab Identify Speaker attempt.', attempt);

  try {
    const resolved = await resolveSonosAudioDevice(genericDeviceId, client);
    if (!resolved) {
      throw new SonosDeviceIdentificationError(
        404,
        'DEVICE_NOT_RESOLVED',
        'Physical device could not be resolved from current Sonos topology.'
      );
    }
    const supportsAudioClip =
      resolved.player.capabilities?.includes('AUDIO_CLIP') ?? false;
    logSonosInfo('AUDIO_CLIP', 'Research Lab physical device resolved.', {
      ...attempt,
      resolvedAt: new Date().toISOString(),
      physicalDeviceId: resolved.physicalDeviceId,
      physicalDeviceIdSuffix: resolved.physicalDeviceId.slice(-10),
      logicalPlayerId: resolved.player.id,
      audioClipCapabilityPresent: supportsAudioClip,
    });
    if (!supportsAudioClip) {
      throw new SonosDeviceIdentificationError(
        409,
        'AUDIO_CLIP_UNSUPPORTED',
        'AudioClip is not supported by this physical device.'
      );
    }

    await actionClient.playTestTone(resolved.physicalDeviceId);
    logSonosInfo('AUDIO_CLIP', 'Research Lab Identify Speaker succeeded.', {
      ...attempt,
      succeededAt: new Date().toISOString(),
      physicalDeviceIdSuffix: resolved.physicalDeviceId.slice(-10),
    });
  } catch (error) {
    logSonosError('Research Lab Identify Speaker failed.', {
      ...attempt,
      failedAt: new Date().toISOString(),
      status: error instanceof SonosDeviceIdentificationError ? error.status : null,
      code: error instanceof SonosDeviceIdentificationError ? error.code : null,
      reason: error instanceof Error ? error.message : error,
    });
    throw error;
  }
}
