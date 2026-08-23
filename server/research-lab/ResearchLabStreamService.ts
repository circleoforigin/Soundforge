import type {
  AudioDevice,
  AudioStreamSnapshot,
  ContinuousHttpFramingMode,
} from '../../src/models/ResearchLab.ts';
import crypto from 'node:crypto';
import type {
  ContinuousStreamTransport,
  ContinuousStreamTransportBinding,
} from '../audio/transports/ContinuousStreamTransport.ts';
import { ContinuousStreamTransportRegistry } from '../audio/transports/ContinuousStreamTransportRegistry.ts';
import {
  ContinuousAudioStreamManager,
  continuousAudioStreamManager,
} from '../audio/ContinuousAudioStreamManager.ts';
import { sonosCloudContinuousStreamTransport } from '../sonos/SonosCloudContinuousStreamTransport.ts';
import { sonosLocalContinuousStreamTransport } from '../sonos/SonosLocalContinuousStreamTransport.ts';
import { getSonosAudioDevices } from './SonosAudioDeviceDiscovery.ts';
import {
  getSonosLatencyExperimentProfile,
  type SonosLatencyExperimentProfile,
} from '../../src/models/SonosLatencyLab.ts';
import { performance } from 'node:perf_hooks';

interface ActiveTransportBinding {
  transport: ContinuousStreamTransport;
  binding: ContinuousStreamTransportBinding;
}

export interface StopResearchLabStreamResult {
  snapshot: AudioStreamSnapshot;
  transportError?: string;
  cleanup: {
    runtimeStopped: boolean;
    encoderStopped: boolean;
    transportStopped: boolean;
    listenerClosed: boolean;
  };
}

export class ResearchLabRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ResearchLabRequestError';
  }
}

export class ResearchLabStreamService {
  readonly manager: ContinuousAudioStreamManager;

  private readonly registry: ContinuousStreamTransportRegistry;
  private readonly discoverDevices: () => Promise<AudioDevice[]>;
  private readonly bindings = new Map<string, ActiveTransportBinding>();

  constructor(
    manager: ContinuousAudioStreamManager,
    registry: ContinuousStreamTransportRegistry,
    discoverDevices: () => Promise<AudioDevice[]> = getSonosAudioDevices
  ) {
    this.manager = manager;
    this.registry = registry;
    this.discoverDevices = discoverDevices;
  }

  async start(
    deviceId: string,
    transportId: string,
    createStreamUrl: (streamId: string) => string,
    httpFramingMode: ContinuousHttpFramingMode = 'chunked',
    latencyProfileId?: string
  ): Promise<AudioStreamSnapshot> {
    const device = (await this.discoverDevices()).find((candidate) => candidate.id === deviceId);
    if (!device) {
      throw new ResearchLabRequestError(404, 'Unknown or no longer discovered audio device.');
    }
    const transportOption = device.transports.find((option) => option.id === transportId);
    if (!transportOption) {
      throw new ResearchLabRequestError(400, 'The requested transport is not available for this device.');
    }
    if (transportOption.availability === 'unavailable') {
      throw new ResearchLabRequestError(
        409,
        transportOption.limitation ?? `Transport is ${transportOption.availability}.`
      );
    }
    const transport = this.registry.get(transportId);
    if (!transport) {
      throw new ResearchLabRequestError(501, 'The requested transport has no server implementation.');
    }
    let latencyProfile: SonosLatencyExperimentProfile | undefined;
    if (latencyProfileId !== undefined) {
      latencyProfile = getSonosLatencyExperimentProfile(latencyProfileId);
      if (!latencyProfile) throw new ResearchLabRequestError(400, 'Unknown latency experiment profile.');
      if (transportId !== 'sonos-local-continuous') {
        throw new ResearchLabRequestError(400, 'Latency transport profiles require Sonos Local continuous streaming.');
      }
    }

    let streamId = '';
    const stream = this.manager.create({
      deviceId,
      transportId,
      httpFramingMode,
      encodingProfileId: latencyProfile?.encodingProfileId ?? transport.encodingProfileId,
      clientReconnectGraceMs: transport.clientReconnectGraceMs,
      minimumConnectionsForTone: transport.minimumConnectionsForTone,
      onEvent: (event) => transport.handleRuntimeEvent?.(
        streamId,
        event,
        this.manager.getSnapshot(streamId)
      ),
      onClientDisconnected: (reason) => void this.terminateRuntime(streamId, reason),
      onEncoderExit: () => void this.terminateRuntime(
        streamId,
        'Continuous stream encoder exited.'
      ),
    });
    streamId = stream.id;
    const streamUrl = createStreamUrl(stream.id);
    if (latencyProfile) {
      stream.addDiagnosticEvent('lifecycle', 'Sonos latency experiment profile selected.', {
        profileId: latencyProfile.id,
        codec: latencyProfile.codec,
        container: latencyProfile.container,
        mimeType: latencyProfile.mimeType,
        sampleRate: latencyProfile.sampleRate,
        channelCount: latencyProfile.channelCount,
        bitrate: latencyProfile.bitrate ?? null,
        sonosStreamType: latencyProfile.sonosStreamType,
        uriScheme: latencyProfile.uriScheme,
        metadataMode: latencyProfile.metadataMode,
        httpFraming: latencyProfile.httpFraming,
      }, 'latency-profile-selected');
    }

    try {
      stream.start();
      await stream.waitUntilReadyForClient();
      stream.addDiagnosticEvent(
        'lifecycle',
        'Startup buffer is ready; beginning transport attachment.',
        undefined,
        'transport-attachment-begin'
      );
      const binding = await transport.start({
        device,
        transport: transportOption,
        streamId: stream.id,
        streamUrl,
        ...(latencyProfile ? { latencyProfile } : {}),
        bindHttpClient: (client) => stream.bindHttpClient(client),
        updateTransport: (update, message) => stream.updateTransport(update, message),
        addDiagnostic: (message, details) =>
          stream.addDiagnosticEvent('lifecycle', message, details),
        terminate: (reason) => void this.terminateRuntime(stream.id, reason),
      });
      if (!this.manager.getActive(stream.id)) {
        await transport.stop(binding).catch(() => undefined);
        throw new Error('The stream became unhealthy while its transport was starting.');
      }
      this.bindings.set(stream.id, { transport, binding });
      const transportState = stream.getSnapshot().transport?.state === 'active'
        ? 'active'
        : 'bound';
      stream.updateTransport({
        state: transportState,
        targetScope: binding.targetScope,
        targetDescription: binding.targetDescription,
        independentlyTargetable: binding.independentlyTargetable,
        bound: true,
        hasBinding: true,
        lastError: null,
      }, 'Continuous stream transport started.');
      return stream.getSnapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start stream transport.';
      stream.updateTransport({
        state: 'error',
        bound: false,
        hasBinding: false,
        lastError: message,
      }, 'Continuous stream transport failed to start.');
      this.manager.stop(stream.id, 'transport start failed');
      throw error;
    }
  }

  injectLatencyTone(streamId: string): AudioStreamSnapshot {
    const stream = this.manager.getActive(streamId);
    const binding = this.bindings.get(streamId);
    if (!stream) throw new ResearchLabRequestError(404, 'Active continuous audio stream not found.');
    if (!binding || !stream.getSnapshot().transport?.bound) {
      throw new ResearchLabRequestError(409, 'The stream transport is not bound.');
    }
    if (!stream.isReadyForTone()) {
      throw new ResearchLabRequestError(409, 'The continuous stream is not ready for latency-tone injection yet.');
    }
    const requestedAt = performance.now();
    stream.scheduleTone({
      eventId: `latency-${crypto.randomUUID()}`,
      targetMonotonicTime: requestedAt,
      frequencyHz: 880,
      durationMs: 200,
    });
    stream.addDiagnosticEvent('source', 'Latency tone requested.', {
      requestedMonotonicTime: requestedAt,
      frequencyHz: 880,
      durationMs: 200,
    }, 'latency-tone-requested');
    return stream.getSnapshot();
  }

  recordLatencyObservation(streamId: string, observedDelayMs: number): AudioStreamSnapshot {
    const stream = this.manager.get(streamId);
    if (!stream) throw new ResearchLabRequestError(404, 'Continuous audio stream not found.');
    if (!Number.isFinite(observedDelayMs) || observedDelayMs < 0) {
      throw new ResearchLabRequestError(400, 'Observed delay must be a non-negative number of milliseconds.');
    }
    stream.addDiagnosticEvent('source', 'User recorded an observed acoustic delay.', {
      observedDelayMs,
    }, 'latency-observation-recorded');
    return stream.getSnapshot();
  }

  injectTone(streamId: string): AudioStreamSnapshot {
    const stream = this.manager.getActive(streamId);
    const binding = this.bindings.get(streamId);
    if (!stream) {
      throw new ResearchLabRequestError(404, 'Active continuous audio stream not found.');
    }
    if (!binding || !stream.getSnapshot().transport?.bound) {
      throw new ResearchLabRequestError(409, 'The stream transport is not bound.');
    }
    if (!stream.isReadyForTone()) {
      throw new ResearchLabRequestError(
        409,
        'The continuous stream is not ready for tone injection yet.'
      );
    }
    stream.injectTestTone();
    return stream.getSnapshot();
  }

  async stop(streamId: string): Promise<StopResearchLabStreamResult> {
    const stream = this.manager.getActive(streamId);
    if (!stream) {
      throw new ResearchLabRequestError(404, 'Active continuous audio stream not found.');
    }
    const activeBinding = this.bindings.get(streamId);
    let transportError: string | undefined;
    stream.updateTransport({ state: 'stopping' }, 'Stopping continuous stream transport.');

    // Retire the generic runtime before closing its provider listener. Destroying the
    // listener's active client emits a disconnect event; it must not start a second
    // teardown of the same binding while this explicit stop is still in progress.
    this.bindings.delete(streamId);
    this.manager.stop(streamId, 'Research Lab stream stopped');

    if (activeBinding) {
      try {
        await activeBinding.transport.stop(activeBinding.binding);
        stream.updateTransport({
          state: 'stopped',
          bound: false,
          hasBinding: false,
          providerPlaybackState: 'STOPPED',
        }, 'Continuous stream transport stopped.');
      } catch (error) {
        transportError = error instanceof Error ? error.message : 'Transport stop failed.';
        stream.updateTransport({
          state: 'error',
          bound: false,
          hasBinding: false,
          lastError: transportError,
        }, 'Transport stop failed; local stream cleanup continued.');
      }
    }
    const snapshot = this.manager.getSnapshot(streamId);
    if (!snapshot) {
      throw new Error('Stopped stream snapshot was not retained.');
    }
    return {
      snapshot,
      cleanup: {
        runtimeStopped: snapshot.lifecycle === 'stopped',
        encoderStopped: snapshot.encoder.state === 'stopped' && snapshot.encoder.pid === null,
        transportStopped: !transportError,
        listenerClosed: !snapshot.httpClient.connected,
      },
      ...(transportError ? { transportError } : {}),
    };
  }

  private async terminateRuntime(streamId: string, reason: string): Promise<void> {
    if (!streamId || !this.manager.getActive(streamId)) {
      return;
    }
    const stream = this.manager.getActive(streamId);
    stream?.updateTransport({
      state: 'error',
      bound: false,
      hasBinding: false,
      lastError: reason,
    }, 'Continuous stream transport became unhealthy.');
    const activeBinding = this.bindings.get(streamId);
    this.bindings.delete(streamId);
    this.manager.stop(streamId, reason);
    if (activeBinding) {
      try {
        await activeBinding.transport.stop(activeBinding.binding);
      } catch (error) {
        this.manager.get(streamId)?.addDiagnosticEvent(
          'error',
          'Transport cleanup after runtime failure failed.',
          {
          error: error instanceof Error ? error.message : error,
          }
        );
      }
    }
  }
}

export const researchLabTransportRegistry = new ContinuousStreamTransportRegistry();
researchLabTransportRegistry.register(sonosCloudContinuousStreamTransport);
researchLabTransportRegistry.register(sonosLocalContinuousStreamTransport);

export const researchLabStreamService = new ResearchLabStreamService(
  continuousAudioStreamManager,
  researchLabTransportRegistry
);
