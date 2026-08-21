import assert from 'node:assert/strict';
import test from 'node:test';

import { ContinuousAudioStreamManager } from './ContinuousAudioStreamManager.ts';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('two continuous streams isolate encoder, source, counters, and cleanup', async () => {
  const manager = new ContinuousAudioStreamManager();
  const streamA = manager.create();
  const streamB = manager.create();

  try {
    assert.notEqual(streamA.id, streamB.id);

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
    manager.stopAll('isolation test cleanup');
  }
});

test('snapshot exposes progress, source events, retained stop state, and metadata', async () => {
  const manager = new ContinuousAudioStreamManager();
  const stream = manager.create({
    deviceId: 'device-opaque-id',
    transportId: 'test-transport',
  });

  try {
    const created = manager.getSnapshot(stream.id);
    assert.ok(created);
    assert.equal(created.deviceId, 'device-opaque-id');
    assert.equal(created.transportId, 'test-transport');
    assert.equal(created.source, 'silence');
    assert.equal(created.encoder.sampleRate, 44_100);
    assert.equal(created.encoder.channels, 2);
    assert.equal(created.encoder.bitrate, 192_000);

    await delay(160);
    const advancing = manager.getSnapshot(stream.id);
    assert.ok(advancing);
    assert.ok(advancing.encoder.framesGenerated > created.encoder.framesGenerated);
    assert.ok(advancing.encoder.pcmBytesGenerated > created.encoder.pcmBytesGenerated);

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
