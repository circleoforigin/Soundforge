import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { ContinuousAudioStream } from '../ContinuousAudioStream.ts';

test('externally clocked endpoint encoder generates no private PCM and accepts authoritative frames', async () => {
  const stream = new ContinuousAudioStream('external-test', { encodingProfileId: 'aac-adts', externalPcmSource: true });
  stream.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(stream.getSnapshot().encoder.framesGenerated, 0);
  const silence = Buffer.alloc(48_000 * 0.02 * 2 * 2);
  const timer = setInterval(() => stream.writeExternalPcmFrame(silence, performance.now()), 20);
  try {
    await stream.waitUntilReadyForClient();
    assert.ok(stream.getSnapshot().encoder.framesGenerated > 0);
  } finally {
    clearInterval(timer);
    stream.stop('test complete');
  }
});
