import type {
  AudioDevice,
  AudioTopologyKind,
  AudioTransportOption,
} from '../../models/ResearchLab.ts';

export interface NormalizedAudioDeviceResult {
  devices: AudioDevice[];
  warnings: string[];
}

const transportAvailabilities = new Set(['available', 'experimental', 'unavailable']);
const transportScopes = new Set(['physical-device', 'logical-player', 'group']);
const topologyKinds = new Set(['household', 'group', 'logical-player', 'physical-device']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTransport(value: unknown): AudioTransportOption | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
    return null;
  }
  if (
    (value.operation !== 'audio-clip' && value.operation !== 'persistent-stream') ||
    typeof value.scope !== 'string' || !transportScopes.has(value.scope) ||
    typeof value.availability !== 'string' || !transportAvailabilities.has(value.availability)
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    operation: value.operation,
    scope: value.scope as AudioTransportOption['scope'],
    independentlyTargetable: value.independentlyTargetable === true,
    availability: value.availability as AudioTransportOption['availability'],
    ...(typeof value.limitation === 'string' ? { limitation: value.limitation } : {}),
  };
}

export function normalizeDiscoveredAudioDevices(payload: unknown): NormalizedAudioDeviceResult {
  if (!isRecord(payload) || !Array.isArray(payload.devices)) {
    throw new Error('Device discovery returned an invalid devices collection.');
  }

  const devices: AudioDevice[] = [];
  const warnings: string[] = [];
  for (const [index, value] of payload.devices.entries()) {
    if (
      !isRecord(value) || typeof value.id !== 'string' ||
      typeof value.provider !== 'string' || typeof value.name !== 'string'
    ) {
      warnings.push(`Skipped malformed audio device ${index + 1}.`);
      continue;
    }
    const capabilities = Array.isArray(value.capabilities)
      ? value.capabilities.filter((capability): capability is AudioDevice['capabilities'][number] =>
          capability === 'audio-clip' || capability === 'continuous-stream')
      : [];
    const transports = Array.isArray(value.transports)
      ? value.transports
          .map(normalizeTransport)
          .filter((item): item is AudioTransportOption => Boolean(item))
      : [];
    const topology = Array.isArray(value.topology)
      ? value.topology.flatMap((node) => {
          if (
            !isRecord(node) || typeof node.id !== 'string' || typeof node.name !== 'string' ||
            typeof node.kind !== 'string' || !topologyKinds.has(node.kind)
          ) {
            return [];
          }
          return [{
            id: node.id,
            kind: node.kind as AudioTopologyKind,
            name: node.name,
            ...(typeof node.parentId === 'string' ? { parentId: node.parentId } : {}),
            ...(typeof node.selected === 'boolean' ? { selected: node.selected } : {}),
          }];
        })
      : [];
    const identity = isRecord(value.identity) ? value.identity : {};
    const presentation = isRecord(value.presentation) ? value.presentation : {};
    const logicalPlayerName = typeof identity.logicalPlayerName === 'string'
      ? identity.logicalPlayerName
      : topology.find((node) => node.kind === 'logical-player')?.name ?? value.name;
    const actions = Array.isArray(value.diagnosticActions)
      ? value.diagnosticActions.flatMap((action) => {
          if (
            !isRecord(action) || action.id !== 'identify-speaker' ||
            typeof action.name !== 'string' || typeof action.availability !== 'string' ||
            !transportAvailabilities.has(action.availability)
          ) {
            return [];
          }
          return [{
            id: 'identify-speaker' as const,
            name: action.name,
            availability: action.availability as AudioDevice['diagnosticActions'][number]['availability'],
            ...(typeof action.limitation === 'string' ? { limitation: action.limitation } : {}),
          }];
        })
      : [];
    const hasPhysicalAudioClip = capabilities.includes('audio-clip') && transports.some(
      (transport) => transport.operation === 'audio-clip' &&
        transport.scope === 'physical-device' && transport.availability === 'available'
    );

    devices.push({
      id: value.id,
      provider: value.provider,
      name: value.name,
      ...(typeof value.model === 'string' && value.model.trim() ? { model: value.model } : {}),
      ...(typeof presentation.alias === 'string' && presentation.alias.trim()
        ? { presentation: { alias: presentation.alias.trim() } }
        : {}),
      identity: {
        providerIdentifierSuffix: typeof identity.providerIdentifierSuffix === 'string'
          ? identity.providerIdentifierSuffix
          : '',
        ...(typeof identity.providerIdentifier === 'string'
          ? { providerIdentifier: identity.providerIdentifier }
          : {}),
        logicalPlayerName,
        ...(typeof identity.componentRole === 'string'
          ? { componentRole: identity.componentRole }
          : {}),
        ...(typeof identity.modelNumber === 'string'
          ? { modelNumber: identity.modelNumber }
          : {}),
        ...(typeof identity.serialNumber === 'string'
          ? { serialNumber: identity.serialNumber }
          : {}),
        ...(typeof identity.networkAddress === 'string'
          ? { networkAddress: identity.networkAddress }
          : {}),
      },
      capabilities,
      diagnosticActions: actions.length > 0 ? actions : [{
        id: 'identify-speaker',
        name: 'Identify Speaker',
        availability: hasPhysicalAudioClip ? 'available' : 'unavailable',
        ...(!hasPhysicalAudioClip ? {
          limitation: 'Physical-device AudioClip is not available for this device.',
        } : {}),
      }],
      topology,
      transports,
    });
  }
  return { devices, warnings };
}
