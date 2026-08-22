import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { AudioDevice } from '../../src/models/ResearchLab.ts';
import { ContinuousAudioStreamManager } from '../audio/ContinuousAudioStreamManager.ts';
import {
  MultiSpeakerSessionService,
  multiSpeakerAlternatingIntervalMs,
  multiSpeakerMigrationDurationMs,
  multiSpeakerMigrationFrequencyHz,
} from './MultiSpeakerSessionService.ts';
import type { ResearchLabStreamService } from './ResearchLabStreamService.ts';

function device(id: string, eligible = true): AudioDevice {
  return { id, provider: 'sonos', name: id,
    identity: { providerIdentifierSuffix: id, logicalPlayerName: id },
    capabilities: ['continuous-stream'], diagnosticActions: [], topology: [], transports: [{
      id: 'sonos-local-continuous', name: 'Local continuous', operation: 'persistent-stream',
      scope: 'physical-device', independentlyTargetable: eligible, availability: 'experimental',
    }] };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for multi-speaker test state.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function harness(devices: AudioDevice[]) {
  const manager = new ContinuousAudioStreamManager();
  const clients = new Map<string, PassThrough>();
  const fake = {
    manager,
    async start(deviceId: string) {
      const stream = manager.create({ deviceId, transportId: 'sonos-local-continuous', encodingProfileId: 'aac-adts' });
      const client = new PassThrough(); client.resume(); clients.set(stream.id, client);
      stream.bindHttpClient(client);
      await waitFor(() => stream.isReadyForTone());
      stream.updateTransport({ state: 'active', targetScope: 'physical-device', targetDescription: deviceId,
        independentlyTargetable: true, bound: true, hasBinding: true,
        providerPlaybackState: 'STREAMING', lastError: null });
      return stream.getSnapshot();
    },
    async stop(streamId: string) {
      clients.get(streamId)?.destroy(); clients.delete(streamId);
      manager.stop(streamId, 'test Stop All');
      return { snapshot: manager.getSnapshot(streamId)!, cleanup: {
        runtimeStopped: true, encoderStopped: true, transportStopped: true, listenerClosed: true,
      } };
    },
  };
  return { manager, clients,
    service: new MultiSpeakerSessionService(fake as unknown as ResearchLabStreamService, async () => devices) };
}

test('rejects duplicate and ineligible multi-speaker selections', async () => {
  const a = device('speaker-a'); const bonded = device('bonded', false);
  const { service } = harness([a, bonded]);
  await assert.rejects(service.create(a.id, a.id, () => 'unused'), /must be different/i);
  await assert.rejects(service.create(a.id, bonded.id, () => 'unused'), /not independently targetable/i);
});

test('session owns two runtimes and schedules simultaneous and alternating events', async () => {
  const a = device('speaker-a'); const b = device('speaker-b');
  const { service, manager, clients } = harness([a, b]);
  const created = await service.create(a.id, b.id, () => 'unused');
  const ready = service.get(created.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.participants.length, 2);
  assert.notEqual(ready.participants[0].streamId, ready.participants[1].streamId);
  assert.notEqual(ready.participants[0].encoderPid, ready.participants[1].encoderPid);

  service.runSimultaneous(ready.id);
  await waitFor(() => service.get(ready.id).lastSimultaneousResult?.sourceGenerationSkewMs !== null);
  const simultaneous = service.get(ready.id).lastSimultaneousResult!;
  assert.ok(simultaneous.aActualStart !== null && simultaneous.bActualStart !== null);
  assert.ok(simultaneous.sourceGenerationSkewMs! <= 20);
  assert.ok(service.get(ready.id).recentEvents.some((event) => event.message === 'Source-generation skew measured.'));
  const streams = ready.participants.map((participant) => manager.getSnapshot(participant.streamId)!);
  assert.equal(streams[0].scheduledEvents[0].eventId, streams[1].scheduledEvents[0].eventId);
  assert.equal(streams[0].scheduledEvents[0].targetMonotonicTime, streams[1].scheduledEvents[0].targetMonotonicTime);

  service.runAlternating(ready.id);
  const aEvents = manager.getSnapshot(ready.participants[0].streamId)!.scheduledEvents.slice(1);
  const bEvents = manager.getSnapshot(ready.participants[1].streamId)!.scheduledEvents.slice(1);
  const ordered = [...aEvents.map((event) => ({ slot: 'A', time: event.targetMonotonicTime })),
    ...bEvents.map((event) => ({ slot: 'B', time: event.targetMonotonicTime }))]
    .sort((left, right) => left.time - right.time);
  assert.deepEqual(ordered.map((event) => event.slot), ['A', 'B', 'A', 'B']);
  assert.equal(ordered[1].time - ordered[0].time, multiSpeakerAlternatingIntervalMs);

  const stopped = await service.stop(ready.id);
  assert.equal(stopped.state, 'stopped');
  assert.equal(manager.getActive(ready.participants[0].streamId), undefined);
  assert.equal(manager.getActive(ready.participants[1].streamId), undefined);
  assert.equal(clients.size, 0);
  assert.equal(stopped.teardown?.pendingEventsCancelled, 4);
  assert.deepEqual(stopped.teardown?.participantA, {
    stopped: true, transportStopped: true, listenerClosed: true, encoderStopped: true,
  });

  const stoppedAgain = await service.stop(ready.id);
  assert.deepEqual(stoppedAgain.teardown, stopped.teardown);
});

test('Stop All remains successful when one participant is already stopped', async () => {
  const a = device('speaker-a'); const b = device('speaker-b');
  const { service, manager, clients } = harness([a, b]);
  const session = service.get((await service.create(a.id, b.id, () => 'unused')).id);
  const first = session.participants[0];
  clients.get(first.streamId)?.destroy(); clients.delete(first.streamId);
  manager.stop(first.streamId, 'participant disconnected before Stop All');

  const stopped = await service.stop(session.id);

  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.teardown?.participantA.stopped, true);
  assert.equal(stopped.teardown?.participantB.stopped, true);
  assert.equal(manager.getActive(session.participants[1].streamId), undefined);
});

test('migration schedules one shared equal-power A-to-B source and Stop All cancels it', async () => {
  const a = device('speaker-a'); const b = device('speaker-b');
  const { service, manager } = harness([a, b]);
  const ready = service.get((await service.create(a.id, b.id, () => 'unused')).id);
  const migration = service.runMigration(ready.id);
  const result = migration.lastMigrationResult;
  assert.ok(result);
  assert.equal(result.direction, 'A-to-B');
  assert.equal(result.frequencyHz, multiSpeakerMigrationFrequencyHz);
  assert.equal(result.durationMs, multiSpeakerMigrationDurationMs);

  const events = ready.participants.map((participant) =>
    manager.getSnapshot(participant.streamId)?.scheduledEvents.find((event) => event.eventId === result.eventId)
  );
  assert.ok(events[0] && events[1]);
  assert.equal(events[0].eventId, events[1].eventId);
  assert.equal(events[0].targetMonotonicTime, events[1].targetMonotonicTime);
  assert.equal(events[0].frequencyHz, events[1].frequencyHz);
  assert.equal(events[0].durationMs, events[1].durationMs);
  assert.deepEqual(events[0].gainEnvelope, { startGain: 1, endGain: 0, curve: 'equal-power' });
  assert.deepEqual(events[1].gainEnvelope, { startGain: 0, endGain: 1, curve: 'equal-power' });
  assert.ok(migration.recentEvents.some((event) => event.message === 'Audio migration A → B scheduled.'));

  const stopped = await service.stop(ready.id);
  assert.equal(stopped.lastMigrationResult?.status, 'cancelled');
  assert.equal(stopped.teardown?.pendingEventsCancelled, 2);
});

test('migration requires both participants to be ready', async () => {
  const a = device('speaker-a'); const b = device('speaker-b');
  const manager = new ContinuousAudioStreamManager();
  const fake = {
    manager,
    async start(deviceId: string) {
      return manager.create({ deviceId, transportId: 'sonos-local-continuous', encodingProfileId: 'aac-adts' }).getSnapshot();
    },
  };
  const service = new MultiSpeakerSessionService(fake as unknown as ResearchLabStreamService, async () => [a, b]);
  const session = await service.create(a.id, b.id, () => 'unused');
  assert.throws(() => service.runMigration(session.id), /both participants must be actively streaming/i);
  manager.stopAll('migration readiness test cleanup');
});

test('migration records participant starts, skew, completion, and returns both streams to silence', async () => {
  const a = device('speaker-a'); const b = device('speaker-b');
  const { service, manager } = harness([a, b]);
  const ready = service.get((await service.create(a.id, b.id, () => 'unused')).id);
  service.runMigration(ready.id);

  await waitFor(() => service.get(ready.id).lastMigrationResult?.status === 'completed', 10_000);
  const completed = service.get(ready.id);
  assert.ok(completed.lastMigrationResult?.sourceGenerationSkewMs !== null);
  assert.ok(completed.recentEvents.some((event) => event.message === 'Participant A migration source began.'));
  assert.ok(completed.recentEvents.some((event) => event.message === 'Participant B migration source began.'));
  assert.ok(completed.recentEvents.some((event) => event.message === 'Audio migration completed.'));
  for (const participant of completed.participants) {
    assert.equal(manager.getSnapshot(participant.streamId)?.source, 'silence');
  }
  await service.stop(ready.id);
});

test('session remains starting until both participants are genuinely active', async () => {
  const a = device('speaker-a'); const b = device('speaker-b');
  const manager = new ContinuousAudioStreamManager();
  const fake = {
    manager,
    async start(deviceId: string) {
      return manager.create({ deviceId, transportId: 'sonos-local-continuous', encodingProfileId: 'aac-adts' }).getSnapshot();
    },
    async stop(streamId: string) { manager.stop(streamId, 'test stop'); return { snapshot: manager.getSnapshot(streamId)!, cleanup: { runtimeStopped: true, encoderStopped: true, transportStopped: true, listenerClosed: true } }; },
  };
  const service = new MultiSpeakerSessionService(fake as unknown as ResearchLabStreamService, async () => [a, b]);
  const session = await service.create(a.id, b.id, () => 'unused');
  assert.equal(session.state, 'starting');
  await service.stop(session.id);
});

test('participant startup failure is attributed and leaves a stoppable degraded session', async () => {
  const a = device('speaker-a'); const b = device('speaker-b');
  const manager = new ContinuousAudioStreamManager();
  const fake = {
    manager,
    async start(deviceId: string) {
      if (deviceId === b.id) throw new Error('B transport failed');
      return manager.create({ deviceId, transportId: 'sonos-local-continuous', encodingProfileId: 'aac-adts' }).getSnapshot();
    },
    async stop(streamId: string) { manager.stop(streamId, 'test stop'); return { snapshot: manager.getSnapshot(streamId)!, cleanup: { runtimeStopped: true, encoderStopped: true, transportStopped: true, listenerClosed: true } }; },
  };
  const service = new MultiSpeakerSessionService(fake as unknown as ResearchLabStreamService, async () => [a, b]);
  const session = await service.create(a.id, b.id, () => 'unused');
  assert.equal(session.state, 'degraded');
  assert.match(session.recentEvents.find((event) => /Participant B failed/.test(event.message))?.details?.error as string, /B transport failed/);
  assert.equal((await service.stop(session.id)).state, 'stopped');
});
