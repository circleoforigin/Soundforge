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

interface SonosDiscoveryClient {
  getHouseholds(): ReturnType<SonosClient['getHouseholds']>;
  getGroups(householdId: string): ReturnType<SonosClient['getGroups']>;
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
      independentlyTargetable: true,
      availability: 'experimental',
      limitation: 'Local physical-device transport is not implemented yet.',
    },
  ];
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
        const name = player.deviceIds.length === 1
          ? player.name
          : `${player.name} — bonded component ${index + 1}`;
        devices.push({
          id: opaqueId('device', deviceId),
          provider: 'sonos',
          name,
          ...(player.model ? { model: player.model } : {}),
          capabilities: [
            ...(player.capabilities?.includes('AUDIO_CLIP')
              ? ['audio-clip' as const]
              : []),
            ...(group ? ['continuous-stream' as const] : []),
          ],
          topology: createTopology(household.id, group, player, deviceId),
          transports: createTransports(player, group),
        });
      }
    }
  }

  return devices;
}
