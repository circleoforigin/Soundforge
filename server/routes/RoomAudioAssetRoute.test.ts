import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { RoomAudioAssetStore } from '../audio/room/RoomAudioAssetStore.ts';
import { registerRoomAudioAssetRoute } from './RoomAudioAssetRoute.ts';

function pcmWav(): Buffer {
  const samples = 2_205; const dataBytes = samples * 2; const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(44_100, 24); buffer.writeUInt32LE(88_200, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(dataBytes, 40); return buffer;
}

test('asset route validates uploads, preserves bytes, reports cache hits, and rejects non-audio', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'room-audio-route-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const store = new RoomAudioAssetStore(root); const app = express();
  registerRoomAudioAssetRoute(app, store, { async record() { return null; } });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo; const url = `http://127.0.0.1:${port}/api/audio/assets/wolf`;
  const bytes = pcmWav(); const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'wolf.wav');
  form.append('mimeType', 'audio/wav'); form.append('sourceByteLength', String(bytes.length));
  const upload = await fetch(url, { method: 'POST', body: form });
  assert.equal(upload.status, 201);
  const result = await upload.json() as { receivedByteLength: number; storedByteLength: number; validationResult: string };
  assert.equal(result.receivedByteLength, bytes.length); assert.equal(result.storedByteLength, bytes.length);
  assert.match(result.validationResult, /riff-wave/);
  assert.deepEqual(await fs.promises.readFile(path.join(root, 'wolf.media')), bytes);
  const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.status, 200);
  assert.equal(head.headers.get('X-SACscape-Asset-Cache'), 'hit');

  const invalid = new FormData(); invalid.append('file', new Blob(['<!doctype html>'], { type: 'text/html' }), 'bad.html');
  const protectedUpload = await fetch(url, { method: 'POST', body: invalid });
  assert.equal(protectedUpload.status, 200, 'a valid cached asset must not be overwritten');
  assert.deepEqual(await fs.promises.readFile(path.join(root, 'wolf.media')), bytes);

  const badUrl = `http://127.0.0.1:${port}/api/audio/assets/bad`; const bad = new FormData();
  bad.append('file', new Blob(['<!doctype html>'], { type: 'text/html' }), 'bad.html');
  const rejected = await fetch(badUrl, { method: 'POST', body: bad });
  assert.equal(rejected.status, 415); assert.match((await rejected.json() as { message: string }).message, /not an audio/i);
  assert.equal((await fetch(badUrl, { method: 'HEAD' })).status, 404);
});
