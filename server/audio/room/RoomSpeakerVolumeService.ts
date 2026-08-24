import type { RoomAudioEndpointSnapshot } from '../../../src/models/RoomAudio.ts';
import { discoverLocalSonosDevices, type SonosLocalDevice } from '../../sonos/SonosLocalDiscovery.ts';
import { clampSonosVolume, SonosLocalRenderingControlClient } from '../../sonos/SonosLocalRenderingControlClient.ts';

export interface RoomSpeakerVolumeFailure {
  endpointId: string;
  displayName: string;
  operation: 'discover' | 'get' | 'set';
  message: string;
}

export interface RoomSpeakerVolumeResult {
  volume: number;
  targetedSpeakerCount: number;
  updatedSpeakerCount: number;
  failures: RoomSpeakerVolumeFailure[];
}

type DiscoverDevices = () => Promise<SonosLocalDevice[]>;
type RenderingClient = Pick<SonosLocalRenderingControlClient, 'getVolume' | 'setVolume'>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Sonos physical-volume operation failed.';
}

export class RoomSpeakerVolumeError extends Error {
  readonly result?: RoomSpeakerVolumeResult;
  constructor(message: string, result?: RoomSpeakerVolumeResult) {
    super(message); this.name = 'RoomSpeakerVolumeError'; this.result = result;
  }
}

export class RoomSpeakerVolumeService {
  private readonly discoverDevices: DiscoverDevices;
  private readonly renderingClient: RenderingClient;

  constructor(
    discoverDevices: DiscoverDevices = discoverLocalSonosDevices,
    renderingClient: RenderingClient = new SonosLocalRenderingControlClient()
  ) { this.discoverDevices = discoverDevices; this.renderingClient = renderingClient; }

  async initialize(endpoints: RoomAudioEndpointSnapshot[]): Promise<RoomSpeakerVolumeResult> {
    const targets = this.targets(endpoints);
    const devices = await this.resolveDevices(targets);
    const reads = await Promise.all(targets.map(async (endpoint) => {
      const device = devices.get(endpoint.deviceId);
      if (!device?.renderingControlUrl) return { endpoint, failure: this.failure(endpoint, 'discover', 'RenderingControl endpoint was not discovered.') };
      try { return { endpoint, device, volume: await this.renderingClient.getVolume(device.renderingControlUrl) }; }
      catch (error) { return { endpoint, device, failure: this.failure(endpoint, 'get', errorMessage(error)) }; }
    }));
    const first = reads.find((read) => read.volume !== undefined);
    if (!first || first.volume === undefined) throw new RoomSpeakerVolumeError('Unable to read Room speaker volume.');
    const result = await this.applyResolved(targets, devices, first.volume);
    const readFailures = reads.flatMap((read) => read.failure ? [read.failure] : []);
    return { ...result, failures: [...readFailures, ...result.failures] };
  }

  async set(endpoints: RoomAudioEndpointSnapshot[], volume: number): Promise<RoomSpeakerVolumeResult> {
    const targets = this.targets(endpoints);
    return this.applyResolved(targets, await this.resolveDevices(targets), volume);
  }

  private targets(endpoints: RoomAudioEndpointSnapshot[]): RoomAudioEndpointSnapshot[] {
    const targets = endpoints.filter((endpoint) => endpoint.enabled && endpoint.providerId === 'sonos' && Boolean(endpoint.deviceId));
    if (targets.length === 0) throw new RoomSpeakerVolumeError('The active Room has no enabled Sonos speakers.');
    return targets;
  }

  private async resolveDevices(endpoints: RoomAudioEndpointSnapshot[]): Promise<Map<string, SonosLocalDevice>> {
    const targetIds = new Set(endpoints.map((endpoint) => endpoint.deviceId));
    return new Map((await this.discoverDevices())
      .filter((device) => targetIds.has(device.physicalDeviceId))
      .map((device) => [device.physicalDeviceId, device]));
  }

  private async applyResolved(
    endpoints: RoomAudioEndpointSnapshot[], devices: Map<string, SonosLocalDevice>, volume: number
  ): Promise<RoomSpeakerVolumeResult> {
    const normalized = clampSonosVolume(volume);
    const outcomes = await Promise.all(endpoints.map(async (endpoint) => {
      const device = devices.get(endpoint.deviceId);
      if (!device?.renderingControlUrl) return this.failure(endpoint, 'discover', 'RenderingControl endpoint was not discovered.');
      try { await this.renderingClient.setVolume(device.renderingControlUrl, normalized); return undefined; }
      catch (error) { return this.failure(endpoint, 'set', errorMessage(error)); }
    }));
    const failures = outcomes.filter((failure): failure is RoomSpeakerVolumeFailure => Boolean(failure));
    return {
      volume: normalized, targetedSpeakerCount: endpoints.length,
      updatedSpeakerCount: endpoints.length - failures.length, failures,
    };
  }

  private failure(endpoint: RoomAudioEndpointSnapshot, operation: RoomSpeakerVolumeFailure['operation'], message: string): RoomSpeakerVolumeFailure {
    return { endpointId: endpoint.endpointId, displayName: endpoint.displayName, operation, message };
  }
}

export const roomSpeakerVolumeService = new RoomSpeakerVolumeService();
