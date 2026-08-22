import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  continuousAudioStartup,
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
  manager.stop(stream.id, 'test complete');
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
