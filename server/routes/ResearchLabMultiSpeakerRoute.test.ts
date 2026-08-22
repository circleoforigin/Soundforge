import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import type { MultiSpeakerSessionSnapshot } from '../../src/models/ResearchLab.ts';
import type { MultiSpeakerSessionService } from '../research-lab/MultiSpeakerSessionService.ts';
import { registerResearchLabMultiSpeakerRoute } from './ResearchLabMultiSpeakerRoute.ts';

const stoppedSession: MultiSpeakerSessionSnapshot = {
  id: 'session with opaque/id',
  state: 'stopped',
  participants: [],
  recentEvents: [],
  lastSimultaneousResult: null,
  lastMigrationResult: null,
  teardown: {
    sessionId: 'session with opaque/id',
    participantA: { stopped: true, transportStopped: true, listenerClosed: true, encoderStopped: true },
    participantB: { stopped: true, transportStopped: true, listenerClosed: true, encoderStopped: true },
    pendingEventsCancelled: 2,
  },
};

const migrationSession: MultiSpeakerSessionSnapshot = {
  ...stoppedSession,
  state: 'ready',
  teardown: null,
  lastMigrationResult: {
    eventId: 'migration-event', direction: 'A-to-B', targetMonotonicTime: 123,
    frequencyHz: 880, durationMs: 8_000, curve: 'equal-power',
    aActualStart: null, bActualStart: null, aScheduleErrorMs: null,
    bScheduleErrorMs: null, sourceGenerationSkewMs: null, status: 'scheduled',
  },
};

test('Stop All route waits for teardown and returns a normal JSON response', async () => {
  const app = express();
  let stopCompleted = false;
  const service = {
    runMigration(sessionId: string) {
      assert.equal(sessionId, stoppedSession.id);
      return migrationSession;
    },
    async stop(sessionId: string) {
      assert.equal(sessionId, stoppedSession.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      stopCompleted = true;
      return stoppedSession;
    },
  } as MultiSpeakerSessionService;
  registerResearchLabMultiSpeakerRoute(app, service);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const migrationResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/research-lab/multi-speaker-sessions/${encodeURIComponent(stoppedSession.id)}/migration`,
      { method: 'POST' }
    );
    assert.equal(migrationResponse.status, 200);
    assert.deepEqual(await migrationResponse.json(), { ok: true, session: migrationSession });

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/research-lab/multi-speaker-sessions/${encodeURIComponent(stoppedSession.id)}`,
      { method: 'DELETE' }
    );
    assert.equal(stopCompleted, true);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, session: stoppedSession });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
