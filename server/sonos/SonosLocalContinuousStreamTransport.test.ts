import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import type { AudioDevice, AudioStreamSnapshot, AudioStreamTransportSnapshot } from '../../src/models/ResearchLab.ts';
import { ContinuousAudioStreamManager } from '../audio/ContinuousAudioStreamManager.ts';
import type { ResolvedSonosAudioDevice } from '../research-lab/SonosAudioDeviceDiscovery.ts';
import {
  SonosLocalContinuousStreamTransport,
  wavUriSettleDelayMs,
} from './SonosLocalContinuousStreamTransport.ts';
import { getSonosLatencyExperimentProfile } from '../../src/models/SonosLatencyLab.ts';

function fixture(deviceIds = ['RINCON_PLAY1']): ResolvedSonosAudioDevice {
  const device: AudioDevice = {
    id: 'generic-play1', provider: 'sonos', name: 'PLAY:1',
    identity: { providerIdentifierSuffix: 'PLAY1', logicalPlayerName: 'Office' },
    capabilities: ['continuous-stream'], diagnosticActions: [], topology: [], transports: [{
      id: 'sonos-local-continuous', name: 'Local', operation: 'persistent-stream',
      scope: 'physical-device', independentlyTargetable: deviceIds.length === 1,
      availability: 'experimental',
    }],
  };
  return {
    device, physicalDeviceId: deviceIds[0], householdId: 'household',
    player: { id: 'logical', name: 'Office', deviceIds, capabilities: [] },
    group: { id: 'group', name: 'Office', playerIds: ['logical'] },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function timeoutError(): Error {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

function startupSnapshot(overrides: {
  connected?: boolean;
  deliveredBytes?: number;
  live?: boolean;
} = {}): AudioStreamSnapshot {
  const connected = overrides.connected ?? false;
  const deliveredBytes = overrides.deliveredBytes ?? 0;
  const live = overrides.live ?? false;
  return {
    id: 'stream-timeout', lifecycle: live ? 'running' : 'buffering', source: 'silence', toneReady: false,
    telemetry: {} as AudioStreamSnapshot['telemetry'], encoder: {} as AudioStreamSnapshot['encoder'],
    httpClient: {
      framingMode: 'chunked', connected, connectedAt: connected ? new Date().toISOString() : null,
      disconnectedAt: null, deliveredBytes, writableLength: 0, backpressured: false,
      connectionCount: connected ? 1 : 0, currentConnectionOrdinal: connected ? 1 : null,
      awaitingReconnect: false, connections: [],
    },
    transport: {
      state: live ? 'active' : 'binding', targetScope: null, targetDescription: null,
      independentlyTargetable: null, bound: false,
      providerPlaybackState: live ? 'STREAMING' : null, hasBinding: false, lastError: null,
    },
    createdAt: new Date().toISOString(), stoppedAt: null, lastError: null,
    recentEvents: live ? [{
      timestamp: new Date().toISOString(), category: 'http', code: 'first-live-bytes',
      message: 'First live bytes delivered.',
    }] : [],
    scheduledEvents: [],
  };
}

test('WAV URI settle-delay classification applies only to fast SetAVTransportURI responses', () => {
  assert.equal(wavUriSettleDelayMs(2_500, 1_000), 0);
  assert.equal(wavUriSettleDelayMs(25, 0), 0);
  for (const delay of [250, 500, 1_000, 2_000, 3_000]) {
    assert.equal(wavUriSettleDelayMs(25, delay), delay);
  }
});

test('local transport resolves and controls the exact standalone physical device', async () => {
  const resolved = fixture();
  const actions: string[] = [];
  const updates: Array<Partial<AudioStreamTransportSnapshot>> = [];
  const transport = new SonosLocalContinuousStreamTransport(
    async () => resolved,
    async (id) => {
      assert.equal(id, 'RINCON_PLAY1');
      return {
        physicalDeviceId: id, address: '127.0.0.1', descriptionUrl: 'http://127.0.0.1/device.xml',
        avTransportControlUrl: 'http://127.0.0.1:1400/MediaRenderer/AVTransport/Control',
      };
    },
    {
      async setStreamUri(_url, uri) { actions.push(`set:${uri}`); },
      async play() { actions.push('play'); },
      async stop() { actions.push('stop'); },
    }
  );
  const binding = await transport.start({
    device: resolved.device, transport: resolved.device.transports[0], streamId: 'stream-one',
    streamUrl: 'https://unused', bindHttpClient: () => undefined,
    updateTransport: (update) => updates.push(update), addDiagnostic: () => undefined,
    terminate: () => undefined,
  });
  assert.equal(binding.targetScope, 'physical-device');
  assert.equal(binding.independentlyTargetable, true);
  assert.match(actions[0], /^set:x-rincon-mp3radio:\/\/127\.0\.0\.1:\d+\/research-lab\/stream-one\.aac$/);
  assert.equal(actions[1], 'play');
  assert.equal(updates.at(-1)?.hasBinding, true);
  await transport.stop(binding);
  assert.equal(actions.at(-1), 'stop');
});

test('local transport refuses bonded physical components without coordinator redirection', async () => {
  const resolved = fixture(['RINCON_LEFT', 'RINCON_RIGHT']);
  const transport = new SonosLocalContinuousStreamTransport(async () => resolved);
  await assert.rejects(transport.start({
    device: resolved.device, transport: resolved.device.transports[0], streamId: 'stream-bonded',
    streamUrl: 'https://unused', bindHttpClient: () => undefined,
    updateTransport: () => undefined, addDiagnostic: () => undefined, terminate: () => undefined,
  }), /standalone physical player/i);
});

test('direct physical-device start uses LAN discovery without Sonos Cloud resolution', async () => {
  let cloudResolutionCalls = 0;
  const actions: string[] = [];
  const transport = new SonosLocalContinuousStreamTransport(
    async () => { cloudResolutionCalls += 1; return undefined; },
    async (id) => ({ physicalDeviceId: id, address: '127.0.0.1', descriptionUrl: 'http://127.0.0.1/device.xml', avTransportControlUrl: 'http://127.0.0.1:1400/av' }),
    { async setStreamUri() { actions.push('set'); }, async play() { actions.push('play'); }, async stop() { actions.push('stop'); } }
  );
  const resolved = fixture();
  const context = {
    device: resolved.device, transport: resolved.device.transports[0], streamId: 'room-endpoint', streamUrl: '',
    bindHttpClient: () => undefined, updateTransport: () => undefined,
    addDiagnostic: () => undefined, terminate: () => undefined,
  };
  const binding = await transport.startPhysicalDevice(context, 'RINCON_PLAY1', 'Office');
  assert.equal(cloudResolutionCalls, 0); assert.deepEqual(actions, ['set', 'play']);
  await transport.stop(binding); assert.equal(actions.at(-1), 'stop');
});

test('latency broadcast profiles change the actual URI, MIME, and AVTransport metadata', async () => {
  const resolved = fixture();
  const calls: Array<{ uri: string; metadata: string }> = [];
  const transport = new SonosLocalContinuousStreamTransport(
    async () => resolved,
    async (id) => ({ physicalDeviceId: id, address: '127.0.0.1', descriptionUrl: 'http://127.0.0.1/device.xml', avTransportControlUrl: 'http://127.0.0.1:1400/av' }),
    {
      async setStreamUri(_url, uri, metadata = '') { calls.push({ uri, metadata }); },
      async play() {}, async stop() {},
    }
  );
  for (const profileId of ['wav-broadcast', 'l16-broadcast'] as const) {
    const profile = getSonosLatencyExperimentProfile(profileId);
    assert.ok(profile);
    const binding = await transport.start({
      device: resolved.device, transport: resolved.device.transports[0],
      streamId: `stream-${profileId}`, streamUrl: 'https://unused', latencyProfile: profile,
      bindHttpClient: () => undefined, updateTransport: () => undefined,
      addDiagnostic: () => undefined, terminate: () => undefined,
    });
    const call = calls.at(-1)!;
    assert.match(call.uri, /^http:\/\/127\.0\.0\.1:\d+\/research-lab\//);
    assert.doesNotMatch(call.uri, /^x-rincon-mp3radio:/);
    assert.match(call.metadata, /object\.item\.audioItem\.audioBroadcast/);
    assert.match(call.metadata, new RegExp(profile.mimeType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await transport.stop(binding);
  }
});

test('production physical-device preparation makes only its target standalone before URI assignment', async () => {
  const actions: string[] = [];
  const transport = new SonosLocalContinuousStreamTransport(
    async () => undefined,
    async (id) => ({
      physicalDeviceId: id, address: '127.0.0.1', descriptionUrl: 'http://127.0.0.1/device.xml',
      avTransportControlUrl: `http://127.0.0.1:1400/${id}/av`,
    }),
    {
      async becomeCoordinatorOfStandaloneGroup(url) { actions.push(`standalone:${url}`); },
      async setStreamUri(url) { actions.push(`set:${url}`); },
      async play(url) { actions.push(`play:${url}`); },
      async stop() {},
    }
  );
  const resolved = fixture();
  const context = {
    device: resolved.device, transport: resolved.device.transports[0], streamId: 'production-room-endpoint', streamUrl: '',
    latencyProfile: getSonosLatencyExperimentProfile('aac-radio'),
    bindHttpClient: () => undefined, updateTransport: () => undefined,
    addDiagnostic: () => undefined, terminate: () => undefined,
  };
  const binding = await transport.startPhysicalDevice(
    context, 'RINCON_TARGET', 'Target', { ensureStandalone: true }
  );
  assert.deepEqual(actions.slice(0, 3), [
    'standalone:http://127.0.0.1:1400/RINCON_TARGET/av',
    'set:http://127.0.0.1:1400/RINCON_TARGET/av',
    'play:http://127.0.0.1:1400/RINCON_TARGET/av',
  ]);
  assert(actions.every((entry) => !entry.includes('RINCON_UNRELATED')));
  await transport.stop(binding);
});

test('fast WAV URI assignment waits for the configured settle delay exactly once', async () => {
  const resolved = fixture();
  const calls: string[] = [];
  const diagnostics: Array<{ code?: string; details?: Record<string, unknown> }> = [];
  let setCompletedAt = 0;
  let playStartedAt = 0;
  const transport = new SonosLocalContinuousStreamTransport(
    async () => resolved,
    async (id) => ({ physicalDeviceId: id, address: '127.0.0.1', descriptionUrl: 'http://127.0.0.1/device.xml', avTransportControlUrl: 'http://127.0.0.1:1400/av' }),
    {
      async setStreamUri(_url, uri) { calls.push(`set:${uri}`); setCompletedAt = performance.now(); },
      async play() { calls.push('play'); playStartedAt = performance.now(); },
      async stop() { calls.push('stop'); },
    }
  );
  const profile = getSonosLatencyExperimentProfile('wav-broadcast'); assert.ok(profile);
  const binding = await transport.start({
    device: resolved.device, transport: resolved.device.transports[0],
    streamId: 'settle-250', streamUrl: '', latencyProfile: profile, wavSettleDelayMs: 250,
    bindHttpClient: () => undefined, updateTransport: () => undefined,
    addDiagnostic: (_message, details, code) => diagnostics.push({ code, details }),
    getSnapshot: () => startupSnapshot(), terminate: () => undefined,
  });
  assert.equal(calls.filter((call) => call.startsWith('set:')).length, 1);
  assert.equal(calls.filter((call) => call === 'play').length, 1);
  assert.ok(playStartedAt - setCompletedAt >= 225);
  const experiment = diagnostics.find((entry) => entry.code === 'wav_uri_settle_experiment');
  assert.ok(experiment);
  assert.equal(experiment.details?.classifiedFast, true);
  assert.equal(experiment.details?.configuredSettleDelayMs, 250);
  assert.ok(Number(experiment.details?.actualDelayBeforePlayMs) >= 225);
  await transport.stop(binding);
});

test('AAC startup ignores the WAV settle-delay option', async () => {
  const resolved = fixture();
  let setCompletedAt = 0;
  let playStartedAt = 0;
  const transport = new SonosLocalContinuousStreamTransport(
    async () => resolved,
    async (id) => ({ physicalDeviceId: id, address: '127.0.0.1', descriptionUrl: 'http://127.0.0.1/device.xml', avTransportControlUrl: 'http://127.0.0.1:1400/av' }),
    {
      async setStreamUri() { setCompletedAt = performance.now(); },
      async play() { playStartedAt = performance.now(); }, async stop() {},
    }
  );
  const binding = await transport.start({
    device: resolved.device, transport: resolved.device.transports[0],
    streamId: 'aac-no-settle', streamUrl: '', wavSettleDelayMs: 3_000,
    bindHttpClient: () => undefined, updateTransport: () => undefined,
    addDiagnostic: () => undefined, terminate: () => undefined,
  });
  assert.ok(playStartedAt - setCompletedAt < 100);
  await transport.stop(binding);
});

for (const scenario of [
  { name: 'before an HTTP consumer connects', snapshot: startupSnapshot() },
  { name: 'after startup bytes but before live WAV delivery', snapshot: startupSnapshot({ connected: true, deliveredBytes: 49_230 }) },
] as const) {
  test(`WAV SetAVTransportURI timeout ${scenario.name} remains fatal`, async () => {
    const resolved = fixture();
    let discoveries = 0;
    const transport = new SonosLocalContinuousStreamTransport(
      async () => resolved,
      async (id) => {
        discoveries += 1;
        return { physicalDeviceId: id, address: '127.0.0.1', descriptionUrl: 'http://127.0.0.1/device.xml', avTransportControlUrl: 'http://127.0.0.1:1400/av' };
      },
      { async setStreamUri() { throw timeoutError(); }, async play() {}, async stop() {} }
    );
    const profile = getSonosLatencyExperimentProfile('wav-broadcast'); assert.ok(profile);
    await assert.rejects(transport.start({
      device: resolved.device, transport: resolved.device.transports[0],
      streamId: scenario.snapshot.id, streamUrl: '', latencyProfile: profile,
      bindHttpClient: () => undefined, updateTransport: () => undefined,
      addDiagnostic: () => undefined, getSnapshot: () => scenario.snapshot,
      terminate: () => undefined,
    }), /timeout/i);
    assert.equal(discoveries, 1);
  });
}

test('WAV SetAVTransportURI timeout after stable live delivery preserves the same runtime and consumer', async () => {
  const resolved = fixture();
  const manager = new ContinuousAudioStreamManager();
  const transportRef: { current?: SonosLocalContinuousStreamTransport } = {};
  let streamId = '';
  const stream = manager.create({
    transportId: 'sonos-local-continuous', encodingProfileId: 'wav-pcm', clientReconnectGraceMs: 3_000,
    minimumConnectionsForTone: 1,
    onEvent: (event) => transportRef.current?.handleRuntimeEvent(streamId, event, manager.getSnapshot(streamId)),
  });
  streamId = stream.id;
  let streamUri = '';
  let request: http.ClientRequest | undefined;
  const diagnostics: Array<{ code?: string; details?: Record<string, unknown> }> = [];
  let discoveryCount = 0;
  let playCount = 0;
  const transport = new SonosLocalContinuousStreamTransport(
    async () => resolved,
    async (id) => {
      discoveryCount += 1;
      return { physicalDeviceId: id, address: '127.0.0.1', descriptionUrl: 'http://127.0.0.1/device.xml', avTransportControlUrl: 'http://127.0.0.1:1400/av' };
    },
    {
      async setStreamUri(_url, uri) {
        streamUri = uri;
        request = http.get(streamUri, (response) => response.resume());
        await waitFor(() => manager.getSnapshot(streamId)?.lifecycle === 'running');
        const live = manager.getSnapshot(streamId);
        assert.ok(live);
        transportRef.current?.handleRuntimeEvent(streamId, {
          timestamp: new Date().toISOString(), category: 'http', code: 'first-live-bytes',
          message: 'First live bytes delivered.',
        }, live);
        stream.updateTransport({ state: 'active', providerPlaybackState: 'STREAMING' });
        const proven = stream.getSnapshot();
        assert.equal(proven.httpClient.connected, true);
        assert.ok(proven.httpClient.deliveredBytes > 0);
        assert.equal(proven.transport?.state, 'active');
        assert.equal(proven.transport?.providerPlaybackState, 'STREAMING');
        assert.ok(proven.recentEvents.some((event) => event.code === 'first-live-bytes'));
        throw timeoutError();
      },
      async play() { playCount += 1; },
      async stop() {},
    }
  );
  transportRef.current = transport;
  const profile = getSonosLatencyExperimentProfile('wav-broadcast'); assert.ok(profile);
  try {
    stream.start();
    await stream.waitUntilReadyForClient();
    const encoderPid = stream.getSnapshot().encoder.pid;
    const binding = await transport.startPhysicalDevice({
      device: resolved.device, transport: resolved.device.transports[0], streamId,
      streamUrl: '', latencyProfile: profile,
      bindHttpClient: (client, metadata) => stream.bindHttpClient(client, metadata),
      updateTransport: (update, message) => stream.updateTransport(update, message),
      addDiagnostic: (_message, details, code) => diagnostics.push({ code, details }),
      getSnapshot: () => stream.getSnapshot(), terminate: () => undefined,
    }, 'RINCON_PLAY1', 'PLAY:1');
    const established = stream.getSnapshot();
    assert.equal(established.lifecycle, 'running');
    assert.equal(established.transport?.state, 'active');
    assert.equal(established.transport?.providerPlaybackState, 'STREAMING');
    assert.equal(established.httpClient.connected, true);
    assert.equal(established.httpClient.currentConnectionOrdinal, 1);
    assert.equal(established.httpClient.awaitingReconnect, false);
    assert.equal(established.encoder.pid, encoderPid);
    assert.equal(discoveryCount, 1);
    assert.equal(playCount, 0);
    const ignored = diagnostics.find((entry) => entry.code === 'wav_set_uri_timeout_ignored_after_live_delivery');
    assert.ok(ignored);
    assert.equal(ignored.details?.streamId, streamId);
    assert.equal(ignored.details?.connectionOrdinal, 1);
    assert.ok(Number(ignored.details?.deliveredBytes) > 0);
    stream.injectTestTone({ acceptStableInitialConsumer: true });
    await waitFor(() => stream.getSnapshot().recentEvents.some((event) => event.code === 'tone-completed'));
    const afterTone = stream.getSnapshot();
    assert.equal(afterTone.encoder.pid, encoderPid);
    assert.equal(afterTone.httpClient.currentConnectionOrdinal, 1);
    assert.equal(afterTone.httpClient.awaitingReconnect, false);
    await transport.stop(binding);
  } finally {
    request?.destroy();
    manager.stop(streamId, 'test complete');
  }
});
