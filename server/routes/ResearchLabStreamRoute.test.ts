import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type {
  AudioStreamListResponse,
  AudioStreamSnapshotResponse,
} from '../../src/models/ResearchLab.ts';
import { ContinuousAudioStreamManager } from '../audio/ContinuousAudioStreamManager.ts';
import { ContinuousStreamTransportRegistry } from '../audio/transports/ContinuousStreamTransportRegistry.ts';
import { ResearchLabStreamService } from '../research-lab/ResearchLabStreamService.ts';
import { registerResearchLabStreamRoute } from './ResearchLabStreamRoute.ts';

test('Research Lab stream diagnostics routes return list, snapshot, and not-found responses', async () => {
  const manager = new ContinuousAudioStreamManager();
  const stream = manager.create({ deviceId: 'route-test-device' });
  const service = new ResearchLabStreamService(
    manager,
    new ContinuousStreamTransportRegistry(),
    async () => []
  );
  const app = express();
  registerResearchLabStreamRoute(app, { manager, service });
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const listResponse = await fetch(`${baseUrl}/api/research-lab/streams`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as AudioStreamListResponse;
    assert.equal(list.ok, true);
    assert.ok(list.streams.some((candidate) => candidate.id === stream.id));

    const snapshotResponse = await fetch(
      `${baseUrl}/api/research-lab/streams/${encodeURIComponent(stream.id)}`
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json() as AudioStreamSnapshotResponse;
    assert.equal(snapshot.stream.id, stream.id);
    assert.equal(snapshot.stream.deviceId, 'route-test-device');

    const missingResponse = await fetch(
      `${baseUrl}/api/research-lab/streams/missing-stream`
    );
    assert.equal(missingResponse.status, 404);
  } finally {
    manager.stopAll('route test cleanup');
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
