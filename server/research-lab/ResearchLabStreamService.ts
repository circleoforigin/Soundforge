import { randomUUID } from 'node:crypto';

import type {
  AudioDevice,
  AudioStreamSnapshot,
  ContinuousHttpFramingMode,
} from '../../src/models/ResearchLab.ts';
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
  diagnosticLogService,
  type DiagnosticLogService,
} from '../diagnostics/DiagnosticLogService.ts';
import {
  getSonosLatencyExperimentProfile,
  type SonosLatencyExperimentProfile,
} from '../../src/models/SonosLatencyLab.ts';

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
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    code = 'RESEARCH_LAB_OPERATION_FAILED',
    details?: Record<string, unknown>
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = 'ResearchLabRequestError';
  }
}

export class ResearchLabStreamService {
  readonly manager: ContinuousAudioStreamManager;

  private readonly registry: ContinuousStreamTransportRegistry;
  private readonly discoverDevices: () => Promise<AudioDevice[]>;
  private readonly diagnostics: Pick<DiagnosticLogService, 'record'>;
  private readonly bindings = new Map<string, ActiveTransportBinding>();
  private readonly latencyContexts = new Map<string, {
    profileId: string;
    physicalDeviceId: string;
  }>();

  constructor(
    manager: ContinuousAudioStreamManager,
    registry: ContinuousStreamTransportRegistry,
    discoverDevices: () => Promise<AudioDevice[]> = getSonosAudioDevices,
    diagnostics: Pick<DiagnosticLogService, 'record'> = diagnosticLogService
  ) {
    this.manager = manager;
    this.registry = registry;
    this.discoverDevices = discoverDevices;
    this.diagnostics = diagnostics;
  }

  async start(
    deviceId: string,
    transportId: string,
    createStreamUrl: (streamId: string) => string,
    httpFramingMode: ContinuousHttpFramingMode = 'chunked',
    latencyProfileId?: string,
    wavSettleDelayMs?: number
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
    const latencyLabSessionId = latencyProfile ? randomUUID() : undefined;
    const stream = this.manager.create({
      deviceId,
      transportId,
      httpFramingMode,
      latencyLabSessionId,
      encodingProfileId: latencyProfile?.useTransportDefaults
        ? transport.encodingProfileId
        : latencyProfile?.encodingProfileId ?? transport.encodingProfileId,
      clientReconnectGraceMs: transport.clientReconnectGraceMs,
      minimumConnectionsForTone: transport.minimumConnectionsForTone,
      onEvent: (event) => {
        transport.handleRuntimeEvent?.(streamId, event, this.manager.getSnapshot(streamId));
        if (latencyProfile && latencyLabSessionId && streamId
          && event.code !== 'stream-rate-sample') {
          const details = {
            latencyLabSessionId,
            streamId,
            profileId: latencyProfile.id,
            physicalDeviceId: device.identity.providerIdentifier
              ?? `suffix:${device.identity.providerIdentifierSuffix}`,
            toneCorrelationId: typeof event.details?.correlationId === 'string'
              ? event.details.correlationId
              : null,
            streamEventCategory: event.category,
            streamEventCode: event.code ?? null,
            ...(event.details ?? {}),
          };
          void this.diagnostics.record({
            category: event.category === 'error' ? 'error'
              : event.category === 'http' || event.category === 'backpressure'
                ? 'transport'
                : 'audio',
            level: event.category === 'error' ? 'error' : 'info',
            event: event.code?.startsWith('latency_lab.')
              ? event.code
              : `latency_lab.${event.code ?? event.category}`,
            message: event.message,
            ...(typeof event.details?.correlationId === 'string'
              ? { correlationId: event.details.correlationId }
              : {}),
            details,
          }).catch((error) => console.error('Unable to record Latency Lab diagnostic.', error));
        }
      },
      onClientDisconnected: (reason) => void this.terminateRuntime(streamId, reason),
      onEncoderExit: () => void this.terminateRuntime(
        streamId,
        'Continuous stream encoder exited.'
      ),
    });
    streamId = stream.id;
    const streamUrl = createStreamUrl(stream.id);
    if (latencyProfile) {
      this.latencyContexts.set(stream.id, {
        profileId: latencyProfile.id,
        physicalDeviceId: device.identity.providerIdentifier
          ?? `suffix:${device.identity.providerIdentifierSuffix}`,
      });
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
        ...(latencyProfile && !latencyProfile.useTransportDefaults ? { latencyProfile } : {}),
        ...(latencyProfile?.id === 'wav-broadcast' && wavSettleDelayMs !== undefined
          ? { wavSettleDelayMs }
          : {}),
        bindHttpClient: (client) => stream.bindHttpClient(client),
        updateTransport: (update, message) => stream.updateTransport(update, message),
        addDiagnostic: (message, details, code) =>
          stream.addDiagnosticEvent('lifecycle', message, details, code),
        getSnapshot: () => stream.getSnapshot(),
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
      if (latencyProfile) {
        const provider = binding.providerBinding;
        const current = stream.getSnapshot();
        stream.addDiagnosticEvent('lifecycle', 'Latency Lab live hardware stream identity established.', {
          latencyLabSessionId,
          uiStreamId: stream.id,
          serviceStreamId: stream.id,
          runtimeStreamId: stream.id,
          transportBindingId: provider && typeof provider === 'object' && 'streamId' in provider
            ? provider.streamId : stream.id,
          listenerIdentity: provider && typeof provider === 'object' && 'httpUrl' in provider
            ? provider.httpUrl : null,
          remoteSonosAddress: current.httpClient.connections.at(-1)?.remoteAddress ?? null,
          consumerOrdinal: current.httpClient.currentConnectionOrdinal,
          profileId: latencyProfile.id,
          physicalDeviceId: device.identity.providerIdentifier
            ?? `suffix:${device.identity.providerIdentifierSuffix}`,
          encoderPid: current.encoder.pid,
        }, 'latency_lab.live_stream_identity');
      }
      return stream.getSnapshot();
    } catch (error) {
      this.latencyContexts.delete(stream.id);
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

  injectLatencyTone(streamId: string, attempt: {
    correlationId?: string;
    uiStreamId?: string;
    profileId?: string;
    deviceId?: string;
    requestStartedAt?: string;
    requestPath?: string;
  } = {}): AudioStreamSnapshot {
    const stream = this.manager.getActive(streamId);
    const binding = this.bindings.get(streamId);
    if (!stream) throw new ResearchLabRequestError(404, 'Active continuous audio stream not found.');
    const context = this.latencyContexts.get(streamId);
    if (!context) throw new ResearchLabRequestError(409, 'The stream is not a Latency Lab experiment.');
    const providerBinding = binding?.binding.providerBinding;
    const providerStreamId = providerBinding && typeof providerBinding === 'object'
      && 'streamId' in providerBinding && typeof providerBinding.streamId === 'string'
      ? providerBinding.streamId
      : streamId;
    const identity = {
      correlationId: attempt.correlationId ?? null,
      uiStreamId: attempt.uiStreamId ?? streamId,
      serviceStreamId: streamId,
      runtimeStreamId: stream.id,
      transportStreamId: providerStreamId,
      httpListenerIdentity: providerBinding && typeof providerBinding === 'object'
        && 'httpUrl' in providerBinding && typeof providerBinding.httpUrl === 'string'
        ? providerBinding.httpUrl
        : null,
      consumerOrdinal: stream.getSnapshot().httpClient.currentConnectionOrdinal,
      physicalDeviceId: context.physicalDeviceId,
      profileId: context.profileId,
    };
    const identityMatches = identity.uiStreamId === streamId
      && stream.id === streamId && providerStreamId === streamId
      && (!attempt.profileId || attempt.profileId === context.profileId)
      && (!attempt.deviceId || attempt.deviceId === stream.getSnapshot().deviceId);
    stream.addDiagnosticEvent(
      'source',
      identityMatches ? 'Latency tone route resolved the connected runtime.' : 'Latency tone stream identity mismatch.',
      { ...identity, identityMatches },
      'latency_lab.route_tone_request_received'
    );
    stream.addDiagnosticEvent(
      'lifecycle',
      'Latency Lab live hardware stream identity at tone request.',
      {
        latencyLabSessionId: stream.getSnapshot().latencyLabSessionId ?? null,
        ...identity,
        remoteSonosAddress: stream.getSnapshot().httpClient.connections.at(-1)?.remoteAddress ?? null,
        encoderPid: stream.getSnapshot().encoder.pid,
      },
      'latency_lab.live_stream_identity'
    );
    if (!identityMatches) {
      throw new ResearchLabRequestError(
        409,
        'Latency stream identity mismatch.',
        'latency_stream_identity_mismatch',
        { identity }
      );
    }
    // Latency profiles are valid with the first persistent Sonos consumer. The
    // transport's historical two-connection gate only describes the optional
    // startup probe/reconnect sequence, not source readiness.
    const readiness = stream.prepareForToneInjection({ acceptStableInitialConsumer: true });
    const snapshot = stream.getSnapshot();
    const transport = snapshot.transport;
    const transportBound = Boolean(binding && transport?.bound);
    const transportHealthy = transportBound
      && transport?.state !== 'error' && transport?.state !== 'stopping'
      && transport?.state !== 'stopped';
    const rejectionReason = !transportBound
      ? 'The stream transport is not bound.'
      : !transportHealthy
        ? `The stream transport is ${transport?.state ?? 'unhealthy'}.`
        : readiness.reason;
    const readinessDetails = {
      streamExists: true,
      profileId: context.profileId,
      streamId,
      physicalDeviceId: context.physicalDeviceId,
      ...readiness,
      bytesDelivered: snapshot.httpClient.deliveredBytes,
      encoderState: snapshot.encoder.state,
      codec: snapshot.encoder.codec,
      container: snapshot.encoder.container,
      transportBound,
      transportHealthy,
      toneReady: readiness.toneReady && transportHealthy,
      reason: rejectionReason,
    };
    stream.addDiagnosticEvent(
      'source',
      readinessDetails.toneReady
        ? 'Latency Lab tone source is ready.'
        : `Latency Lab tone source rejected injection: ${rejectionReason}`,
      readinessDetails,
      'latency_lab.tone_readiness_checked'
    );
    if (!readinessDetails.toneReady) {
      throw new ResearchLabRequestError(
        409,
        `Tone unavailable: ${rejectionReason}`,
        'latency_stream_not_tone_ready',
        { readiness: readinessDetails }
      );
    }
    stream.addDiagnosticEvent(
      'source',
      'Latency tone source state captured before injection.',
      { ...identity, ...stream.getToneDiagnosticState() },
      'latency_lab.tone_state_before'
    );
    stream.injectTestTone({
      frequencyHz: 880,
      durationMs: 200,
      acceptStableInitialConsumer: true,
      diagnosticPrefix: 'latency_lab',
      diagnosticDetails: {
        profileId: context.profileId,
        streamId,
        physicalDeviceId: context.physicalDeviceId,
        correlationId: attempt.correlationId ?? null,
      },
    });
    stream.addDiagnosticEvent(
      'source',
      'Latency tone source state changed after injection.',
      { ...identity, ...stream.getToneDiagnosticState() },
      'latency_lab.tone_state_after_request'
    );
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
    this.latencyContexts.delete(streamId);
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
    this.latencyContexts.delete(streamId);
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
