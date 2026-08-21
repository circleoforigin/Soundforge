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
    assert.ok(initialA.encoderPid);
    assert.ok(initialB.encoderPid);
    assert.notEqual(initialA.encoderPid, initialB.encoderPid);
    assert.equal(initialA.source, 'silence');
    assert.equal(initialB.source, 'silence');
    assert.ok(initialA.pcmFramesGenerated > 0);
    assert.ok(initialB.pcmFramesGenerated > 0);

    streamA.injectTestTone();
    assert.equal(streamA.getSnapshot().source, 'test-tone');
    assert.equal(streamB.getSnapshot().source, 'silence');

    const beforeStopA = streamA.getSnapshot();
    const beforeStopB = streamB.getSnapshot();
    manager.stop(streamA.id, 'isolation test');
    await delay(120);

    const stoppedA = streamA.getSnapshot();
    const continuingB = streamB.getSnapshot();
    assert.equal(stoppedA.state, 'stopped');
    assert.equal(stoppedA.encoderPid, null);
    assert.equal(stoppedA.pcmFramesGenerated, beforeStopA.pcmFramesGenerated);
    assert.equal(stoppedA.pcmBytesGenerated, beforeStopA.pcmBytesGenerated);
    assert.equal(continuingB.state, 'running');
    assert.equal(continuingB.encoderPid, beforeStopB.encoderPid);
    assert.ok(continuingB.pcmFramesGenerated > beforeStopB.pcmFramesGenerated);
    assert.ok(continuingB.pcmBytesGenerated > beforeStopB.pcmBytesGenerated);
    assert.equal(continuingB.source, 'silence');
    assert.notEqual(
      stoppedA.pcmFramesGenerated,
      continuingB.pcmFramesGenerated,
      'frame counters must advance independently after one stream stops'
    );
  } finally {
    manager.stopAll('isolation test cleanup');
  }
});
