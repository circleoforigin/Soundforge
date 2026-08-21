import type {
  AudioDevice,
  AudioStreamSnapshot,
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
import { discoverSonosAudioDevices } from './SonosAudioDeviceDiscovery.ts';

interface ActiveTransportBinding {
  transport: ContinuousStreamTransport;
  binding: ContinuousStreamTransportBinding;
}

export interface StopResearchLabStreamResult {
  snapshot: AudioStreamSnapshot;
  transportError?: string;
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
    discoverDevices: () => Promise<AudioDevice[]> = discoverSonosAudioDevices
  ) {
    this.manager = manager;
    this.registry = registry;
    this.discoverDevices = discoverDevices;
  }

  async start(
    deviceId: string,
    transportId: string,
    createStreamUrl: (streamId: string) => string
  ): Promise<AudioStreamSnapshot> {
    const device = (await this.discoverDevices()).find((candidate) => candidate.id === deviceId);
    if (!device) {
      throw new ResearchLabRequestError(404, 'Unknown or no longer discovered audio device.');
    }
    const transportOption = device.transports.find((option) => option.id === transportId);
    if (!transportOption) {
      throw new ResearchLabRequestError(400, 'The requested transport is not available for this device.');
    }
    if (transportOption.availability !== 'available') {
      throw new ResearchLabRequestError(
        409,
        transportOption.limitation ?? `Transport is ${transportOption.availability}.`
      );
    }
    const transport = this.registry.get(transportId);
    if (!transport) {
      throw new ResearchLabRequestError(501, 'The requested transport has no server implementation.');
    }

    let streamId = '';
    const stream = this.manager.create({
      deviceId,
      transportId,
      onClientDisconnected: (reason) => void this.terminateRuntime(streamId, reason),
      onEncoderExit: () => void this.terminateRuntime(
        streamId,
        'Continuous stream encoder exited.'
      ),
    });
    streamId = stream.id;
    const streamUrl = createStreamUrl(stream.id);

    try {
      const binding = await transport.start({
        device,
        transport: transportOption,
        streamId: stream.id,
        streamUrl,
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
      stream.updateTransport({
        state: 'bound',
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

  injectTone(streamId: string): AudioStreamSnapshot {
    const stream = this.manager.getActive(streamId);
    const binding = this.bindings.get(streamId);
    if (!stream) {
      throw new ResearchLabRequestError(404, 'Active continuous audio stream not found.');
    }
    if (!binding || !stream.getSnapshot().transport?.bound) {
      throw new ResearchLabRequestError(409, 'The stream transport is not bound.');
    }
    if (!stream.hasActiveClient()) {
      throw new ResearchLabRequestError(
        409,
        'The continuous stream has no connected audio client yet.'
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
    this.bindings.delete(streamId);
    this.manager.stop(streamId, 'Research Lab stream stopped');
    const snapshot = this.manager.getSnapshot(streamId);
    if (!snapshot) {
      throw new Error('Stopped stream snapshot was not retained.');
    }
    return { snapshot, ...(transportError ? { transportError } : {}) };
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

export const researchLabStreamService = new ResearchLabStreamService(
  continuousAudioStreamManager,
  researchLabTransportRegistry
);
