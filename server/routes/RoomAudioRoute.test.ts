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

test('Room Audio volume routes use the active session endpoints and report partial failure', async () => {
  const endpoints = [{ endpointId: 'north', providerId: 'sonos', enabled: true }];
  const calls: Array<{ operation: string; volume?: number; endpoints: unknown[] }> = [];
  const manager = { get() { return { endpoints }; } };
  const volumeService = {
    async initialize(received: unknown[]) { calls.push({ operation: 'initialize', endpoints: received }); return { volume: 25, targetedSpeakerCount: 1, updatedSpeakerCount: 1, failures: [] }; },
    async set(received: unknown[], volume: number) {
      calls.push({ operation: 'set', endpoints: received, volume });
      return { volume, targetedSpeakerCount: 1, updatedSpeakerCount: 0, failures: [{ endpointId: 'north' }] };
    },
  };
  const app = express(); registerRoomAudioRoute(app, manager as never, volumeService as never);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo; const url = `http://127.0.0.1:${port}/api/audio/rooms/room/volume`;
    const read = await fetch(url); assert.equal(read.status, 200); assert.equal((await read.json() as { volume: number }).volume, 25);
    const write = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: 60 }) });
    assert.equal(write.status, 502);
    assert.match((await write.json() as { message: string }).message, /could not be updated/);
    assert.deepEqual(calls, [
      { operation: 'initialize', endpoints },
      { operation: 'set', endpoints, volume: 60 },
    ]);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
