import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { registerRoomAudioRoute } from './RoomAudioRoute.ts';

test('Room Audio route forwards provider-neutral session and source intent', async () => {
  const calls: string[] = [];
  const manager = {
    async start(request: { roomId: string }) { calls.push(`start:${request.roomId}`); return { roomId: request.roomId, state: 'ready' }; },
    get(roomId: string) { return { roomId, state: 'ready' }; },
    async stop(roomId: string) { calls.push(`stop:${roomId}`); return true; },
    async addSource(roomId: string) { calls.push(`source:${roomId}`); return { playbackId: 'playback-1' }; },
    updateSource(_roomId: string, playbackId: string) { calls.push(`update:${playbackId}`); return { playbackId }; },
    stopSource(_roomId: string, playbackId: string) { calls.push(`stop-source:${playbackId}`); return true; },
  };
  const app = express(); registerRoomAudioRoute(app, manager as never);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo; const base = `http://127.0.0.1:${port}/api/audio/rooms/room`;
    assert.equal((await fetch(`${base}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 201);
    assert.equal((await fetch(`${base}/sources`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 201);
    assert.equal((await fetch(`${base}/sources/playback-1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    assert.equal((await fetch(`${base}/sources/playback-1`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/session`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(calls, ['start:room', 'source:room', 'update:playback-1', 'stop-source:playback-1', 'stop:room']);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('Room Audio PATCH returns 404 and preserves the manager error message', async () => {
  const manager = { updateSource() { throw new Error('Room audio source not found.'); } };
  const app = express(); registerRoomAudioRoute(app, manager as never);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/audio/rooms/room/sources/missing`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { message: 'Room audio source not found.' });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
