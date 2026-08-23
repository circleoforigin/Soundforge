import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  getSonosLatencyExperimentProfile,
  sonosLatencyExperimentProfiles,
  summarizeSonosLatencyResults,
} from '../../src/models/SonosLatencyLab.ts';
import { continuousAudioEncodingProfiles } from '../audio/ContinuousAudioEncodingProfile.ts';
import { ContinuousAudioStreamManager } from '../audio/ContinuousAudioStreamManager.ts';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for latency-stream state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('latency baseline is config-equivalent to the production AAC/ADTS profile', () => {
  const baseline = getSonosLatencyExperimentProfile('aac-radio');
  const existing = continuousAudioEncodingProfiles['aac-adts'];
  assert.ok(baseline);
  assert.equal(baseline.encodingProfileId, existing.id);
  assert.equal(baseline.codec, existing.codec);
  assert.equal(baseline.container, existing.container);
  assert.equal(baseline.mimeType, existing.outputMimeType);
  assert.equal(baseline.sampleRate, existing.sampleRate);
  assert.equal(baseline.channelCount, existing.channelCount);
  assert.equal(baseline.bitrate, existing.outputBitrate);
  assert.equal(baseline.uriScheme, 'x-rincon-mp3radio');
});

test('WAV and L16 profiles emit valid distinct uncompressed prefixes', async () => {
  for (const [profileId, expected] of [
    ['wav-pcm', 'RIFF'],
    ['l16-pcm', '\0\0\0\0'],
  ] as const) {
    const manager = new ContinuousAudioStreamManager();
    const stream = manager.create({ encodingProfileId: profileId });
    const client = new PassThrough();
    try {
      stream.start();
      await stream.waitUntilReadyForClient();
      const first = new Promise<Buffer>((resolve) => client.once('data', (chunk: Buffer) => resolve(Buffer.from(chunk))));
      stream.bindHttpClient(client);
      const chunk = await first;
      assert.equal(chunk.toString('ascii', 0, 4), expected);
      if (profileId === 'wav-pcm') assert.equal(chunk.toString('ascii', 8, 12), 'WAVE');
      if (profileId === 'l16-pcm') assert.equal(stream.getSnapshot().encoder.codec, 'pcm-s16be');
    } finally {
      client.destroy();
      manager.stopAll('latency profile test complete');
    }
  }
});

test('latency result summaries compare independent session-local profiles', () => {
  const samples = [
    { id: '1', profileId: 'aac-radio' as const, observedDelayMs: 3510, recordedAt: 'now' },
    { id: '2', profileId: 'aac-radio' as const, observedDelayMs: 3480, recordedAt: 'now' },
    { id: '3', profileId: 'wav-broadcast' as const, observedDelayMs: 900, recordedAt: 'now' },
  ];
  assert.deepEqual(summarizeSonosLatencyResults('aac-radio', samples), {
    profileId: 'aac-radio', samples: 2, averageMs: 3495, minimumMs: 3480, maximumMs: 3510,
  });
  assert.equal(summarizeSonosLatencyResults('wav-broadcast', samples).averageMs, 900);
  assert.equal(sonosLatencyExperimentProfiles.length, 3);
});

test('WAV startup reconnect replays a valid container beginning', async () => {
  const manager = new ContinuousAudioStreamManager();
  const stream = manager.create({
    encodingProfileId: 'wav-pcm', clientReconnectGraceMs: 500,
    minimumConnectionsForTone: 2,
  });
  const first = new PassThrough();
  const second = new PassThrough();
  try {
    stream.start(); await stream.waitUntilReadyForClient();
    first.resume(); stream.bindHttpClient(first);
    await waitFor(() => stream.getSnapshot().lifecycle === 'running');
    first.destroy();
    await waitFor(() => stream.getSnapshot().httpClient.awaitingReconnect);
    const next = new Promise<Buffer>((resolve) => second.once('data', (chunk: Buffer) => resolve(Buffer.from(chunk))));
    stream.bindHttpClient(second);
    const prefix = await next;
    assert.equal(prefix.toString('ascii', 0, 4), 'RIFF');
    assert.equal(prefix.toString('ascii', 8, 12), 'WAVE');
  } finally {
    first.destroy(); second.destroy(); manager.stopAll('WAV reconnect test complete');
  }
});
