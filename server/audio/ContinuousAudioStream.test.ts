import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

import {
  advancePcmScheduler,
  continuousAudioStartup,
  scheduledResearchGain,
  scheduledResearchToneSample,
} from './ContinuousAudioStream.ts';
import { ContinuousAudioStreamManager } from './ContinuousAudioStreamManager.ts';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMilliseconds = 4_000
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for continuous stream state.');
    }
    await delay(20);
  }
}

function bindClient(stream: { bindHttpClient(client: PassThrough): void }): PassThrough {
  const client = new PassThrough();
  client.resume();
  stream.bindHttpClient(client);
  return client;
}

test('equal-power scheduled tones use smooth gain and one shared logical phase timeline', () => {
  const fadeOut = { startGain: 1, endGain: 0, curve: 'equal-power' as const };
  const fadeIn = { startGain: 0, endGain: 1, curve: 'equal-power' as const };
  assert.ok(Math.abs(scheduledResearchGain(fadeOut, 0) - 1) < 1e-12);
  assert.ok(Math.abs(scheduledResearchGain(fadeIn, 0)) < 1e-12);
  assert.ok(Math.abs(scheduledResearchGain(fadeOut, 0.5) - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(scheduledResearchGain(fadeIn, 0.5) - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(scheduledResearchGain(fadeOut, 1)) < 1e-12);
  assert.ok(Math.abs(scheduledResearchGain(fadeIn, 1) - 1) < 1e-12);

  const gains = Array.from({ length: 401 }, (_, index) =>
    scheduledResearchGain(fadeOut, index / 400)
  );
  assert.ok(gains.every((gain, index) => index === 0 || Math.abs(gain - gains[index - 1]) < 0.005));

  const event = {
    targetMonotonicTime: 10_000,
    frequencyHz: 125,
    durationMs: 8_000,
    gainEnvelope: null,
  };
  const delayedSampleTime = event.targetMonotonicTime + 2;
  const expected = 0.4;
  assert.ok(Math.abs(scheduledResearchToneSample(event, delayedSampleTime) - expected) < 1e-10);
  assert.equal(
    scheduledResearchToneSample(event, delayedSampleTime),
    scheduledResearchToneSample({ ...event }, delayedSampleTime),
    'separate streams must derive identical phase from the shared target timeline'
  );
  assert.notEqual(scheduledResearchToneSample(event, delayedSampleTime), 0,
    'a delayed local start must not restart the waveform at phase zero');
});

test('PCM scheduler preserves consecutive logical frame times through catch-up and jitter', () => {
  const catchUpStarts: number[] = [];
  const caughtUp = advancePcmScheduler(
    1_000,
    1_060,
    20,
    (logicalStart) => { catchUpStarts.push(logicalStart); return true; }
  );
  assert.deepEqual(catchUpStarts, [1_000, 1_020, 1_040, 1_060]);
  assert.equal(caughtUp.nextFrameMonotonicTime, 1_080);

  const jitterStarts: number[] = [];
  let next = 2_000;
  for (const callbackTime of [2_020, 2_043, 2_061, 2_082]) {
    const result = advancePcmScheduler(next, callbackTime, 20, (logicalStart) => {
      jitterStarts.push(logicalStart);
      return true;
    });
    next = result.nextFrameMonotonicTime;
  }
  assert.deepEqual(jitterStarts, [2_000, 2_020, 2_040, 2_060, 2_080]);
});

test('scheduled waveform remains sample-continuous across logical PCM frame boundaries', () => {
  const targetMonotonicTime = 5_000;
  const event = {
    targetMonotonicTime,
    frequencyHz: 880,
    durationMs: 1_000,
    gainEnvelope: null,
  };
  const sampleRate = 48_000;
  const samplesPerFrame = 960;
  const logicalFrameStarts = [5_000, 5_020, 5_040, 5_060];
  const samples = logicalFrameStarts.flatMap((frameStart) =>
    Array.from({ length: samplesPerFrame }, (_, sampleIndex) =>
      scheduledResearchToneSample(event, frameStart + sampleIndex * 1_000 / sampleRate)
    )
  );
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const expected = scheduledResearchToneSample(
      event,
      targetMonotonicTime + sampleIndex * 1_000 / sampleRate
    );
    assert.ok(Math.abs(samples[sampleIndex] - expected) < 1e-10);
  }

  const delayedStart = targetMonotonicTime + 20;
  assert.equal(
    scheduledResearchToneSample(event, delayedStart),
    scheduledResearchToneSample({ ...event }, delayedStart),
    'callback timing and stream identity must not affect the shared logical source phase'
  );
  assert.ok(Math.abs(scheduledResearchToneSample(event, delayedStart)) > 0.1,
    'a participant starting one frame late must use target + 20 ms phase, not phase zero');
});

test('scheduled tone parameters drive PCM source and return to silence after completion', async () => {
  const manager = new ContinuousAudioStreamManager();
  const stream = manager.create();
  const client = bindClient(stream);
  try {
    await waitFor(() => stream.isReadyForTone());
    stream.scheduleTone({
      eventId: 'short-envelope',
      targetMonotonicTime: performance.now() + 100,
      frequencyHz: 997,
      durationMs: 200,
      gainEnvelope: { startGain: 1, endGain: 0, curve: 'equal-power' },
    });
    await waitFor(() => stream.getSnapshot().scheduledEvents[0]?.status === 'completed');
    const snapshot = stream.getSnapshot();
    assert.equal(snapshot.scheduledEvents[0].frequencyHz, 997);
    assert.equal(snapshot.scheduledEvents[0].durationMs, 200);
    assert.deepEqual(snapshot.scheduledEvents[0].gainEnvelope,
      { startGain: 1, endGain: 0, curve: 'equal-power' });
    assert.equal(snapshot.source, 'silence');
  } finally {
    client.destroy();
    manager.stop(stream.id, 'scheduled source test complete');
  }
});

test('encoder prewarms a bounded valid MP3 prefix before its HTTP client connects', async () => {
  const manager = new ContinuousAudioStreamManager();
  const stream = manager.create();
  let client: PassThrough | undefined;

  try {
    stream.start();
    assert.throws(() => stream.injectTestTone(), /not ready/i);
    await stream.waitUntilReadyForClient();
    const ready = stream.getSnapshot();
    assert.equal(ready.lifecycle, 'ready-for-client');
    assert.ok(ready.encoder.pid);
    assert.equal(ready.encoder.startupBufferReady, true);
    assert.ok(ready.encoder.startupBufferBytes > 0);
    assert.ok(ready.encoder.startupBufferBytes <= continuousAudioStartup.maximumBufferBytes);
    assert.equal(ready.encoder.encodedBytesProduced, ready.encoder.startupBufferBytes);
    assert.equal(ready.encoder.pcmPausedForReady, true);
    assert.equal(ready.source, 'silence');
    assert.throws(() => stream.injectTestTone(), /not ready/i);
    assert.ok(ready.recentEvents.some((event) => event.code === 'first-mpeg-frame'));
    const readyEvent = ready.recentEvents.find((event) => event.code === 'startup-buffer-ready');
    assert.ok(
      Number(readyEvent?.details?.completeMpegFrames) >= continuousAudioStartup.readyFrameCount
    );

    await delay(120);
    const paused = stream.getSnapshot();
    assert.equal(paused.encoder.encodedBytesProduced, ready.encoder.encodedBytesProduced);
    assert.equal(paused.encoder.startupBufferBytes, ready.encoder.startupBufferBytes);
    assert.equal(paused.encoder.framesGenerated, ready.encoder.framesGenerated);
    assert.equal(paused.encoder.pcmBytesGenerated, ready.encoder.pcmBytesGenerated);
    assert.equal(paused.encoder.pid, ready.encoder.pid);

    client = new PassThrough();
    const firstChunkPromise = new Promise<Buffer>((resolve) => {
      client?.once('data', (chunk: Buffer) => resolve(Buffer.from(chunk)));
    });
    stream.bindHttpClient(client);
    await waitFor(() => stream.isReadyForTone());
    const firstChunk = await firstChunkPromise;
    const running = stream.getSnapshot();
    const connectedEvent = running.recentEvents.find((event) => event.code === 'client-connected');
    const firstDelivery = running.recentEvents.find((event) => event.code === 'first-client-bytes');
    assert.equal(
      connectedEvent?.details?.encodedBytesBeforeConnection,
      ready.encoder.encodedBytesProduced
    );
    assert.equal(firstDelivery?.details?.encodedBytesProducedBeforeChunk, 0);
    assert.equal(Number(firstDelivery?.details?.chunkBytes), ready.encoder.startupBufferBytes);
    const beginsWithId3 = firstChunk.subarray(0, 3).toString('ascii') === 'ID3';
    const beginsWithMpegFrameSync =
      firstChunk[0] === 0xff && (firstChunk[1] & 0xe0) === 0xe0;
    assert.ok(beginsWithId3 || beginsWithMpegFrameSync, 'MP3 must begin at a valid stream boundary');
    assert.ok(running.recentEvents.some((event) => event.code === 'startup-buffer-flushed'));
    assert.ok(running.recentEvents.some((event) => event.code === 'first-live-bytes'));
    const pauseEvent = running.recentEvents.find((event) => event.code === 'pcm-paused-ready');
    const resumeEvent = running.recentEvents.find((event) => event.code === 'pcm-resumed-client');
    assert.ok(pauseEvent);
    assert.ok(resumeEvent);
    assert.equal(pauseEvent.details?.encoderPid, resumeEvent.details?.encoderPid);
    assert.equal(pauseEvent.details?.pcmFramesGenerated, resumeEvent.details?.pcmFramesAtPause);
    assert.equal(resumeEvent.details?.pcmFramesAtPause, resumeEvent.details?.pcmFramesAtResume);
    assert.equal(running.encoder.pcmPausedForReady, false);
    assert.ok(running.encoder.framesGenerated > ready.encoder.framesGenerated);
    assert.equal(running.httpClient.deliveredBytes, running.encoder.encodedBytesProduced);

    stream.injectTestTone();
    assert.equal(stream.getSnapshot().source, 'test-tone');
    await delay(1_050);
    const measured = stream.getSnapshot();
    const first100Ms = measured.recentEvents.find(
      (event) => event.code === 'delivery-first-100ms'
    );
    const first1000Ms = measured.recentEvents.find(
      (event) => event.code === 'delivery-first-1000ms'
    );
    assert.ok(Number(first100Ms?.details?.deliveredBytes) > 0);
    assert.ok(Number(first1000Ms?.details?.deliveredBytes) >= Number(first100Ms?.details?.deliveredBytes));
    assert.ok(Number(first1000Ms?.details?.maximumWritableLength) >= 0);
  } finally {
    client?.destroy();
    manager.stopAll('client-driven startup test cleanup');
  }
});

test('AAC/ADTS profile prewarms independently and delivers a valid ADTS prefix', async () => {
  const manager = new ContinuousAudioStreamManager();
  const stream = manager.create({ encodingProfileId: 'aac-adts' });
  const client = new PassThrough();
  try {
    stream.start();
    await stream.waitUntilReadyForClient();
    const ready = stream.getSnapshot();
    assert.equal(ready.encoder.codec, 'aac-lc');
    assert.equal(ready.encoder.container, 'adts');
    assert.equal(ready.encoder.sampleRate, 48_000);
    assert.ok(ready.recentEvents.some((event) => event.code === 'first-adts-frame'));
    const first = new Promise<Buffer>((resolve) => client.once('data', (chunk: Buffer) => resolve(Buffer.from(chunk))));
    stream.bindHttpClient(client);
    const chunk = await first;
    assert.equal(chunk[0], 0xff);
    assert.equal(chunk[1] & 0xf6, 0xf0);
  } finally {
    client.destroy();
    manager.stop(stream.id, 'test complete');
  }
});

test('local startup reconnect preserves encoder, pauses PCM, and resumes on an ADTS boundary', async () => {
  const manager = new ContinuousAudioStreamManager();
  const disconnects: string[] = [];
  const stream = manager.create({
    encodingProfileId: 'aac-adts',
    clientReconnectGraceMs: 500,
    minimumConnectionsForTone: 2,
    onClientDisconnected: (reason) => disconnects.push(reason),
  });
  const first = new PassThrough();
  const second = new PassThrough();
  first.resume();
  try {
    stream.start();
    await stream.waitUntilReadyForClient();
    stream.bindHttpClient(first, {
      remoteAddress: '192.168.12.207', httpVersion: 'HTTP/1.0', userAgent: 'Sonos probe',
      role: 'startup-consumer', phase: 'startup-consumer',
    });
    await waitFor(() => stream.getSnapshot().lifecycle === 'running');
    const encoderPid = stream.getSnapshot().encoder.pid;
    first.destroy();
    await waitFor(() => stream.getSnapshot().httpClient.awaitingReconnect);
    const paused = stream.getSnapshot();
    assert.equal(paused.encoder.pcmPausedForReady, true);
    await delay(80);
    assert.equal(stream.getSnapshot().encoder.framesGenerated, paused.encoder.framesGenerated);
    assert.equal(stream.getSnapshot().encoder.pid, encoderPid);
    assert.deepEqual(disconnects, []);

    const firstReconnectChunk = new Promise<Buffer>((resolve) =>
      second.once('data', (chunk: Buffer) => resolve(Buffer.from(chunk)))
    );
    second.resume();
    stream.bindHttpClient(second, {
      remoteAddress: '192.168.12.207', httpVersion: 'HTTP/1.0',
      userAgent: 'Sonos Nullsoft Winamp3 version 3.0 (compatible)',
      role: 'startup-reconnect', phase: 'awaiting-startup-reconnect',
    });
    const chunk = await firstReconnectChunk;
    assert.equal(chunk[0], 0xff);
    assert.equal(chunk[1] & 0xf6, 0xf0);
    await waitFor(() => stream.isReadyForTone());
    const running = stream.getSnapshot();
    assert.equal(running.encoder.pid, encoderPid);
    assert.equal(running.httpClient.connectionCount, 2);
    assert.equal(running.httpClient.currentConnectionOrdinal, 2);
    assert.equal(running.httpClient.connections[0].radioStyleUserAgent, false);
    assert.equal(running.httpClient.connections[1].radioStyleUserAgent, true);
    stream.injectTestTone();
  } finally {
    second.destroy();
    manager.stop(stream.id, 'test complete');
  }
});

test('local startup reconnect timeout reports terminal disconnect without restarting FFmpeg', async () => {
  const manager = new ContinuousAudioStreamManager();
  const disconnects: string[] = [];
  const stream = manager.create({
    encodingProfileId: 'aac-adts', clientReconnectGraceMs: 80,
    onClientDisconnected: (reason) => disconnects.push(reason),
  });
  const client = bindClient(stream);
  try {
    await waitFor(() => stream.getSnapshot().lifecycle === 'running');
    const pid = stream.getSnapshot().encoder.pid;
    client.destroy();
    await waitFor(() => disconnects.length === 1);
    assert.match(disconnects[0], /reconnect timed out/i);
    assert.equal(stream.getSnapshot().encoder.pid, pid);
  } finally { manager.stop(stream.id, 'test complete'); }
});

test('explicit stop while awaiting reconnect tears down immediately', async () => {
  const manager = new ContinuousAudioStreamManager();
  const stream = manager.create({ encodingProfileId: 'aac-adts', clientReconnectGraceMs: 500 });
  const client = bindClient(stream);
  await waitFor(() => stream.getSnapshot().lifecycle === 'running');
  client.destroy();
  await waitFor(() => stream.getSnapshot().httpClient.awaitingReconnect);
  manager.stop(stream.id, 'user stopped');
  assert.equal(manager.getSnapshot(stream.id)?.lifecycle, 'stopped');
});

test('disconnect after the startup reconnect fails fast instead of opening another grace window', async () => {
  const disconnects: string[] = [];
  const manager = new ContinuousAudioStreamManager();
  const stream = manager.create({
    encodingProfileId: 'aac-adts', clientReconnectGraceMs: 500,
    onClientDisconnected: (reason) => disconnects.push(reason),
  });
  const first = bindClient(stream);
  await waitFor(() => stream.getSnapshot().lifecycle === 'running');
  first.destroy();
  await waitFor(() => stream.getSnapshot().httpClient.awaitingReconnect);
  const second = bindClient(stream);
  await waitFor(() => stream.getSnapshot().lifecycle === 'running');
  second.destroy();
  await waitFor(() => disconnects.length === 1);
  assert.match(disconnects[0], /remote client disconnected/i);
  assert.equal(stream.getSnapshot().httpClient.awaitingReconnect, false);
  assert.ok(stream.getSnapshot().recentEvents.some((event) => event.code === 'terminal-consumer-summary'));
  manager.stop(stream.id, 'test complete');
});

test('Media Foundation AAC telemetry maintains encoded rate for silence and tone', async () => {
  async function measuredRate() {
    const manager = new ContinuousAudioStreamManager();
    const stream = manager.create({ encodingProfileId: 'aac-adts' });
    const client = bindClient(stream);
    try {
      await waitFor(() => stream.getSnapshot().lifecycle === 'running');
      await waitFor(() => stream.getSnapshot().telemetry.encodedRate.samples >= 2, 4_000);
      assert.ok(stream.getSnapshot().telemetry.pcmFramesGeneratedLastSecond >= 45);
      assert.ok(stream.getSnapshot().telemetry.pcmFramesGeneratedLastSecond <= 55);
      return { manager, stream, client, rate: stream.getSnapshot().telemetry.encodedBitsPerSecond };
    } catch (error) {
      client.destroy(); manager.stop(stream.id, 'measurement failed'); throw error;
    }
  }

  const silence = await measuredRate();
  try {
    assert.ok(silence.rate > 100_000, `expected transport-safe silence above 100 kbps, got ${silence.rate}`);
    const pid = silence.stream.getSnapshot().encoder.pid;
    silence.stream.injectTestTone();
    assert.equal(silence.stream.getSnapshot().telemetry.sourceMode, 'test-tone');
    await waitFor(() => silence.stream.getSnapshot().recentEvents.some((event) => event.code === 'tone-completed'));
    await waitFor(() => silence.stream.getSnapshot().telemetry.encodedBitsPerSecond > 100_000, 3_000);
    assert.equal(silence.stream.getSnapshot().encoder.pid, pid);
  } finally {
    silence.client.destroy(); silence.manager.stop(silence.stream.id, 'test complete');
  }

});

test('two streams schedule one shared event against the same monotonic target', async () => {
  const manager = new ContinuousAudioStreamManager();
  const a = manager.create({ encodingProfileId: 'aac-adts' });
  const b = manager.create({ encodingProfileId: 'aac-adts' });
  const clientA = bindClient(a);
  const clientB = bindClient(b);
  try {
    await waitFor(() => a.isReadyForTone() && b.isReadyForTone());
    const eventId = 'shared-event';
    const targetMonotonicTime = performance.now() + 300;
    a.scheduleTone({ eventId, targetMonotonicTime });
    b.scheduleTone({ eventId, targetMonotonicTime });
    await waitFor(() => a.getSnapshot().scheduledEvents[0]?.status === 'started'
      && b.getSnapshot().scheduledEvents[0]?.status === 'started');
    const eventA = a.getSnapshot().scheduledEvents[0];
    const eventB = b.getSnapshot().scheduledEvents[0];
    assert.equal(eventA.eventId, eventB.eventId);
    assert.equal(eventA.targetMonotonicTime, eventB.targetMonotonicTime);
    assert.ok(eventA.actualPcmStartMonotonicTime !== null);
    assert.ok(eventB.actualPcmStartMonotonicTime !== null);
    assert.ok(Math.abs(eventA.actualPcmStartMonotonicTime - eventB.actualPcmStartMonotonicTime) <= 20);
  } finally {
    clientA.destroy(); clientB.destroy();
    manager.stop(a.id, 'test complete'); manager.stop(b.id, 'test complete');
  }
});

test('two continuous streams isolate encoder, source, counters, and cleanup', async () => {
  const manager = new ContinuousAudioStreamManager();
  const streamA = manager.create();
  const streamB = manager.create();
  const clients: PassThrough[] = [];

  try {
    assert.notEqual(streamA.id, streamB.id);
    assert.equal(streamA.getSnapshot().encoder.pid, null);
    assert.equal(streamB.getSnapshot().encoder.pid, null);

    streamA.start();
    streamB.start();
    await Promise.all([
      streamA.waitUntilReadyForClient(),
      streamB.waitUntilReadyForClient(),
    ]);
    clients.push(bindClient(streamA), bindClient(streamB));

    await delay(160);
    const initialA = streamA.getSnapshot();
    const initialB = streamB.getSnapshot();
    assert.ok(initialA.encoder.pid);
    assert.ok(initialB.encoder.pid);
    assert.notEqual(initialA.encoder.pid, initialB.encoder.pid);
    assert.equal(initialA.source, 'silence');
    assert.equal(initialB.source, 'silence');
    assert.ok(initialA.encoder.framesGenerated > 0);
    assert.ok(initialB.encoder.framesGenerated > 0);

    await waitFor(() => streamA.isReadyForTone() && streamB.isReadyForTone());
    streamA.injectTestTone();
    assert.equal(streamA.getSnapshot().source, 'test-tone');
    assert.equal(streamB.getSnapshot().source, 'silence');

    const beforeStopA = streamA.getSnapshot();
    const beforeStopB = streamB.getSnapshot();
    manager.stop(streamA.id, 'isolation test');
    await delay(120);

    const stoppedA = streamA.getSnapshot();
    const continuingB = streamB.getSnapshot();
    assert.equal(stoppedA.lifecycle, 'stopped');
    assert.equal(stoppedA.encoder.pid, null);
    assert.equal(stoppedA.encoder.framesGenerated, beforeStopA.encoder.framesGenerated);
    assert.equal(stoppedA.encoder.pcmBytesGenerated, beforeStopA.encoder.pcmBytesGenerated);
    assert.notEqual(continuingB.lifecycle, 'stopped');
    assert.equal(continuingB.encoder.pid, beforeStopB.encoder.pid);
    assert.ok(continuingB.encoder.framesGenerated > beforeStopB.encoder.framesGenerated);
    assert.ok(
      continuingB.encoder.pcmBytesGenerated > beforeStopB.encoder.pcmBytesGenerated
    );
    assert.equal(continuingB.source, 'silence');
    assert.notEqual(
      stoppedA.encoder.framesGenerated,
      continuingB.encoder.framesGenerated,
      'frame counters must advance independently after one stream stops'
    );
  } finally {
    for (const client of clients) {
      client.destroy();
    }
    manager.stopAll('isolation test cleanup');
  }
});

test('snapshot exposes progress, source events, retained stop state, and metadata', async () => {
  const manager = new ContinuousAudioStreamManager();
  const stream = manager.create({
    deviceId: 'device-opaque-id',
    transportId: 'test-transport',
  });
  let client: PassThrough | undefined;

  try {
    const created = manager.getSnapshot(stream.id);
    assert.ok(created);
    assert.equal(created.deviceId, 'device-opaque-id');
    assert.equal(created.transportId, 'test-transport');
    assert.equal(created.source, 'silence');
    assert.equal(created.encoder.sampleRate, 44_100);
    assert.equal(created.encoder.channels, 2);
    assert.equal(created.encoder.bitrate, 192_000);
    assert.equal(created.lifecycle, 'waiting-for-client');
    assert.equal(created.encoder.pid, null);

    stream.start();
    await stream.waitUntilReadyForClient();
    client = bindClient(stream);
    await delay(160);
    const advancing = manager.getSnapshot(stream.id);
    assert.ok(advancing);
    assert.ok(advancing.encoder.framesGenerated > created.encoder.framesGenerated);
    assert.ok(advancing.encoder.pcmBytesGenerated > created.encoder.pcmBytesGenerated);

    await waitFor(() => stream.isReadyForTone());
    stream.injectTestTone();
    const tone = manager.getSnapshot(stream.id);
    assert.ok(tone);
    assert.equal(tone.source, 'test-tone');
    assert.ok(tone.recentEvents.some((event) => event.code === 'tone-injected'));

    assert.equal(manager.stop(stream.id, 'diagnostic retention test'), true);
    const retained = manager.getSnapshot(stream.id);
    assert.ok(retained);
    assert.equal(retained.lifecycle, 'stopped');
    assert.ok(retained.stoppedAt);
    assert.ok(retained.recentEvents.some((event) => event.code === 'stream-stopped'));
    assert.ok(manager.listSnapshots().some((snapshot) => snapshot.id === stream.id));
  } finally {
    client?.destroy();
    manager.stopAll('snapshot test cleanup');
  }
});

test('stream diagnostics are isolated and sanitize sensitive details', () => {
  const manager = new ContinuousAudioStreamManager();
  const streamA = manager.create();
  const streamB = manager.create();

  try {
    streamA.addDiagnosticEvent('error', 'Provider failed with authorization: hidden-value', {
      authorization: 'Bearer hidden-authorization',
      refreshToken: 'hidden-refresh-token',
      nested: {
        clientSecret: 'hidden-client-secret',
        filePath: 'C:\\SACscapeData\\private\\diagnostic.txt',
      },
      safeValue: 'visible',
    });

    const snapshotA = manager.getSnapshot(streamA.id);
    const snapshotB = manager.getSnapshot(streamB.id);
    assert.ok(snapshotA);
    assert.ok(snapshotB);
    const serializedA = JSON.stringify(snapshotA);
    const serializedB = JSON.stringify(snapshotB);

    assert.doesNotMatch(serializedA, /hidden-authorization|hidden-refresh-token/);
    assert.doesNotMatch(serializedA, /hidden-client-secret|SACscapeData/);
    assert.match(serializedA, /\[redacted\]/);
    assert.match(serializedA, /visible/);
    assert.doesNotMatch(serializedB, /visible|external-diagnostic/);
    assert.notStrictEqual(snapshotA.recentEvents, snapshotB.recentEvents);
  } finally {
    manager.stopAll('sanitization test cleanup');
  }
});
