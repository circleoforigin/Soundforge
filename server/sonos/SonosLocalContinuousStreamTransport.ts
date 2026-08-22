import dgram from 'node:dgram';

import type {
  ContinuousStreamTransport,
  ContinuousStreamTransportBinding,
  ContinuousStreamTransportContext,
} from '../audio/transports/ContinuousStreamTransport.ts';
import { resolveSonosAudioDevice, type ResolvedSonosAudioDevice } from '../research-lab/SonosAudioDeviceDiscovery.ts';
import { SonosLocalAvTransportClient } from './SonosLocalAvTransportClient.ts';
import { discoverLocalSonosDevice, type SonosLocalDevice } from './SonosLocalDiscovery.ts';
import { SonosLocalHttpStreamServer } from './SonosLocalHttpStreamServer.ts';

interface LocalBindingData {
  controlUrl: string;
  server: SonosLocalHttpStreamServer;
}

async function routeAddress(targetAddress: string): Promise<string> {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(9, targetAddress, resolve);
    });
    const address = socket.address();
    if (typeof address === 'string') throw new Error('Unable to resolve the local LAN interface.');
    return address.address;
  } finally {
    socket.close();
  }
}

export class SonosLocalContinuousStreamTransport implements ContinuousStreamTransport {
  readonly id = 'sonos-local-continuous';
  readonly encodingProfileId = 'aac-adts' as const;

  private readonly resolveDevice: (id: string) => Promise<ResolvedSonosAudioDevice | undefined>;
  private readonly discoverLocal: (id: string) => Promise<SonosLocalDevice | undefined>;
  private readonly avTransport: SonosLocalAvTransportClient;

  constructor(
    resolveDevice = resolveSonosAudioDevice,
    discoverLocal = discoverLocalSonosDevice,
    avTransport = new SonosLocalAvTransportClient()
  ) {
    this.resolveDevice = resolveDevice;
    this.discoverLocal = discoverLocal;
    this.avTransport = avTransport;
  }

  async start(context: ContinuousStreamTransportContext): Promise<ContinuousStreamTransportBinding> {
    context.updateTransport({ state: 'binding' }, 'Resolving selected physical Sonos device on the local network.');
    const resolved = await this.resolveDevice(context.device.id);
    if (!resolved) throw new Error('The selected Sonos physical device is no longer present in cloud topology.');
    if (resolved.player.deviceIds.length !== 1 || !resolved.group || resolved.group.playerIds.length !== 1) {
      throw new Error('Experimental Sonos local continuous streaming currently supports only a standalone physical player. Bonded/group members are not redirected to a coordinator.');
    }
    const local = await this.discoverLocal(resolved.physicalDeviceId);
    if (!local) throw new Error('The selected Sonos physical device was not found by local SSDP discovery. Confirm that SACscape and Sonos are on the same LAN.');
    const localAddress = await routeAddress(local.address);
    let server: SonosLocalHttpStreamServer | undefined;
    try {
      server = new SonosLocalHttpStreamServer({
        streamId: context.streamId,
        bindAddress: localAddress,
        onClient: context.bindHttpClient,
        onDiagnostic: context.addDiagnostic,
      });
      const port = await server.listen();
      const path = `/research-lab/${encodeURIComponent(context.streamId)}.aac`;
      const httpUrl = `http://${localAddress}:${port}${path}`;
      const sonosUri = `x-rincon-mp3radio://${localAddress}:${port}${path}`;
      context.addDiagnostic('Local Sonos stream listener started.', {
        physicalDeviceIdSuffix: resolved.physicalDeviceId.slice(-10),
        localAddress, port, mimeType: 'audio/aac', framing: 'HTTP/1.0 connection-close',
      });
      await this.avTransport.setStreamUri(local.avTransportControlUrl, sonosUri);
      await this.avTransport.play(local.avTransportControlUrl);
      context.updateTransport({ state: 'bound', providerPlaybackState: 'PLAY_REQUESTED' }, 'Sonos local AVTransport accepted the stream URI and Play command.');
      return {
        transportId: this.id,
        targetScope: 'physical-device',
        targetDescription: resolved.device.presentation?.alias ?? resolved.device.name,
        independentlyTargetable: true,
        providerBinding: { controlUrl: local.avTransportControlUrl, server, httpUrl } satisfies LocalBindingData & { httpUrl: string },
      };
    } catch (error) {
      await server?.close().catch(() => undefined);
      throw error;
    }
  }

  async stop(binding: ContinuousStreamTransportBinding): Promise<void> {
    const data = binding.providerBinding as LocalBindingData;
    let stopError: unknown;
    try { await this.avTransport.stop(data.controlUrl); } catch (error) { stopError = error; }
    await data.server.close();
    if (stopError) throw stopError;
  }
}

export const sonosLocalContinuousStreamTransport = new SonosLocalContinuousStreamTransport();
