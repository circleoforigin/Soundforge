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
});
