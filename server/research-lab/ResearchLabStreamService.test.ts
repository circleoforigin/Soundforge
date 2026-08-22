import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { AudioDevice } from '../../src/models/ResearchLab.ts';
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

  async start(context: ContinuousStreamTransportContext): Promise<ContinuousStreamTransportBinding> {
    this.started.push(context.streamId);
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
    this.stopped.push((binding.providerBinding as { mock: string }).mock);
    if (this.failStop) {
      throw new Error('Mock provider stop failed.');
    }
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

test('stop tears down provider first and retains local final state', async () => {
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
