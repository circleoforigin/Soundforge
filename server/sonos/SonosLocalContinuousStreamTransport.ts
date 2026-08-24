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
import type { SonosLocalAvTransportRequestDiagnostic } from './SonosLocalAvTransportClient.ts';
import { discoverLocalSonosDevice, type SonosLocalDevice } from './SonosLocalDiscovery.ts';
import { SonosLocalHttpStreamServer } from './SonosLocalHttpStreamServer.ts';
import { resolveSonosLocalResearchDevice } from '../research-lab/SonosLocalAudioDeviceDiscovery.ts';

function broadcastMetadata(streamUrl: string, mimeType: string): string {
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="0" restricted="1"><dc:title>SACscape Latency Lab</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class><res protocolInfo="http-get:*:${mimeType}:*">${streamUrl}</res></item></DIDL-Lite>`;
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === 'TimeoutError'
    || (typeof candidate.message === 'string'
      && /aborted due to timeout/i.test(candidate.message));
}

function hasProvenWavLiveDelivery(snapshot: AudioStreamSnapshot | undefined): snapshot is AudioStreamSnapshot {
  return Boolean(
    snapshot?.httpClient.connected
    && snapshot.httpClient.deliveredBytes > 0
    && snapshot.transport?.state === 'active'
    && snapshot.transport.providerPlaybackState === 'STREAMING'
    && snapshot.recentEvents.some((event) => event.code === 'first-live-bytes')
  );
}

export const wavUriSettleFastThresholdMs = 500;

export function wavUriSettleDelayMs(setUriElapsedMs: number, configuredDelayMs: number): number {
  return setUriElapsedMs < wavUriSettleFastThresholdMs ? configuredDelayMs : 0;
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
    if (context.latencyProfile?.id === 'wav-broadcast') {
      context.addDiagnostic('WAV Sonos startup attempt began.', {
        streamId: context.streamId,
        physicalDeviceIdSuffix: physicalDeviceId.slice(-10),
      }, 'wav_start_attempt');
    }
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
      const recordAvDiagnostic = (diagnostic: SonosLocalAvTransportRequestDiagnostic) =>
        context.addDiagnostic('Sonos local AVTransport request completed.', {
          streamId: context.streamId,
          ...diagnostic,
        }, 'sonos_local_avtransport_request');
      let setUriElapsedMs = 0;
      let playElapsedMs: number | null = null;
      let playTimedOut = false;
      let actualDelayBeforePlayMs = 0;
      const configuredSettleDelayMs = profile?.id === 'wav-broadcast'
        ? context.wavSettleDelayMs ?? 0
        : 0;
      const setUriStartedAt = performance.now();
      let ignoredSetUriTimeout = false;
      try {
        await this.avTransport.setStreamUri(local.avTransportControlUrl, sonosUri, metadata, {
          onDiagnostic: (diagnostic) => {
            setUriElapsedMs = diagnostic.elapsedMs;
            recordAvDiagnostic(diagnostic);
          },
        });
        if (setUriElapsedMs === 0) setUriElapsedMs = performance.now() - setUriStartedAt;
      } catch (error) {
        if (setUriElapsedMs === 0) setUriElapsedMs = performance.now() - setUriStartedAt;
        const snapshot = context.getSnapshot?.();
        if (profile?.id !== 'wav-broadcast' || !isTimeoutError(error)
          || !hasProvenWavLiveDelivery(snapshot)) {
          throw error;
        }
        ignoredSetUriTimeout = true;
        context.addDiagnostic(
          'Sonos SetAVTransportURI timed out after the WAV media plane had already reached stable live delivery.',
          {
            streamId: context.streamId,
            connectionOrdinal: snapshot.httpClient.currentConnectionOrdinal,
            deliveredBytes: snapshot.httpClient.deliveredBytes,
            transportState: snapshot.transport?.state ?? null,
            providerPlaybackState: snapshot.transport?.providerPlaybackState ?? null,
          },
          'wav_set_uri_timeout_ignored_after_live_delivery'
        );
      }
      if (!ignoredSetUriTimeout) {
        const requestedDelayMs = wavUriSettleDelayMs(setUriElapsedMs, configuredSettleDelayMs);
        if (requestedDelayMs > 0) {
          const delayStartedAt = performance.now();
          await new Promise((resolve) => setTimeout(resolve, requestedDelayMs));
          actualDelayBeforePlayMs = performance.now() - delayStartedAt;
        }
        const beforePlay = context.getSnapshot?.();
        const playStartedAt = performance.now();
        try {
          await this.avTransport.play(local.avTransportControlUrl, {
            onDiagnostic: (diagnostic) => {
              playElapsedMs = diagnostic.elapsedMs;
              playTimedOut = diagnostic.timedOut;
              recordAvDiagnostic(diagnostic);
            },
          });
          if (playElapsedMs === null) playElapsedMs = performance.now() - playStartedAt;
        } catch (error) {
          if (playElapsedMs === null) playElapsedMs = performance.now() - playStartedAt;
          playTimedOut = isTimeoutError(error);
          if (profile?.id === 'wav-broadcast') {
            context.addDiagnostic('WAV URI settle-delay experiment completed.', {
              streamId: context.streamId, setUriElapsedMs,
              fastThresholdMs: wavUriSettleFastThresholdMs,
              classifiedFast: setUriElapsedMs < wavUriSettleFastThresholdMs,
              configuredSettleDelayMs, actualDelayBeforePlayMs,
              playElapsedMs, playTimedOut,
              httpConsumerConnectedBeforePlay: beforePlay?.httpClient.connected ?? false,
              firstLiveBytesBeforePlay: beforePlay?.recentEvents.some(
                (event) => event.code === 'first-live-bytes') ?? false,
            }, 'wav_uri_settle_experiment');
          }
          throw error;
        }
        if (profile?.id === 'wav-broadcast') {
          context.addDiagnostic('WAV URI settle-delay experiment completed.', {
            streamId: context.streamId, setUriElapsedMs,
            fastThresholdMs: wavUriSettleFastThresholdMs,
            classifiedFast: setUriElapsedMs < wavUriSettleFastThresholdMs,
            configuredSettleDelayMs, actualDelayBeforePlayMs,
            playElapsedMs, playTimedOut,
            httpConsumerConnectedBeforePlay: beforePlay?.httpClient.connected ?? false,
            firstLiveBytesBeforePlay: beforePlay?.recentEvents.some(
              (event) => event.code === 'first-live-bytes') ?? false,
          }, 'wav_uri_settle_experiment');
        }
      }
      if (ignoredSetUriTimeout) {
        const snapshot = context.getSnapshot?.();
        context.addDiagnostic('WAV URI settle-delay experiment completed without Play.', {
          streamId: context.streamId, setUriElapsedMs,
          fastThresholdMs: wavUriSettleFastThresholdMs,
          classifiedFast: setUriElapsedMs < wavUriSettleFastThresholdMs,
          configuredSettleDelayMs, actualDelayBeforePlayMs,
          playElapsedMs, playTimedOut,
          httpConsumerConnectedBeforePlay: snapshot?.httpClient.connected ?? false,
          firstLiveBytesBeforePlay: snapshot?.recentEvents.some(
            (event) => event.code === 'first-live-bytes') ?? false,
        }, 'wav_uri_settle_experiment');
      }
      const ignoredControlTimeout = ignoredSetUriTimeout;
      const provenSnapshot = ignoredControlTimeout ? context.getSnapshot?.() : undefined;
      context.updateTransport({
        state: provenSnapshot?.transport?.state === 'active' ? 'active' : 'bound',
        targetScope: 'physical-device',
        targetDescription,
        independentlyTargetable: true,
        bound: true,
        hasBinding: true,
        providerPlaybackState: ignoredControlTimeout
          ? provenSnapshot?.transport?.providerPlaybackState ?? 'STREAMING'
          : 'PLAY_REQUESTED',
        lastError: null,
      }, ignoredControlTimeout
        ? `WAV media delivery remained active after a nonfatal Sonos ${ignoredSetUriTimeout ? 'SetAVTransportURI' : 'Play'} timeout.`
        : 'Sonos local AVTransport accepted the stream URI and Play command.');
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
    const context = this.contexts.get(data.streamId);
    let stopError: unknown;
    try {
      await this.avTransport.stop(data.controlUrl, {
        onDiagnostic: context ? (diagnostic) => context.addDiagnostic(
          'Sonos local AVTransport request completed.',
          { streamId: data.streamId, ...diagnostic },
          'sonos_local_avtransport_request'
        ) : undefined,
      });
    } catch (error) { stopError = error; }
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
    const wav = context.latencyProfile?.id === 'wav-broadcast';
    if (wav && event.code === 'client-connected') {
      const ordinal = Number(event.details?.connectionOrdinal ?? 0);
      context.addDiagnostic(
        ordinal === 1 ? 'WAV first Sonos HTTP consumer connected.' : 'WAV Sonos HTTP reconnect connected.',
        { streamId, connectionOrdinal: ordinal, ...event.details },
        ordinal === 1 ? 'wav_first_consumer' : 'wav_reconnect_success'
      );
    }
    if (wav && event.code === 'client-disconnected') {
      context.addDiagnostic('WAV Sonos HTTP consumer disconnected.', {
        streamId, ...event.details,
      }, 'wav_consumer_disconnect');
    }
    if (wav && event.code === 'awaiting-startup-reconnect') {
      context.addDiagnostic('WAV startup reconnect is expected within the bounded grace window.', {
        streamId, ...event.details,
      }, 'wav_reconnect_expected');
    }
    if (wav && event.code === 'startup-reconnect-timeout') {
      context.addDiagnostic('WAV startup failed because the Sonos consumer did not reconnect.', {
        streamId, ...event.details,
      }, 'wav_start_failed');
    }
    if (event.code === 'awaiting-startup-reconnect') {
      context.updateTransport({ state: 'bound', providerPlaybackState: 'AWAITING_STARTUP_RECONNECT' }, 'First local HTTP consumer closed; awaiting bounded startup reconnect.');
    }
    if (event.code === 'startup-client-reconnected') {
      context.updateTransport({ state: 'bound', providerPlaybackState: 'STARTUP_RECONNECTED' }, 'Second local Sonos HTTP consumer connected.');
    }
    if (event.code === 'first-live-bytes'
      && ((snapshot?.httpClient.connectionCount ?? 0) >= 2 || wav)) {
      context.updateTransport({ state: 'active', providerPlaybackState: 'STREAMING' }, 'Local Sonos reconnect consumer is receiving aligned AAC audio.');
      if (wav) {
        context.addDiagnostic('WAV Sonos stream reached stable live delivery.', {
          streamId,
          connectionOrdinal: snapshot?.httpClient.currentConnectionOrdinal ?? null,
          deliveredBytes: snapshot?.httpClient.deliveredBytes ?? 0,
        }, 'wav_stream_stable');
      }
    }
  }
}

export const sonosLocalContinuousStreamTransport = new SonosLocalContinuousStreamTransport();
