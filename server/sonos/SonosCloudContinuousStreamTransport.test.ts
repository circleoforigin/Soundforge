import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AudioDevice,
  AudioStreamDiagnosticEvent,
  AudioStreamSnapshot,
  AudioStreamTransportSnapshot,
  AudioTransportOption,
} from '../../src/models/ResearchLab.ts';
import type { ResolvedSonosAudioDevice } from '../research-lab/SonosAudioDeviceDiscovery.ts';
import type { SonosGroupStreamTestResult } from './SonosClient.ts';
import { SonosCloudContinuousStreamTransport } from './SonosCloudContinuousStreamTransport.ts';

function fixture(): {
  device: AudioDevice;
  option: AudioTransportOption;
  resolved: ResolvedSonosAudioDevice;
} {
  const option: AudioTransportOption = {
    id: 'sonos-cloud-continuous',
    name: 'Sonos Cloud continuous stream',
    operation: 'persistent-stream',
    scope: 'group',
    independentlyTargetable: false,
    availability: 'available',
  };
  const device: AudioDevice = {
    id: 'opaque-device',
    provider: 'sonos',
    name: 'Bonded component',
    identity: {
      providerIdentifierSuffix: 'physical-id',
      logicalPlayerName: 'Logical player',
    },
    capabilities: ['continuous-stream'],
    diagnosticActions: [],
    topology: [],
    transports: [option],
  };
  return {
    device,
    option,
    resolved: {
      device,
      physicalDeviceId: 'physical-id',
      player: {
        id: 'logical-id',
        name: 'Logical player',
        deviceIds: ['physical-id', 'physical-id-2'],
      },
      group: {
        id: 'group-id',
        name: 'Peak group',
        playerIds: ['logical-id'],
      },
      householdId: 'household-id',
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function attachResult(): SonosGroupStreamTestResult {
  return {
    groupId: 'group-id',
    sessionId: 'session-id',
    streamUrl: 'https://stream',
    playbackSubscription: {},
    sessionResponse: {},
    sessionSubscription: {},
    loadStreamResponse: {},
  };
}

function runtimeEvent(code: string): AudioStreamDiagnosticEvent {
  return {
    timestamp: new Date().toISOString(),
    category: 'http',
    code,
    message: code,
  };
}

function runtimeSnapshot(deliveredBytes: number): AudioStreamSnapshot {
  return {
    id: 'stream-id',
    lifecycle: 'running',
    source: 'silence',
    encoder: {
      state: 'running',
      pid: 123,
      startedAt: new Date().toISOString(),
      sampleRate: 44_100,
      channels: 2,
      bitrate: 192_000,
      framesGenerated: 1,
      pcmBytesGenerated: 3_528,
      encodedBytesProduced: deliveredBytes,
      startupBufferBytes: 5_000,
      startupBufferReady: true,
      stdinBackpressured: false,
    },
    httpClient: {
      connected: true,
      connectedAt: new Date().toISOString(),
      disconnectedAt: null,
      deliveredBytes,
      writableLength: 0,
      backpressured: false,
    },
    transport: null,
    createdAt: new Date().toISOString(),
    stoppedAt: null,
    lastError: null,
    recentEvents: [],
  };
}

test('Sonos cloud adapter ignores PLAYING to IDLE while binding is incomplete', async () => {
  const { device, option, resolved } = fixture();
  const updates: Partial<AudioStreamTransportSnapshot>[] = [];
  const diagnostics: string[] = [];
  const terminated: string[] = [];
  const pendingAttach = deferred<SonosGroupStreamTestResult>();
  const attachStarted = deferred<void>();
  const client = {
    async attachGroupStreamPlayback(): Promise<SonosGroupStreamTestResult> {
      attachStarted.resolve();
      return pendingAttach.promise;
    },
    async pauseGroupPlayback(): Promise<unknown> {
      return {};
    },
  };
  const adapter = new SonosCloudContinuousStreamTransport(client, async () => resolved);
  const startPromise = adapter.start({
    device,
    transport: option,
    streamId: 'stream-id',
    streamUrl: 'https://stream',
    updateTransport(update) {
      updates.push(update);
    },
    addDiagnostic(message) {
      diagnostics.push(message);
    },
    terminate(reason) {
      terminated.push(reason);
    },
  });

  await attachStarted.promise;
  adapter.handlePlaybackState('group-id', 'PLAYBACK_STATE_PLAYING');
  adapter.handlePlaybackState('group-id', 'PLAYBACK_STATE_IDLE');
  assert.equal(terminated.length, 0);
  assert.ok(diagnostics.some((message) => /binding is still in progress/i.test(message)));

  pendingAttach.resolve(attachResult());
  const binding = await startPromise;
  assert.equal(binding.targetScope, 'group');
  assert.equal(binding.targetDescription, 'Peak group');
  assert.equal(binding.independentlyTargetable, false);
  assert.equal(terminated.length, 0);
  assert.ok(updates.some((update) => update.bound === true && update.hasBinding === true));

  adapter.handlePlaybackState('group-id', 'PLAYBACK_STATE_IDLE');
  assert.equal(terminated.length, 0);
  assert.ok(diagnostics.some((message) => /until HTTP stream delivery is confirmed/i.test(message)));
});

test('Sonos cloud adapter invalidates a bound active stream on later terminal IDLE', async () => {
  const { device, option, resolved } = fixture();
  const updates: Partial<AudioStreamTransportSnapshot>[] = [];
  const diagnostics: string[] = [];
  const terminated: string[] = [];
  const client = {
    async attachGroupStreamPlayback(): Promise<SonosGroupStreamTestResult> {
      return attachResult();
    },
    async pauseGroupPlayback(): Promise<unknown> {
      return {};
    },
  };
  const adapter = new SonosCloudContinuousStreamTransport(client, async () => resolved);
  await adapter.start({
    device,
    transport: option,
    streamId: 'stream-id',
    streamUrl: 'https://stream',
    updateTransport(update) {
      updates.push(update);
    },
    addDiagnostic(message) {
      diagnostics.push(message);
    },
    terminate(reason) {
      terminated.push(reason);
    },
  });

  adapter.handleRuntimeEvent('stream-id', runtimeEvent('client-connected'), runtimeSnapshot(0));
  adapter.handleRuntimeEvent('stream-id', runtimeEvent('first-client-bytes'), runtimeSnapshot(4_096));
  assert.ok(updates.some((update) => update.state === 'active'));
  assert.ok(diagnostics.some((message) => /terminal playback monitoring armed/i.test(message)));

  adapter.handlePlaybackState('group-id', 'PLAYBACK_STATE_PLAYING');
  adapter.handlePlaybackState('group-id', 'PLAYBACK_STATE_IDLE');
  assert.equal(terminated.length, 1);
  assert.ok(updates.some((update) => update.providerPlaybackState === 'PLAYBACK_STATE_PLAYING'));
  assert.ok(updates.some((update) => update.state === 'error'));
});

test('Sonos cloud adapter rejects a late binding after an explicit startup error', async () => {
  const { device, option, resolved } = fixture();
  const pendingAttach = deferred<SonosGroupStreamTestResult>();
  const attachStarted = deferred<void>();
  const terminated: string[] = [];
  const paused: string[] = [];
  const client = {
    async attachGroupStreamPlayback(): Promise<SonosGroupStreamTestResult> {
      attachStarted.resolve();
      return pendingAttach.promise;
    },
    async pauseGroupPlayback(groupId: string): Promise<unknown> {
      paused.push(groupId);
      return {};
    },
  };
  const adapter = new SonosCloudContinuousStreamTransport(client, async () => resolved);
  const startPromise = adapter.start({
    device,
    transport: option,
    streamId: 'stream-id',
    streamUrl: 'https://stream',
    updateTransport() {},
    addDiagnostic() {},
    terminate(reason) {
      terminated.push(reason);
    },
  });

  await attachStarted.promise;
  adapter.handlePlaybackError('group-id', { errorCode: 'TEST_STARTUP_ERROR' });
  assert.equal(terminated.length, 1);
  pendingAttach.resolve(attachResult());

  await assert.rejects(startPromise, /became terminal while binding/i);
  assert.deepEqual(paused, ['group-id']);
});
