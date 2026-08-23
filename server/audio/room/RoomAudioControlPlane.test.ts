import assert from 'node:assert/strict';
import test from 'node:test';
import type { SceneInstance } from '../../../src/models/SceneInstance.ts';
import {
  BoundedControlRequestScheduler, LatestValueDispatcher,
  roomAudioGainSignature, roomAudioVolumeSignature, SuccessfulControlStateDeduplicator,
  ControlFailureAccumulator,
} from '../../../src/audio/RoomAudioControlPlane.ts';
import { soundStageNodeGainSignature, soundStageVolumeSignature } from '../../../src/audio/SoundStageControlState.ts';

const baseScene = {
  instanceId: 'scene', templateId: 'template', instanceName: 'Scene', description: '',
  positionalObjects: [{ instanceId: 'node', position: { x: 0, y: 0 }, gainDb: 0, muted: false }],
  ambientObjects: [], volume: { master: 1, oneShot: 1, loop: 1, ambience: 1 },
} as unknown as SceneInstance;

test('SoundStage control signatures ignore position-only changes', () => {
  const moved = { ...baseScene, positionalObjects: [{ ...baseScene.positionalObjects[0], position: { x: 0.8, y: -0.2 } }] };
  assert.equal(soundStageVolumeSignature(moved), soundStageVolumeSignature(baseScene));
  assert.equal(soundStageNodeGainSignature(moved), soundStageNodeGainSignature(baseScene));
});

test('representative 500-event pure drag creates zero unrelated volume or gain synchronizations', () => {
  let previousVolume = soundStageVolumeSignature(baseScene);
  let previousGain = soundStageNodeGainSignature(baseScene);
  let volumeUpdates = 0; let gainUpdates = 0;
  for (let index = 0; index < 500; index += 1) {
    const moved = { ...baseScene, positionalObjects: [{ ...baseScene.positionalObjects[0], position: { x: index / 500, y: 0 } }] };
    const volume = soundStageVolumeSignature(moved); const gain = soundStageNodeGainSignature(moved);
    if (volume !== previousVolume) volumeUpdates += 1;
    if (gain !== previousGain) gainUpdates += 1;
    previousVolume = volume; previousGain = gain;
  }
  assert.equal(volumeUpdates, 0); assert.equal(gainUpdates, 0);
});

test('SoundStage signatures detect actual scene volume, gain, and mute changes', () => {
  assert.notEqual(soundStageVolumeSignature({ ...baseScene, volume: { ...baseScene.volume, master: 0.5 } }), soundStageVolumeSignature(baseScene));
  assert.notEqual(soundStageNodeGainSignature({ ...baseScene, positionalObjects: [{ ...baseScene.positionalObjects[0], gainDb: -3 }] }), soundStageNodeGainSignature(baseScene));
  assert.notEqual(soundStageNodeGainSignature({ ...baseScene, positionalObjects: [{ ...baseScene.positionalObjects[0], muted: true }] }), soundStageNodeGainSignature(baseScene));
  assert.equal(roomAudioVolumeSignature(baseScene.volume), roomAudioVolumeSignature({ ...baseScene.volume }));
  assert.equal(roomAudioGainSignature(0, false), roomAudioGainSignature(0, false));
});

test('500 position values over two seconds are latest-value-wins and bounded to 50 Hz', async (t) => {
  const sent: number[] = [];
  const dispatcher = new LatestValueDispatcher<number>(async (value) => { sent.push(value); }, 20);
  const requests: Promise<void>[] = [];
  for (let batch = 0; batch < 100; batch += 1) {
    for (let offset = 0; offset < 5; offset += 1) requests.push(dispatcher.submit(batch * 5 + offset));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await Promise.all(requests);
  assert.equal(sent.at(-1), 499);
  assert.ok(sent.length <= 110, `sent ${sent.length} updates`);
  assert.equal(dispatcher.requested, 500);
  assert.ok(dispatcher.coalesced >= 380);
  t.diagnostic(`500 requested; ${sent.length} sent; ${dispatcher.coalesced} coalesced`);
});

test('control request scheduler enforces maximum concurrency', async () => {
  const scheduler = new BoundedControlRequestScheduler(4); let active = 0; let observed = 0;
  await Promise.all(Array.from({ length: 40 }, () => scheduler.schedule(async () => {
    active += 1; observed = Math.max(observed, active); await new Promise((resolve) => setTimeout(resolve, 2)); active -= 1;
  })));
  assert.equal(observed, 4); assert.equal(scheduler.maxObservedConcurrency, 4);
});

test('unrelated playback creation remains outside a saturated control queue', async () => {
  const scheduler = new BoundedControlRequestScheduler(4);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const controls = Array.from({ length: 8 }, () => scheduler.schedule(() => blocked));
  await Promise.resolve();
  const playbackCreation = Promise.resolve('created');
  assert.equal(await playbackCreation, 'created');
  release(); await Promise.all(controls);
});

test('identical pending and successfully applied control states are deduplicated', () => {
  const state = new SuccessfulControlStateDeduplicator();
  assert.equal(state.begin('scene', '1|1|1|1'), true);
  assert.equal(state.begin('scene', '1|1|1|1'), false);
  state.succeed('scene', '1|1|1|1');
  assert.equal(state.begin('scene', '1|1|1|1'), false);
  assert.equal(state.begin('node', '0|0'), true);
  state.fail('node', '0|0');
  assert.equal(state.begin('node', '0|0'), true, 'failed state must remain retryable');
});

test('repeated control failures collapse into one bounded summary window', () => {
  const failures = new ControlFailureAccumulator(); let firstEntries = 0;
  for (let index = 0; index < 1_000; index += 1) if (failures.record('Failed to fetch', index * 2).first) firstEntries += 1;
  const summary = failures.flush(2_000);
  assert.equal(firstEntries, 1); assert.equal(summary.failureCount, 1_000);
  assert.equal(summary.lastError, 'Failed to fetch'); assert.equal(summary.durationMs, 2_000);
});
