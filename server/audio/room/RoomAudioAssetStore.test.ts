import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoomAudioAssetStore } from './RoomAudioAssetStore.ts';

function pcmWav(): Buffer {
  const samples = 4_410; const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(44_100, 24); buffer.writeUInt32LE(88_200, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(Math.round(Math.sin(index / 20) * 10_000), 44 + index * 2);
  return buffer;
}

test('Room Audio asset store atomically retains original bytes and decodes once to 48 kHz stereo float PCM', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'room-audio-assets-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const store = new RoomAudioAssetStore(root);
  await store.put('wolf', pcmWav());
  assert.equal(await store.has('wolf'), true);
  const first = await store.decode('wolf');
  const second = await store.decode('wolf');
  assert.equal(first, second);
  assert.equal(first.sampleRate, 48_000);
  assert.equal(first.channels, 2);
  assert.ok(first.durationSamples > 4_700);
  assert.ok(first.peak > 0);
  assert.ok(first.rms > 0);
});

test('Room Audio asset decode telemetry distinguishes miss from cache hit', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'room-audio-cache-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const store = new RoomAudioAssetStore(root); await store.put('wolf', pcmWav());
  const first = await store.decodeWithTelemetry('wolf'); const second = await store.decodeWithTelemetry('wolf');
  assert.equal(first.cacheHit, false); assert.equal(second.cacheHit, true); assert.equal(first.asset, second.asset);
});

test('validated synchronization preserves binary bytes exactly and reuses its validation cache', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'room-audio-binary-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const store = new RoomAudioAssetStore(root); const source = pcmWav();
  const stored = await store.put('exact', source);
  assert.match(stored.validationResult, /ffmpeg-probe-ok/);
  assert.deepEqual(await fs.promises.readFile(path.join(root, 'exact.media')), source);
  const first = await store.inspect('exact'); const second = await store.inspect('exact');
  assert.equal(first.valid, true); assert.equal(second.cacheHit, true);
});

test('corrupt cached media is invalidated and replaced by a valid asset', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'room-audio-repair-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(root, 'wolf.media'), '<!doctype html><html>not audio</html>');
  const store = new RoomAudioAssetStore(root);
  const invalid = await store.inspect('wolf');
  assert.equal(invalid.valid, false); assert.match(invalid.validationResult, /not an audio/i);
  assert.equal(await store.has('wolf'), false);
  const replacement = await store.put('wolf', pcmWav());
  assert.equal(replacement.invalidCacheReplaced, true);
  assert.equal((await store.inspect('wolf')).valid, true);
  assert.ok((await store.decode('wolf')).durationSamples > 0);
});

test('zero-byte and non-audio uploads are rejected without creating a cache hit', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'room-audio-reject-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const store = new RoomAudioAssetStore(root);
  await assert.rejects(store.put('empty', Buffer.alloc(0)), /empty/i);
  await assert.rejects(store.put('html', Buffer.from('<!doctype html><html>SPA</html>')), /not an audio/i);
  assert.equal(await store.has('empty'), false); assert.equal(await store.has('html'), false);
});
