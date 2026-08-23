import type { AudioDevice } from '../../models/ResearchLab.ts';

export function formatAudioDeviceSelectorLabel(device: AudioDevice): string {
  const name = device.presentation?.alias?.trim() || device.name.trim() || 'Unknown device';
  const model = device.model?.trim();
  const suffix = device.identity.providerIdentifierSuffix.trim();
  return [name, model, suffix ? `…${suffix.slice(-6)}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join(' — ');
}

export function audioDeviceSelectorTitle(device: AudioDevice): string {
  return [
    device.identity.providerIdentifier
      ? `Physical Device ID: ${device.identity.providerIdentifier}`
      : undefined,
    device.identity.serialNumber ? `Serial: ${device.identity.serialNumber}` : undefined,
    device.identity.networkAddress ? `IP: ${device.identity.networkAddress}` : undefined,
  ].filter((value): value is string => Boolean(value)).join('\n');
}
