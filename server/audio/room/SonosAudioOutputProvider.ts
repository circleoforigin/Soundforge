import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RoomAudioEndpoint } from '../../../src/models/RoomAudio.ts';
import { ContinuousAudioStreamManager } from '../ContinuousAudioStreamManager.ts';
import type { ContinuousStreamTransportBinding } from '../transports/ContinuousStreamTransport.ts';
import { resolveSonosPhysicalDevice } from '../../research-lab/SonosAudioDeviceDiscovery.ts';
import { sonosLocalContinuousStreamTransport } from '../../sonos/SonosLocalContinuousStreamTransport.ts';
import type { AudioEndpointConnection, AudioOutputProvider } from './AudioOutputProvider.ts';

export class SonosAudioOutputProvider implements AudioOutputProvider {
  readonly id = 'sonos';
  private readonly manager = new ContinuousAudioStreamManager();

  async openEndpoint(
    endpoint: RoomAudioEndpoint,
    callbacks: { onFailure?: (error: Error) => void } = {}
  ): Promise<AudioEndpointConnection> {
    const resolved = await resolveSonosPhysicalDevice(endpoint.deviceId);
    if (!resolved) throw new Error(`Sonos physical device is not currently discovered: ${endpoint.displayName}`);
    const transportOption = resolved.device.transports.find((item) => item.id === sonosLocalContinuousStreamTransport.id);
    if (!transportOption || transportOption.availability === 'unavailable') {
      throw new Error(transportOption?.limitation ?? 'Sonos local continuous transport is unavailable.');
    }
    let streamId = '';
    let binding: ContinuousStreamTransportBinding;
    const stream = this.manager.create({
      deviceId: resolved.device.id,
      transportId: sonosLocalContinuousStreamTransport.id,
      encodingProfileId: 'aac-adts',
      externalPcmSource: true,
      clientReconnectGraceMs: sonosLocalContinuousStreamTransport.clientReconnectGraceMs,
      minimumConnectionsForTone: sonosLocalContinuousStreamTransport.minimumConnectionsForTone,
      onEvent: (event) => sonosLocalContinuousStreamTransport.handleRuntimeEvent?.(
        streamId, event, this.manager.getSnapshot(streamId)
      ),
      onClientDisconnected: (reason) => callbacks.onFailure?.(new Error(reason)),
      onEncoderExit: () => callbacks.onFailure?.(new Error('Sonos endpoint encoder exited.')),
    });
    streamId = stream.id;
    stream.start();
    const silence = Buffer.alloc(48_000 * 20 / 1_000 * 2 * 2);
    const prewarm = setInterval(() => stream.writeExternalPcmFrame(silence, performance.now()), 20);
    try {
      await stream.waitUntilReadyForClient();
      binding = await sonosLocalContinuousStreamTransport.start({
        device: resolved.device,
        transport: transportOption,
        streamId,
        streamUrl: '',
        bindHttpClient: (client, metadata) => stream.bindHttpClient(client, metadata),
        updateTransport: (update, message) => stream.updateTransport(update, message),
        addDiagnostic: (message, details) => stream.addDiagnosticEvent('lifecycle', message, details),
        terminate: (reason) => callbacks.onFailure?.(new Error(reason)),
      });
      stream.updateTransport({ state: 'bound', bound: true, hasBinding: true }, 'Room Audio endpoint transport bound.');
      const deadline = Date.now() + 20_000;
      while (!stream.isReadyForTone() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!stream.isReadyForTone()) throw new Error('Sonos endpoint did not establish its playback stream in time.');
    } catch (error) {
      clearInterval(prewarm);
      this.manager.stop(streamId, 'Room Audio endpoint startup failed');
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
      pushPcm: (frame, logicalTime) => {
        if (prewarming) { clearInterval(prewarm); prewarming = false; }
        return stream.writeExternalPcmFrame(frame, logicalTime);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (prewarming) { clearInterval(prewarm); prewarming = false; }
        this.manager.stop(streamId, 'Room Audio endpoint closed');
        await sonosLocalContinuousStreamTransport.stop(establishedBinding);
      },
    };
  }
}
