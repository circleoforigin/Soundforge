import crypto from 'node:crypto';
import type { AudioDevice } from '../../src/models/ResearchLab.ts';
import { discoverLocalSonosDevices } from '../sonos/SonosLocalDiscovery.ts';

const physicalIds = new Map<string, string>();

function genericId(physicalDeviceId: string): string {
  return `sonos-local-device-${crypto.createHash('sha256').update(`sonos:local:${physicalDeviceId}`).digest('hex').slice(0, 24)}`;
}

export async function discoverSonosLocalAudioDevices(): Promise<AudioDevice[]> {
  const discovered = await discoverLocalSonosDevices();
  return normalizeSonosLocalAudioDevices(discovered);
}

export function normalizeSonosLocalAudioDevices(
  discovered: Awaited<ReturnType<typeof discoverLocalSonosDevices>>
): AudioDevice[] {
  physicalIds.clear();
  return discovered.map((local) => {
    const id = genericId(local.physicalDeviceId); physicalIds.set(id, local.physicalDeviceId);
    const name = local.name?.trim() || `Sonos ${local.physicalDeviceId.slice(-6)}`;
    return {
      id, provider: 'sonos', name,
      ...(local.model ? { model: local.model } : {}),
      identity: {
        providerIdentifierSuffix: local.physicalDeviceId.slice(-10),
        providerIdentifier: local.physicalDeviceId,
        logicalPlayerName: name,
        ...(local.modelNumber ? { modelNumber: local.modelNumber } : {}),
        ...(local.serialNumber ? { serialNumber: local.serialNumber } : {}),
        networkAddress: local.address,
      },
      capabilities: ['continuous-stream'],
      diagnosticActions: [{
        id: 'identify-speaker', name: 'Identify Speaker', availability: 'unavailable',
        limitation: 'Physical-device identification uses the optional Sonos Cloud AudioClip service.',
      }],
      topology: [{ id: `${id}-physical`, kind: 'physical-device', name, selected: true }],
      transports: [
        {
          id: 'sonos-cloud-audio-clip', name: 'Sonos Cloud audio clip', operation: 'audio-clip',
          scope: 'physical-device', independentlyTargetable: true, availability: 'unavailable',
          limitation: 'Sonos Cloud is not configured in this local-only discovery result.',
        },
        {
          id: 'sonos-cloud-continuous', name: 'Sonos Cloud continuous stream', operation: 'persistent-stream',
          scope: 'group', independentlyTargetable: false, availability: 'unavailable',
          limitation: 'Cloud group topology is unavailable in local-only discovery.',
        },
        {
          id: 'sonos-local-continuous', name: 'Sonos local continuous stream', operation: 'persistent-stream',
          scope: 'physical-device', independentlyTargetable: true, availability: 'experimental',
          limitation: 'Experimental direct-LAN AVTransport stream discovered locally.',
        },
      ],
    } satisfies AudioDevice;
  });
}

export function resolveSonosLocalResearchDevice(deviceId: string): string | undefined {
  return physicalIds.get(deviceId);
}
