import assert from 'node:assert/strict';
import test from 'node:test';
import { advancePcmScheduler } from '../ContinuousAudioStream.ts';

test('20 ms Room PCM schedule remains realtime over a simulated five minutes', () => {
  let next = 0; let frames = 0;
  for (let wallTime = 0; wallTime <= 300_000; wallTime += 5) {
    const result = advancePcmScheduler(next, wallTime, 20, () => { frames += 1; return true; });
    next = result.nextFrameMonotonicTime;
  }
  const generatedAudioMs = frames * 20;
  assert.ok(Math.abs(generatedAudioMs - 300_000) <= 20, `drift was ${generatedAudioMs - 300_000} ms`);
  assert.equal(next, 300_020);
});
