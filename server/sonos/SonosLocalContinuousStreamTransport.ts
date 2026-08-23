import dgram from 'node:dgram';

import type {
  AudioStreamDiagnosticEvent,
  AudioStreamSnapshot,
} from '../../src/models/ResearchLab.ts';
import type {
  ContinuousStreamTransport,
  ContinuousStreamTransportBinding,
  ContinuousStreamTransportContext,
} from '../audio/transports/ContinuousStreamTransport.ts';
import { resolveSonosAudioDevice, type ResolvedSonosAudioDevice } from '../research-lab/SonosAudioDeviceDiscovery.ts';
import { SonosLocalAvTransportClient } from './SonosLocalAvTransportClient.ts';
import { discoverLocalSonosDevice, type SonosLocalDevice } from './SonosLocalDiscovery.ts';
import { SonosLocalHttpStreamServer } from './SonosLocalHttpStreamServer.ts';
import { resolveSonosLocalResearchDevice } from '../research-lab/SonosLocalAudioDeviceDiscovery.ts';

function broadcastMetadata(streamUrl: string, mimeType: string): string {
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="0" restricted="1"><dc:title>SACscape Latency Lab</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class><res protocolInfo="http-get:*:${mimeType}:*">${streamUrl}</res></item></DIDL-Lite>`;
}

interface LocalBindingData {
  streamId: string;
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
  readonly clientReconnectGraceMs = 3_000;
  readonly minimumConnectionsForTone = 2;

  private readonly resolveDevice: (id: string) => Promise<ResolvedSonosAudioDevice | undefined>;
  private readonly discoverLocal: (id: string) => Promise<SonosLocalDevice | undefined>;
  private readonly avTransport: SonosLocalAvTransportClient;
  private readonly contexts = new Map<string, ContinuousStreamTransportContext>();

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
    this.contexts.set(context.streamId, context);
    context.updateTransport({ state: 'binding' }, 'Resolving selected physical Sonos device on the local network.');
    const locallyDiscoveredPhysicalId = resolveSonosLocalResearchDevice(context.device.id);
    if (locallyDiscoveredPhysicalId) {
      return this.startPhysicalDevice(context, locallyDiscoveredPhysicalId,
        context.device.presentation?.alias ?? context.device.name);
    }
    const resolved = await this.resolveDevice(context.device.id);
    if (!resolved) throw new Error('The selected Sonos physical device is no longer present in cloud topology.');
    if (resolved.player.deviceIds.length !== 1 || !resolved.group || resolved.group.playerIds.length !== 1) {
      throw new Error('Experimental Sonos local continuous streaming currently supports only a standalone physical player. Bonded/group members are not redirected to a coordinator.');
    }
    return this.startPhysicalDevice(context, resolved.physicalDeviceId,
      resolved.device.presentation?.alias ?? resolved.device.name);
  }

  async startPhysicalDevice(
    context: ContinuousStreamTransportContext,
    physicalDeviceId: string,
    targetDescription: string
  ): Promise<ContinuousStreamTransportBinding> {
    this.contexts.set(context.streamId, context);
    context.updateTransport({ state: 'binding' }, 'Resolving selected physical Sonos device on the local network.');
    const local = await this.discoverLocal(physicalDeviceId);
    if (!local) throw new Error('The selected Sonos physical device was not found by local SSDP discovery. Confirm that SACscape and Sonos are on the same LAN.');
    const localAddress = await routeAddress(local.address);
    let server: SonosLocalHttpStreamServer | undefined;
    try {
      const profile = context.latencyProfile;
      const mimeType = profile?.mimeType ?? 'audio/aac';
      server = new SonosLocalHttpStreamServer({
        streamId: context.streamId,
        bindAddress: localAddress,
        contentType: mimeType,
        onClient: context.bindHttpClient,
        onDiagnostic: context.addDiagnostic,
      });
      const port = await server.listen();
      const extension = profile?.container ?? 'aac';
      const path = `/research-lab/${encodeURIComponent(context.streamId)}.${extension}`;
      const httpUrl = `http://${localAddress}:${port}${path}`;
      const sonosUri = profile?.uriScheme === 'http'
        ? httpUrl
        : `x-rincon-mp3radio://${localAddress}:${port}${path}`;
      const metadata = profile?.metadataMode === 'audio-broadcast'
        ? broadcastMetadata(httpUrl, mimeType)
        : '';
      context.addDiagnostic('Local Sonos stream listener started.', {
        physicalDeviceIdSuffix: physicalDeviceId.slice(-10),
        localAddress, port, mimeType, framing: 'HTTP/1.0 connection-close',
        latencyProfileId: profile?.id ?? null,
        sonosStreamType: profile?.sonosStreamType ?? 'radio',
        uriScheme: profile?.uriScheme ?? 'x-rincon-mp3radio',
        metadataMode: profile?.metadataMode ?? 'empty',
      });
      await this.avTransport.setStreamUri(local.avTransportControlUrl, sonosUri, metadata);
      await this.avTransport.play(local.avTransportControlUrl);
      context.updateTransport({
        state: 'bound',
        targetScope: 'physical-device',
        targetDescription,
        independentlyTargetable: true,
        bound: true,
        hasBinding: true,
        providerPlaybackState: 'PLAY_REQUESTED',
        lastError: null,
      }, 'Sonos local AVTransport accepted the stream URI and Play command.');
      return {
        transportId: this.id,
        targetScope: 'physical-device',
        targetDescription,
        independentlyTargetable: true,
        providerBinding: { streamId: context.streamId, controlUrl: local.avTransportControlUrl, server, httpUrl } satisfies LocalBindingData & { httpUrl: string },
      };
    } catch (error) {
      this.contexts.delete(context.streamId);
      await server?.close().catch(() => undefined);
      throw error;
    }
  }

  async stop(binding: ContinuousStreamTransportBinding): Promise<void> {
    const data = binding.providerBinding as LocalBindingData;
    let stopError: unknown;
    try { await this.avTransport.stop(data.controlUrl); } catch (error) { stopError = error; }
    await data.server.close();
    this.contexts.delete(data.streamId);
    if (stopError) throw stopError;
  }

  handleRuntimeEvent(
    streamId: string,
    event: AudioStreamDiagnosticEvent,
    snapshot: AudioStreamSnapshot | undefined
  ): void {
    const context = this.contexts.get(streamId);
    if (!context) return;
    if (event.code === 'awaiting-startup-reconnect') {
      context.updateTransport({ state: 'bound', providerPlaybackState: 'AWAITING_STARTUP_RECONNECT' }, 'First local HTTP consumer closed; awaiting bounded startup reconnect.');
    }
    if (event.code === 'startup-client-reconnected') {
      context.updateTransport({ state: 'bound', providerPlaybackState: 'STARTUP_RECONNECTED' }, 'Second local Sonos HTTP consumer connected.');
    }
    if (event.code === 'first-live-bytes' && (snapshot?.httpClient.connectionCount ?? 0) >= 2) {
      context.updateTransport({ state: 'active', providerPlaybackState: 'STREAMING' }, 'Local Sonos reconnect consumer is receiving aligned AAC audio.');
    }
  }
}

export const sonosLocalContinuousStreamTransport = new SonosLocalContinuousStreamTransport();
