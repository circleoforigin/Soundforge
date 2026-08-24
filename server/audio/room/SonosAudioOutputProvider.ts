import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RoomAudioEndpoint } from '../../../src/models/RoomAudio.ts';
import type { AudioStreamSnapshot } from '../../../src/models/ResearchLab.ts';
import { getSonosLatencyExperimentProfile } from '../../../src/models/SonosLatencyLab.ts';
import { ContinuousAudioStreamManager } from '../ContinuousAudioStreamManager.ts';
import type { ContinuousStreamTransportBinding, ContinuousStreamTransportContext } from '../transports/ContinuousStreamTransport.ts';
import { sonosLocalContinuousStreamTransport } from '../../sonos/SonosLocalContinuousStreamTransport.ts';
import type { AudioDevice, AudioTransportOption } from '../../../src/models/ResearchLab.ts';
import type { AudioEndpointConnection, AudioOutputProvider } from './AudioOutputProvider.ts';
import { diagnosticLogService, type DiagnosticLogService } from '../../diagnostics/DiagnosticLogService.ts';

type SonosRoomAudioTransport = Pick<
  typeof sonosLocalContinuousStreamTransport,
  | 'id'
  | 'clientReconnectGraceMs'
  | 'minimumConnectionsForTone'
  | 'handleRuntimeEvent'
  | 'startPhysicalDevice'
  | 'stop'
>;

export function isSonosRadioEndpointReady(snapshot: AudioStreamSnapshot): boolean {
  return snapshot.lifecycle === 'running'
    && snapshot.encoder.state === 'running'
    && snapshot.encoder.codec === 'aac-lc'
    && snapshot.encoder.container === 'adts'
    && snapshot.httpClient.connected
    && snapshot.httpClient.deliveredBytes > 0
    && !snapshot.httpClient.awaitingReconnect
    && snapshot.transport?.state === 'active'
    && snapshot.transport.providerPlaybackState === 'STREAMING';
}

export class SonosAudioOutputProvider implements AudioOutputProvider {
  readonly id = 'sonos';
  private readonly manager: ContinuousAudioStreamManager;
  private readonly transport: SonosRoomAudioTransport;
  private readonly diagnostics: Pick<DiagnosticLogService, 'record'>;

  constructor(
    manager = new ContinuousAudioStreamManager(),
    transport: SonosRoomAudioTransport = sonosLocalContinuousStreamTransport,
    diagnostics: Pick<DiagnosticLogService, 'record'> = diagnosticLogService
  ) {
    this.manager = manager;
    this.transport = transport;
    this.diagnostics = diagnostics;
  }

  async openEndpoint(
    endpoint: RoomAudioEndpoint,
    callbacks: { onFailure?: (error: Error) => void } = {}
  ): Promise<AudioEndpointConnection> {
    const transportOption: AudioTransportOption = {
      id: this.transport.id, name: 'Sonos local continuous stream',
      operation: 'persistent-stream', scope: 'physical-device', independentlyTargetable: true,
      availability: 'experimental', limitation: 'Direct LAN AVTransport stream.',
    };
    const localDevice: AudioDevice = {
      id: `sonos-local-${endpoint.deviceId}`, provider: 'sonos', name: endpoint.displayName,
      identity: {
        providerIdentifierSuffix: endpoint.deviceId.slice(-10),
        logicalPlayerName: endpoint.displayName,
      },
      capabilities: ['continuous-stream'], diagnosticActions: [], topology: [], transports: [transportOption],
    };
    let streamId = '';
    let binding: ContinuousStreamTransportBinding | undefined;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let readySettled = false;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const settleReady = (snapshot: AudioStreamSnapshot) => {
      if (!readySettled && isSonosRadioEndpointReady(snapshot)) {
        readySettled = true;
        resolveReady();
      }
    };
    const failReady = (error: Error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      callbacks.onFailure?.(error);
    };
    const stream = this.manager.create({
      deviceId: localDevice.id,
      transportId: this.transport.id,
      encodingProfileId: 'aac-adts',
      externalPcmSource: true,
      clientReconnectGraceMs: this.transport.clientReconnectGraceMs,
      minimumConnectionsForTone: this.transport.minimumConnectionsForTone,
      onEvent: (event) => {
        this.transport.handleRuntimeEvent?.(streamId, event, this.manager.getSnapshot(streamId));
        const snapshot = this.manager.getSnapshot(streamId);
        if (snapshot) settleReady(snapshot);
      },
      onClientDisconnected: (reason) => failReady(new Error(reason)),
      onEncoderExit: () => failReady(new Error('Sonos endpoint encoder exited.')),
    });
    streamId = stream.id;
    const startupStartedAt = performance.now();
    await this.diagnostics.record({
      category: 'transport', level: 'info', event: 'room_audio.sonos_radio_connecting',
      message: 'Sonos AAC/Radio Room Audio endpoint connecting.',
      details: {
        streamId,
        endpointId: endpoint.endpointId,
        deviceIdSuffix: endpoint.deviceId.slice(-10),
      },
    });
    stream.start();
    const silence = Buffer.alloc(48_000 * 20 / 1_000 * 2 * 2);
    const prewarm = setInterval(() => stream.writeExternalPcmFrame(silence, performance.now()), 20);
    try {
      await stream.waitUntilReadyForClient();
      const context: ContinuousStreamTransportContext = {
        device: localDevice,
        transport: transportOption,
        streamId,
        streamUrl: '',
        latencyProfile: getSonosLatencyExperimentProfile('aac-radio'),
        bindHttpClient: (client, metadata) => stream.bindHttpClient(client, metadata),
        updateTransport: (update, message) => stream.updateTransport(update, message),
        addDiagnostic: (message, details) => stream.addDiagnosticEvent('lifecycle', message, details),
        getSnapshot: () => stream.getSnapshot(),
        terminate: (reason) => failReady(new Error(reason)),
      };
      binding = await this.transport.startPhysicalDevice(
        context, endpoint.deviceId, endpoint.displayName, { ensureStandalone: true }
      );
      if (stream.getSnapshot().transport?.state !== 'active') {
        stream.updateTransport(
          { state: 'bound', bound: true, hasBinding: true },
          'Room Audio endpoint transport bound.'
        );
      }
      settleReady(stream.getSnapshot());
      await ready;
      const readySnapshot = stream.getSnapshot();
      await this.diagnostics.record({
        category: 'transport', level: 'info', event: 'room_audio.sonos_radio_ready',
        message: 'Sonos AAC/Radio Room Audio endpoint is ready.',
        details: {
          streamId,
          encoderPid: readySnapshot.encoder.pid,
          currentConsumerOrdinal: readySnapshot.httpClient.currentConnectionOrdinal,
          connectionCount: readySnapshot.httpClient.connectionCount,
          deliveredBytes: readySnapshot.httpClient.deliveredBytes,
          transportState: readySnapshot.transport?.state ?? null,
          providerPlaybackState: readySnapshot.transport?.providerPlaybackState ?? null,
          awaitingReconnect: readySnapshot.httpClient.awaitingReconnect,
          elapsedStartupMs: Math.round((performance.now() - startupStartedAt) * 100) / 100,
        },
      });
    } catch (error) {
      clearInterval(prewarm);
      this.manager.stop(streamId, 'Room Audio endpoint startup failed');
      if (binding) await this.transport.stop(binding).catch(() => undefined);
      throw error;
    }

    const connectionId = crypto.randomUUID();
    let closed = false;
    let prewarming = true;
    const establishedBinding = binding;
    return {
      id: connectionId,
      endpoint,
      encoderId: streamId,
      getEncoderPid: () => stream.getSnapshot().encoder.pid,
      getTelemetry: () => {
        const snapshot = stream.getSnapshot();
        const queuedBytes = snapshot.httpClient.writableLength;
        return {
          pcmFramesSubmitted: snapshot.encoder.framesGenerated,
          pcmBytesSubmitted: snapshot.encoder.pcmBytesGenerated,
          encodedBytesProduced: snapshot.encoder.encodedBytesProduced,
          httpBytesDelivered: snapshot.httpClient.deliveredBytes,
          httpWritableLength: queuedBytes,
          estimatedQueuedAudioMs: Math.round(queuedBytes * 8 / Math.max(1, snapshot.encoder.bitrate) * 1000),
          estimatedEncodedDeliveryLeadMs: Math.round(Math.max(0,
            snapshot.encoder.encodedBytesProduced - snapshot.httpClient.deliveredBytes
          ) * 8 / Math.max(1, snapshot.encoder.bitrate) * 1000),
        };
      },
      pushPcm: (frame, logicalTime) => {
        if (prewarming) { clearInterval(prewarm); prewarming = false; }
        return stream.writeExternalPcmFrame(frame, logicalTime);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (prewarming) { clearInterval(prewarm); prewarming = false; }
        this.manager.stop(streamId, 'Room Audio endpoint closed');
        await this.transport.stop(establishedBinding);
      },
    };
  }
}
