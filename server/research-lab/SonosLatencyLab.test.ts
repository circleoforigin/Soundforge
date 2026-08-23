import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import ffmpegPath from 'ffmpeg-static';

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

async function decodeDeliveredAudio(profileId: string, bytes: Buffer): Promise<Buffer> {
  if (profileId === 'l16-pcm') {
    const decoded = Buffer.alloc(Math.floor(bytes.length / 4) * 2);
    for (let inputOffset = 0, outputOffset = 0;
      inputOffset + 3 < bytes.length;
      inputOffset += 4, outputOffset += 2) {
      decoded.writeInt16LE(bytes.readInt16BE(inputOffset), outputOffset);
    }
    return decoded;
  }
  const executable = ffmpegPath as unknown as string | null;
  if (!executable) throw new Error('Bundled FFmpeg is unavailable.');
  const process = spawn(executable, [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-f', 's16le', '-ac', '1', '-ar', '48000', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  process.stdout.on('data', (chunk: Buffer) => output.push(Buffer.from(chunk)));
  process.stderr.on('data', (chunk: Buffer) => errors.push(Buffer.from(chunk)));
  process.stdin.end(bytes);
  const code = await new Promise<number | null>((resolve, reject) => {
    process.once('error', reject);
    process.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`Delivered ${profileId} decode failed: ${Buffer.concat(errors).toString('utf8')}`);
  return Buffer.concat(output);
}

function verifyAudibleTone(pcm: Buffer): { peak: number; frequencyHz: number } {
  const samples = Array.from({ length: Math.floor(pcm.length / 2) }, (_, index) => pcm.readInt16LE(index * 2));
  let peak = 0;
  samples.forEach((sample) => {
    if (Math.abs(sample) > peak) peak = Math.abs(sample);
  });
  const threshold = peak * 0.15;
  let firstAudible = samples.findIndex((sample) => Math.abs(sample) >= threshold);
  let lastAudible = samples.findLastIndex((sample) => Math.abs(sample) >= threshold);
  if (firstAudible < 0 || lastAudible <= firstAudible) throw new Error('No audible tone window found.');
  firstAudible = Math.max(0, firstAudible - 2);
  lastAudible = Math.min(samples.length - 1, lastAudible + 2);
  const window = samples.slice(firstAudible, lastAudible + 1);
  let zeroCrossings = 0;
  let prior = 0;
  for (const sample of window) {
    const sign = sample > threshold ? 1 : sample < -threshold ? -1 : prior;
    if (prior !== 0 && sign !== prior) zeroCrossings += 1;
    prior = sign;
  }
  const durationSeconds = window.length / 48_000;
  const frequencyHz = zeroCrossings / (2 * durationSeconds);
  assert.ok(peak > 2_000, `expected audible PCM peak, received ${peak}`);
  assert.ok(frequencyHz > 800 && frequencyHz < 960,
    `expected an approximately 880 Hz tone, measured ${frequencyHz.toFixed(1)} Hz`);
  return { peak, frequencyHz };
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
  assert.equal(sonosLatencyExperimentProfiles.length, 4);
});

test('Known Working Baseline uses the Sonos Local transport defaults', () => {
  const baseline = getSonosLatencyExperimentProfile('known-working-baseline');
  assert.ok(baseline);
  assert.equal(baseline.useTransportDefaults, true);
  assert.equal(baseline.encodingProfileId, 'aac-adts');
  assert.equal(baseline.uriScheme, 'x-rincon-mp3radio');
  assert.equal(baseline.metadataMode, 'empty');
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

test('all latency profiles inject through one running PCM source without restarting output', async () => {
  for (const profile of sonosLatencyExperimentProfiles) {
    const manager = new ContinuousAudioStreamManager();
    const stream = manager.create({ encodingProfileId: profile.encodingProfileId });
    const client = new PassThrough();
    const delivered: Buffer[] = [];
    client.on('data', (chunk: Buffer) => delivered.push(Buffer.from(chunk)));
    try {
      stream.start(); await stream.waitUntilReadyForClient();
      assert.equal(stream.isReadyForTone(), false);
      stream.bindHttpClient(client);
      await waitFor(() => stream.isReadyForTone());
      const before = stream.getSnapshot();
      stream.injectTestTone({
        durationMs: 200, frequencyHz: 880, diagnosticPrefix: 'latency_lab',
        diagnosticDetails: { profileId: profile.id, streamId: stream.id },
      });
      await waitFor(() => stream.getSnapshot().recentEvents.some(
        (event) => event.code === 'latency_lab.tone_pcm_completed'
      ));
      await waitFor(() => stream.getSnapshot().recentEvents.some(
        (event) => event.code === 'latency_lab.tone_output_verified'
      ));
      await new Promise((resolve) => setTimeout(resolve, 250));
      const after = stream.getSnapshot();
      const codes = after.recentEvents.map((event) => event.code);
      assert.ok(codes.indexOf('latency_lab.tone_requested') < codes.indexOf('latency_lab.tone_pcm_started'));
      assert.ok(codes.indexOf('latency_lab.tone_pcm_started') < codes.indexOf('latency_lab.tone_pcm_completed'));
      assert.equal(after.id, before.id);
      assert.equal(after.encoder.pid, before.encoder.pid);
      assert.equal(after.httpClient.connectionCount, before.httpClient.connectionCount);
      assert.equal(after.lifecycle, 'running');
      assert.equal(after.source, 'silence');
      assert.ok(after.encoder.framesGenerated > before.encoder.framesGenerated);
      const started = after.recentEvents.find((event) => event.code === 'latency_lab.tone_pcm_started');
      assert.ok(Number.isInteger(Number(started?.details?.firstLogicalFrameIndex)));
      const verified = after.recentEvents.find((event) => event.code === 'latency_lab.tone_pcm_verified');
      assert.ok(Number(verified?.details?.framePeak) > 0);
      const decoded = await decodeDeliveredAudio(profile.encodingProfileId, Buffer.concat(delivered));
      verifyAudibleTone(decoded);
    } finally {
      client.destroy(); manager.stopAll('latency shared-source test complete');
    }
  }
});

test('latency tone readiness accepts a healthy first persistent consumer for every profile', async () => {
  for (const profile of sonosLatencyExperimentProfiles) {
    const manager = new ContinuousAudioStreamManager();
    const stream = manager.create({
      encodingProfileId: profile.encodingProfileId,
      minimumConnectionsForTone: 2,
    });
    const client = new PassThrough();
    client.resume();
    try {
      stream.start();
      await stream.waitUntilReadyForClient();
      stream.bindHttpClient(client);
      await waitFor(() => stream.getSnapshot().lifecycle === 'running');

      const ordinaryReadiness = stream.getToneReadiness();
      assert.equal(ordinaryReadiness.toneReady, false);
      assert.match(ordinaryReadiness.reason ?? '', /stable Sonos stream consumer/);

      const latencyReadiness = stream.prepareForToneInjection({ acceptStableInitialConsumer: true });
      assert.equal(latencyReadiness.toneReady, true);
      assert.equal(latencyReadiness.clientConnected, true);
      assert.equal(latencyReadiness.hasDeliveredBytes, true);
      assert.equal(latencyReadiness.connectionCount, 1);
      assert.equal(latencyReadiness.requiredConnectionCount, 2);
      const before = stream.getSnapshot();
      stream.injectTestTone({
        durationMs: 200,
        frequencyHz: 880,
        acceptStableInitialConsumer: true,
      });
      await waitFor(() => stream.getSnapshot().source === 'silence');
      const after = stream.getSnapshot();
      assert.equal(after.id, before.id);
      assert.equal(after.encoder.pid, before.encoder.pid);
      assert.equal(after.httpClient.currentConnectionOrdinal, 1);
    } finally {
      client.destroy();
      manager.stopAll('latency first-consumer readiness test complete');
    }
  }
});

test('tone readiness reports a specific missing-consumer reason', async () => {
  const manager = new ContinuousAudioStreamManager();
  const stream = manager.create({ encodingProfileId: 'aac-adts' });
  try {
    stream.start();
    await stream.waitUntilReadyForClient();
    const readiness = stream.prepareForToneInjection({ acceptStableInitialConsumer: true });
    assert.equal(readiness.toneReady, false);
    assert.equal(readiness.clientConnected, false);
    assert.equal(readiness.reason, 'No active Sonos HTTP consumer.');
  } finally {
    manager.stopAll('missing-consumer readiness test complete');
  }
});
