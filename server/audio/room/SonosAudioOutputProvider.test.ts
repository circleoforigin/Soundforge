import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { RoomAudioEndpoint } from '../../../src/models/RoomAudio.ts';
import type { AudioStreamDiagnosticEvent, AudioStreamSnapshot } from '../../../src/models/ResearchLab.ts';
import type { ContinuousAudioStreamOptions } from '../ContinuousAudioStream.ts';
import { ContinuousAudioStreamManager } from '../ContinuousAudioStreamManager.ts';
import type {
  ContinuousStreamTransportBinding,
  ContinuousStreamTransportContext,
} from '../transports/ContinuousStreamTransport.ts';
import { SonosAudioOutputProvider, isSonosWavEndpointStable } from './SonosAudioOutputProvider.ts';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class CapturingManager extends ContinuousAudioStreamManager {
  createdOptions?: ContinuousAudioStreamOptions;

  override create(options: ContinuousAudioStreamOptions = {}) {
    this.createdOptions = options;
    return super.create(options);
  }
}

class FakeSonosTransport {
  readonly id = 'sonos-local-continuous';
  readonly clientReconnectGraceMs = 3_000;
  readonly minimumConnectionsForTone = 2;
  context?: ContinuousStreamTransportContext;
  startCount = 0;
  stopCount = 0;

  async startPhysicalDevice(
    context: ContinuousStreamTransportContext,
    physicalDeviceId: string,
    targetDescription: string
  ): Promise<ContinuousStreamTransportBinding> {
    void physicalDeviceId;
    void targetDescription;
    this.context = context;
    this.startCount += 1;
    return {
      transportId: this.id,
      targetScope: 'physical-device',
      targetDescription: 'Test speaker',
      independentlyTargetable: true,
      providerBinding: { streamId: context.streamId },
    };
  }

  handleRuntimeEvent(
    _streamId: string,
    event: AudioStreamDiagnosticEvent,
    snapshot: AudioStreamSnapshot | undefined
  ): void {
    void snapshot;
    if (event.code === 'first-live-bytes') {
      this.context?.updateTransport(
        { state: 'active', providerPlaybackState: 'STREAMING' },
        'Fake Sonos consumer is receiving WAV data.'
      );
    }
  }

  async stop(binding: ContinuousStreamTransportBinding): Promise<void> {
    void binding;
    this.stopCount += 1;
  }
}

const endpoint: RoomAudioEndpoint = {
  endpointId: 'speaker-a',
  speakerId: 'speaker-a',
  providerId: 'sonos',
  deviceId: 'RINCON_TEST_SPEAKER_A',
  displayName: 'Test Speaker',
  enabled: true,
  trimDb: 0,
  role: 'spatial-endpoint',
  timingOffsetMs: 0,
};

test('Room Audio Sonos WAV endpoint waits for the stable reconnect consumer', async () => {
  const manager = new CapturingManager();
  const transport = new FakeSonosTransport();
  const diagnosticEvents: string[] = [];
  const failures: Error[] = [];
  const provider = new SonosAudioOutputProvider(manager, transport, {
    async record(input) { diagnosticEvents.push(input.event); return null; },
  });

  let resolved = false;
  const opening = provider.openEndpoint(endpoint, {
    onFailure: (error) => failures.push(error),
  }).then((connection) => {
    resolved = true;
    return connection;
  });

  await waitFor(() => Boolean(transport.context));
  assert.equal(manager.createdOptions?.encodingProfileId, 'wav-pcm');
  assert.equal(manager.createdOptions?.externalPcmSource, true);
  assert.equal(transport.context?.latencyProfile?.id, 'wav-broadcast');
  assert.equal(transport.startCount, 1);

  const streamId = transport.context!.streamId;
  const stream = manager.getActive(streamId);
  assert.ok(stream);
  const encoderPid = stream.getSnapshot().encoder.pid;
  const firstConsumer = new PassThrough();
  firstConsumer.resume();
  transport.context!.bindHttpClient(firstConsumer, { role: 'startup-consumer' });
  await waitFor(() => stream.getSnapshot().lifecycle === 'running');
  const initialSnapshot = stream.getSnapshot();
  assert.equal(initialSnapshot.httpClient.connectionCount, 1);
  assert.equal(initialSnapshot.httpClient.connected, true);
  assert.equal(initialSnapshot.transport?.state, 'active');
  assert.equal(isSonosWavEndpointStable(initialSnapshot), false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resolved, false, 'initial WAV delivery must not resolve openEndpoint');

  firstConsumer.destroy();
  await waitFor(() => stream.getSnapshot().httpClient.awaitingReconnect);
  assert.equal(resolved, false, 'startup reconnect window must remain pending');

  const stableConsumer = new PassThrough();
  stableConsumer.resume();
  transport.context!.bindHttpClient(stableConsumer, { role: 'startup-reconnect' });
  const connection = await opening;
  const stableSnapshot = stream.getSnapshot();
  assert.equal(isSonosWavEndpointStable(stableSnapshot), true);
  assert.equal(stableSnapshot.httpClient.currentConnectionOrdinal, 2);
  assert.equal(stableSnapshot.encoder.pid, encoderPid);
  assert.equal(connection.encoderId, streamId);
  assert.equal(transport.startCount, 1);
  assert.deepEqual(diagnosticEvents, [
    'room_audio.sonos_wav_connecting',
    'room_audio.sonos_wav_stabilizing',
    'room_audio.sonos_wav_ready',
  ]);

  const beforePush = stream.getSnapshot().encoder.pcmBytesGenerated;
  assert.equal(connection.pushPcm(Buffer.alloc(48_000 * 20 / 1_000 * 2 * 2), performance.now()), true);
  assert.ok(stream.getSnapshot().encoder.pcmBytesGenerated > beforePush);
  assert.equal(stream.getSnapshot().encoder.pid, encoderPid);
  assert.equal(stream.getSnapshot().httpClient.currentConnectionOrdinal, 2);
  assert.equal(transport.startCount, 1);
  assert.equal(failures.length, 0);

  stableConsumer.destroy();
  await waitFor(() => failures.length === 1);
  assert.match(failures[0].message, /remote client disconnected/i);
  await connection.close();
  assert.equal(transport.stopCount, 1);
});
