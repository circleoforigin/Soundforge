import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { registerSonosGroupStreamRoute } from './SonosGroupStreamRoute.ts';

test('legacy group-stream tone endpoint retains its disconnected compatibility response', async () => {
  const app = express();
  registerSonosGroupStreamRoute(app);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/sonos/group-stream-test/test-group/tone`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    );
    assert.equal(response.status, 409);
    const body = await response.json() as { message?: string };
    assert.match(body.message ?? '', /not currently connected/i);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
