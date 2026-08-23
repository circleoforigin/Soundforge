import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { AudioDevice } from '../../src/models/ResearchLab.ts';
import type { DiagnosticLogInput } from '../../src/models/DiagnosticLog.ts';
import { ContinuousAudioStreamManager } from '../audio/ContinuousAudioStreamManager.ts';
import type {
  ContinuousStreamTransport,
  ContinuousStreamTransportBinding,
  ContinuousStreamTransportContext,
} from '../audio/transports/ContinuousStreamTransport.ts';
import { ContinuousStreamTransportRegistry } from '../audio/transports/ContinuousStreamTransportRegistry.ts';
import {
  ResearchLabRequestError,
  ResearchLabStreamService,
} from './ResearchLabStreamService.ts';

function device(
  id: string,
  independentlyTargetable: boolean,
  availability: 'available' | 'experimental' = 'available'
): AudioDevice {
  return {
    id,
    provider: 'sonos',
    name: id,
    identity: {
      providerIdentifierSuffix: id,
      logicalPlayerName: id,
    },
    capabilities: ['continuous-stream'],
    diagnosticActions: [],
    topology: [],
    transports: [{
      id: availability === 'experimental'
        ? 'sonos-local-continuous'
        : 'sonos-cloud-continuous',
      name: 'Test transport',
      operation: 'persistent-stream',
      scope: availability === 'experimental' ? 'physical-device' : 'group',
      independentlyTargetable,
      availability,
      ...(availability === 'experimental' ? { limitation: 'Not implemented.' } : {}),
    }],
  };
}

class MockTransport implements ContinuousStreamTransport {
  readonly id = 'sonos-cloud-continuous';
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  failStop = false;
  terminateOnStop = false;
  private readonly contexts = new Map<string, ContinuousStreamTransportContext>();

  async start(context: ContinuousStreamTransportContext): Promise<ContinuousStreamTransportBinding> {
    this.started.push(context.streamId);
    this.contexts.set(context.streamId, context);
    context.updateTransport({
      state: 'bound',
      targetScope: 'group',
      targetDescription: `Group for ${context.device.name}`,
      independentlyTargetable: context.transport.independentlyTargetable,
      bound: true,
      hasBinding: true,
      providerPlaybackState: 'PLAYBACK_STATE_BUFFERING',
    });
    return {
      transportId: this.id,
      targetScope: 'group',
      targetDescription: `Group for ${context.device.name}`,
      independentlyTargetable: context.transport.independentlyTargetable,
      providerBinding: { mock: context.streamId },
    };
  }

  async stop(binding: ContinuousStreamTransportBinding): Promise<void> {
    const streamId = (binding.providerBinding as { mock: string }).mock;
    this.stopped.push(streamId);
    if (this.terminateOnStop) this.contexts.get(streamId)?.terminate('Provider listener closed.');
    if (this.failStop) {
      throw new Error('Mock provider stop failed.');
    }
  }
}

class LatencyCaptureTransport implements ContinuousStreamTransport {
  readonly id = 'sonos-local-continuous';
  readonly encodingProfileId = 'aac-adts' as const;
  readonly minimumConnectionsForTone = 2;
  readonly clients = new Map<string, PassThrough>();
  readonly receivedLatencyProfiles: Array<string | null> = [];

  async start(context: ContinuousStreamTransportContext): Promise<ContinuousStreamTransportBinding> {
    this.receivedLatencyProfiles.push(context.latencyProfile?.id ?? null);
    const client = new PassThrough();
    client.resume();
    this.clients.set(context.streamId, client);
    context.bindHttpClient(client);
    context.updateTransport({
      state: 'active', targetScope: 'physical-device', targetDescription: context.device.name,
      independentlyTargetable: true, bound: true, hasBinding: true,
    });
    return {
      transportId: this.id, targetScope: 'physical-device',
      targetDescription: context.device.name, independentlyTargetable: true,
      providerBinding: { streamId: context.streamId, httpUrl: `http://127.0.0.1/${context.streamId}` },
    };
  }

  async stop(binding: ContinuousStreamTransportBinding): Promise<void> {
    const streamId = (binding.providerBinding as { streamId: string }).streamId;
    this.clients.get(streamId)?.destroy();
    this.clients.delete(streamId);
  }
}

function createService(devices: AudioDevice[]): {
  manager: ContinuousAudioStreamManager;
  transport: MockTransport;
  service: ResearchLabStreamService;
} {
  const manager = new ContinuousAudioStreamManager();
  const transport = new MockTransport();
  const registry = new ContinuousStreamTransportRegistry();
  registry.register(transport);
  return {
    manager,
    transport,
    service: new ResearchLabStreamService(manager, registry, async () => devices),
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMilliseconds = 4_000
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for Research Lab stream state.');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('generic creation binds device and group-scoped transport metadata', async () => {
  const bonded = device('bonded-device', false);
  const standalone = device('standalone-device', true);
  const { manager, transport, service } = createService([bonded, standalone]);
  try {
    const bondedSnapshot = await service.start(
      bonded.id,
      'sonos-cloud-continuous',
      (id) => `https://example.test/api/research-lab/streams/${id}/live.mp3`
    );
    const standaloneSnapshot = await service.start(
      standalone.id,
      'sonos-cloud-continuous',
      (id) => `https://example.test/api/research-lab/streams/${id}/live.mp3`,
      'indefinite-content-length'
    );

    assert.equal(bondedSnapshot.deviceId, bonded.id);
    assert.equal(bondedSnapshot.transportId, 'sonos-cloud-continuous');
    assert.equal(bondedSnapshot.transport?.targetScope, 'group');
    assert.equal(bondedSnapshot.transport?.independentlyTargetable, false);
    assert.equal(standaloneSnapshot.transport?.independentlyTargetable, true);
    assert.equal(standaloneSnapshot.httpClient.framingMode, 'indefinite-content-length');
    assert.equal(transport.started.length, 2);
    assert.equal(bondedSnapshot.encoder.startupBufferReady, true);
    const readyIndex = bondedSnapshot.recentEvents.findIndex(
      (event) => event.code === 'startup-buffer-ready'
    );
    const attachIndex = bondedSnapshot.recentEvents.findIndex(
      (event) => event.code === 'transport-attachment-begin'
    );
    assert.ok(readyIndex >= 0 && attachIndex > readyIndex);
  } finally {
    manager.stopAll('creation test cleanup');
  }
});

test('tone and transport diagnostics remain isolated per stream', async () => {
  const first = device('first-device', false);
  const second = device('second-device', false);
  const { manager, service } = createService([first, second]);
  const clients: PassThrough[] = [];
  try {
    const snapshotA = await service.start(
      first.id,
      'sonos-cloud-continuous',
      () => 'https://a',
      'indefinite-content-length'
    );
    const snapshotB = await service.start(second.id, 'sonos-cloud-continuous', () => 'https://b');
    for (const streamId of [snapshotA.id, snapshotB.id]) {
      const client = new PassThrough();
      client.resume();
      clients.push(client);
      manager.getActive(streamId)?.bindHttpClient(client);
    }

    await waitFor(() => Boolean(
      manager.getActive(snapshotA.id)?.isReadyForTone() &&
      manager.getActive(snapshotB.id)?.isReadyForTone()
    ));
    const toneA = service.injectTone(snapshotA.id);
    assert.equal(toneA.source, 'test-tone');
    assert.equal(manager.getSnapshot(snapshotB.id)?.source, 'silence');
    assert.equal(manager.getSnapshot(snapshotB.id)?.deviceId, second.id);
  } finally {
    for (const client of clients) {
      client.destroy();
    }
    manager.stopAll('tone test cleanup');
  }
});

test('Latency Lab request resolves and mutates the exact connected runtime', async () => {
  const target = device('latency-physical-device', true, 'experimental');
  target.identity.providerIdentifier = 'RINCON_LATENCY_TEST';
  const manager = new ContinuousAudioStreamManager();
  const transport = new LatencyCaptureTransport();
  const registry = new ContinuousStreamTransportRegistry();
  registry.register(transport);
  const service = new ResearchLabStreamService(manager, registry, async () => [target]);
  try {
    const started = await service.start(
      target.id, transport.id, (id) => `http://127.0.0.1/${id}`, 'chunked', 'aac-radio'
    );
    await waitFor(() => manager.getSnapshot(started.id)?.lifecycle === 'running');
    const before = manager.getSnapshot(started.id);
    const response = service.injectLatencyTone(started.id, {
      correlationId: 'hardware-path-test', uiStreamId: started.id,
      profileId: 'aac-radio', deviceId: target.id,
    });
    assert.equal(response.id, started.id);
    await waitFor(() => Boolean(manager.getSnapshot(started.id)?.recentEvents.some(
      (event) => event.code === 'latency_lab.tone_output_verified'
    )));
    const after = manager.getSnapshot(started.id);
    assert.equal(after?.encoder.pid, before?.encoder.pid);
    assert.equal(after?.httpClient.currentConnectionOrdinal, 1);
    const codes = after?.recentEvents.map((event) => event.code) ?? [];
    for (const code of [
      'latency_lab.route_tone_request_received',
      'latency_lab.tone_readiness_checked',
      'latency_lab.tone_state_before',
      'latency_lab.tone_requested',
      'latency_lab.tone_state_after_request',
      'latency_lab.tone_pcm_verified',
      'latency_lab.tone_output_verified',
    ]) assert.ok(codes.includes(code), `missing ${code}`);
    const identity = after?.recentEvents.find(
      (event) => event.code === 'latency_lab.route_tone_request_received'
    );
    assert.equal(identity?.details?.identityMatches, true);
    assert.equal(identity?.details?.runtimeStreamId, started.id);
    assert.equal(identity?.details?.transportStreamId, started.id);
  } finally {
    manager.stopAll('latency identity test cleanup');
    for (const client of transport.clients.values()) client.destroy();
  }
});

test('Known Working Baseline takes the literal normal Sonos Local transport-start path', async () => {
  const target = device('baseline-device', true, 'experimental');
  const manager = new ContinuousAudioStreamManager();
  const transport = new LatencyCaptureTransport();
  const registry = new ContinuousStreamTransportRegistry();
  registry.register(transport);
  const service = new ResearchLabStreamService(manager, registry, async () => [target]);
  try {
    const baseline = await service.start(
      target.id, transport.id, (id) => `http://127.0.0.1/${id}`,
      'chunked', 'known-working-baseline'
    );
    assert.deepEqual(transport.receivedLatencyProfiles, [null]);
    assert.equal(baseline.encoder.codec, 'aac-lc');
    assert.ok(baseline.latencyLabSessionId);
  } finally {
    manager.stopAll('known baseline test cleanup');
    for (const client of transport.clients.values()) client.destroy();
  }
});

test('Latency Lab runtime events flow into the general diagnostic log with session identity', async () => {
  const target = device('diagnostic-baseline-device', true, 'experimental');
  target.identity.providerIdentifier = 'RINCON_DIAGNOSTIC';
  const manager = new ContinuousAudioStreamManager();
  const transport = new LatencyCaptureTransport();
  const registry = new ContinuousStreamTransportRegistry();
  registry.register(transport);
  const entries: DiagnosticLogInput[] = [];
  const service = new ResearchLabStreamService(
    manager, registry, async () => [target],
    { record: async (entry) => { entries.push(entry); return null; } }
  );
  try {
    const started = await service.start(
      target.id, transport.id, (id) => `http://127.0.0.1/${id}`,
      'chunked', 'known-working-baseline'
    );
    await waitFor(() => manager.getSnapshot(started.id)?.lifecycle === 'running');
    service.injectLatencyTone(started.id, {
      correlationId: 'diagnostic-correlation', uiStreamId: started.id,
      profileId: 'known-working-baseline', deviceId: target.id,
    });
    await waitFor(() => entries.some((entry) => entry.event === 'latency_lab.tone_output_verified'));
    const chain = entries.filter((entry) => entry.event.startsWith('latency_lab.'));
    assert.ok(chain.some((entry) => entry.event === 'latency_lab.live_stream_identity'));
    assert.ok(chain.some((entry) => entry.event === 'latency_lab.tone_output_verified'));
    for (const entry of chain) {
      assert.equal(entry.details?.latencyLabSessionId, started.latencyLabSessionId);
      assert.equal(entry.details?.streamId, started.id);
      assert.equal(entry.details?.profileId, 'known-working-baseline');
      assert.equal(entry.details?.physicalDeviceId, 'RINCON_DIAGNOSTIC');
    }
  } finally {
    manager.stopAll('diagnostic bridge test cleanup');
    for (const client of transport.clients.values()) client.destroy();
  }
});

test('disconnecting one HTTP consumer tears down only its own stream', async () => {
  const first = device('disconnect-first', false);
  const second = device('disconnect-second', false);
  const { manager, service } = createService([first, second]);
  const clientA = new PassThrough();
  const clientB = new PassThrough();
  clientA.resume();
  clientB.resume();

  try {
    const snapshotA = await service.start(
      first.id,
      'sonos-cloud-continuous',
      () => 'https://a',
      'indefinite-content-length'
    );
    const snapshotB = await service.start(second.id, 'sonos-cloud-continuous', () => 'https://b');
    manager.getActive(snapshotA.id)?.bindHttpClient(clientA);
    manager.getActive(snapshotB.id)?.bindHttpClient(clientB);
    await waitFor(() => Boolean(
      manager.getActive(snapshotA.id)?.isReadyForTone() &&
      manager.getActive(snapshotB.id)?.isReadyForTone()
    ));

    const secondPid = manager.getSnapshot(snapshotB.id)?.encoder.pid;
    clientA.destroy();
    await waitFor(() => !manager.getActive(snapshotA.id));

    assert.equal(manager.getSnapshot(snapshotA.id)?.lifecycle, 'stopped');
    assert.equal(
      manager.getSnapshot(snapshotA.id)?.httpClient.framingMode,
      'indefinite-content-length'
    );
    assert.equal(manager.getSnapshot(snapshotB.id)?.lifecycle, 'running');
    assert.equal(manager.getSnapshot(snapshotB.id)?.encoder.pid, secondPid);
    assert.equal(manager.getActive(snapshotB.id)?.isReadyForTone(), true);
  } finally {
    clientA.destroy();
    clientB.destroy();
    manager.stopAll('disconnect isolation test cleanup');
  }
});

test('stop retires the runtime before provider listener cleanup and retains final state', async () => {
  const target = device('stop-device', true);
  const { manager, transport, service } = createService([target]);
  const snapshot = await service.start(target.id, transport.id, () => 'https://stream');
  const result = await service.stop(snapshot.id);

  assert.deepEqual(transport.stopped, [snapshot.id]);
  assert.equal(result.transportError, undefined);
  assert.equal(result.snapshot.lifecycle, 'stopped');
  assert.equal(result.snapshot.transport?.state, 'stopped');
  assert.equal(manager.getActive(snapshot.id), undefined);
  assert.equal(manager.getSnapshot(snapshot.id)?.lifecycle, 'stopped');
});

test('provider disconnect callback during explicit stop cannot start duplicate teardown', async () => {
  const target = device('disconnect-during-stop', true);
  const { transport, service } = createService([target]);
  transport.terminateOnStop = true;
  const snapshot = await service.start(target.id, transport.id, () => 'https://stream');

  const result = await service.stop(snapshot.id);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(transport.stopped, [snapshot.id]);
  assert.equal(result.cleanup.runtimeStopped, true);
  assert.equal(result.cleanup.encoderStopped, true);
  assert.equal(result.cleanup.transportStopped, true);
  assert.equal(result.cleanup.listenerClosed, true);
});

test('provider stop failure still stops and retains local runtime', async () => {
  const target = device('partial-stop-device', true);
  const { manager, transport, service } = createService([target]);
  transport.failStop = true;
  const snapshot = await service.start(target.id, transport.id, () => 'https://stream');
  const result = await service.stop(snapshot.id);

  assert.equal(result.transportError, 'Mock provider stop failed.');
  assert.equal(result.snapshot.lifecycle, 'stopped');
  assert.equal(result.snapshot.transport?.state, 'error');
  assert.equal(manager.getActive(snapshot.id), undefined);
});

test('experimental transport without a registered implementation is rejected before creating a stream', async () => {
  const target = device('experimental-device', true, 'experimental');
  const { manager, service } = createService([target]);

  await assert.rejects(
    service.start(target.id, 'sonos-local-continuous', () => 'https://unused'),
    (error: unknown) => error instanceof ResearchLabRequestError && error.status === 501
  );
  assert.equal(manager.listSnapshots().length, 0);
});
