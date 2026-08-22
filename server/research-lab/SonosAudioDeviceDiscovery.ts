import crypto from 'node:crypto';

import type {
  AudioDevice,
  AudioTopologyNode,
  AudioTransportOption,
} from '../../src/models/ResearchLab.ts';
import {
  SonosClient,
  type SonosGroup,
  type SonosPlayer,
} from '../sonos/SonosClient.ts';
import { logSonosError, logSonosInfo } from '../sonos/SonosDiagnosticLog.ts';

interface SonosDiscoveryClient {
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

export async function discoverSonosAudioDevices(
  client: SonosDiscoveryClient = new SonosClient()
): Promise<AudioDevice[]> {
  const households = await client.getHouseholds();
  const devices: AudioDevice[] = [];

  for (const household of households.households) {
    const topology = await client.getGroups(household.id);
    for (const player of topology.players) {
      const group = findOwningGroup(topology.groups, player.id);
      for (const [index, deviceId] of player.deviceIds.entries()) {
        devices.push(createAudioDevice(household.id, group, player, deviceId, index));
      }
    }
  }

  return devices;
}


export async function resolveSonosAudioDevice(
  genericDeviceId: string,
  client: SonosDiscoveryClient = new SonosClient()
): Promise<ResolvedSonosAudioDevice | undefined> {
  const households = await client.getHouseholds();
  for (const household of households.households) {
    const topology = await client.getGroups(household.id);
    for (const player of topology.players) {
      const group = findOwningGroup(topology.groups, player.id);
      for (const [index, physicalDeviceId] of player.deviceIds.entries()) {
        const device = createAudioDevice(
          household.id,
          group,
          player,
          physicalDeviceId,
          index
        );
        if (device.id === genericDeviceId) {
          return {
            device,
            physicalDeviceId,
            player,
            group,
            householdId: household.id,
          };
        }
      }
    }
  }
  return undefined;
}

export async function identifySonosAudioDevice(
  genericDeviceId: string,
  client: SonosIdentificationClient = new SonosClient()
): Promise<void> {
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

    await client.playTestTone(resolved.physicalDeviceId);
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
