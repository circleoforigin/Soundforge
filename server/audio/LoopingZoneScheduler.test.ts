import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import type { LoopingZoneSettings, SceneObjectInstance } from '../../src/models/SceneObjectInstance.ts';
import {
  createDefaultLoopingZone,
  getLoopingZoneDelay,
  getLoopingZoneSpawnBounds,
  getLoopingZoneSpawnPoint,
  LoopingZoneScheduler,
  selectLoopingZoneAsset,
} from '../../src/audio/LoopingZoneScheduler.ts';
import { getLoopingZoneOverlayPath } from '../../src/utils/loopingZoneOverlayMath.ts';

function settings(update: Partial<LoopingZoneSettings> = {}): LoopingZoneSettings {
  return {
    enabled: true,
    assets: [{ assetId: 'a', gainDb: 0, weight: 1 }],
    distanceRange: 0,
    arcPositionDegrees: 0,
    frequencyMinMs: 1_000,
    frequencyMaxMs: 3_000,
    pitchMinSemitones: 0,
    pitchMaxSemitones: 0,
    maxConcurrent: 1,
    avoidImmediateRepeat: true,
    ...update,
  };
}

function node(zone = settings()): SceneObjectInstance {
  return {
    instanceId: 'parent', instanceName: 'Birds', soundAssetIds: zone.assets.map((asset) => asset.assetId),
    playbackMode: 'loop', placement: 'field', onLoad: false, fadeInEnabled: false, fadeInMs: 1_000,
    fadeOutEnabled: false, fadeOutMs: 1_000, excludeFromBulkControls: false, randomStart: false,
    gainDb: 0, position: { x: 0.7, y: 0 }, muted: false, loopingZone: zone,
  };
}

test('enabling a Looping Zone preserves node identity and promotes its current sound with defaults', () => {
  const original = node(settings({ assets: [] })); original.soundAssetIds = ['wolf']; original.loopingZone = undefined;
  const zone = createDefaultLoopingZone(original);
  assert.equal(original.instanceId, 'parent');
  assert.deepEqual(zone.assets, [{ assetId: 'wolf', gainDb: 0, weight: 1 }]);
  assert.equal(zone.distanceRange, 0); assert.equal(zone.arcPositionDegrees, 0);
});

test('integer weighted selection and immediate-repeat exclusion preserve relative shares', () => {
  const assets = [
    { assetId: 'a', gainDb: 0, weight: 3 },
    { assetId: 'b', gainDb: 0, weight: 1 },
    { assetId: 'c', gainDb: 0, weight: 1 },
  ];
  assert.equal(selectLoopingZoneAsset(assets, () => 0.1)?.assetId, 'a');
  assert.equal(selectLoopingZoneAsset(assets, () => 0.65)?.assetId, 'b');
  assert.equal(selectLoopingZoneAsset(assets, () => 0.9)?.assetId, 'c');
  assert.equal(selectLoopingZoneAsset(assets, () => 0, 'a', true)?.assetId, 'b');
  assert.equal(selectLoopingZoneAsset(assets, () => 0.99, 'a', true)?.assetId, 'c');
  const equal = assets.map((asset) => ({ ...asset, weight: 1 }));
  assert.equal(selectLoopingZoneAsset(equal, () => 0.1)?.assetId, 'a');
  assert.equal(selectLoopingZoneAsset(equal, () => 0.5)?.assetId, 'b');
  assert.equal(selectLoopingZoneAsset(equal, () => 0.9)?.assetId, 'c');
});

test('distance and arc ranges are total widths and spawning is area-uniform', () => {
  const zone = settings({ distanceRange: 0.2, arcPositionDegrees: 60 });
  const randomValues = [0.5, 0];
  const spawn = getLoopingZoneSpawnPoint({ x: 0.7, y: 0 }, zone, () => randomValues.shift() ?? 0);
  assert.ok(Math.abs(spawn.radius - Math.sqrt(0.5 * (0.8 ** 2 - 0.6 ** 2) + 0.6 ** 2)) < 1e-10);
  assert.ok(Math.abs(spawn.angleDegrees - 60) < 1e-10);
  assert.ok(Math.hypot(spawn.position.x, spawn.position.y) >= 0.6);
  assert.ok(Math.hypot(spawn.position.x, spawn.position.y) <= 0.8);
  const wrapped = getLoopingZoneSpawnPoint(
    { x: Math.sin(350 * Math.PI / 180) * 0.5, y: Math.cos(350 * Math.PI / 180) * 0.5 },
    zone, () => 1
  );
  assert.ok(wrapped.angleDegrees >= 0 && wrapped.angleDegrees < 360);
});

test('shared spawn bounds split total distance and arc widths with clamping and wraparound', () => {
  const sixtyDegrees = { x: Math.sin(Math.PI / 3) * 0.7, y: Math.cos(Math.PI / 3) * 0.7 };
  const bounds = getLoopingZoneSpawnBounds(sixtyDegrees, settings({ distanceRange: 0.2, arcPositionDegrees: 40 }));
  assert.ok(Math.abs(bounds.innerRadius - 0.6) < 1e-10);
  assert.ok(Math.abs(bounds.outerRadius - 0.8) < 1e-10);
  assert.ok(Math.abs(bounds.startAngleDegrees - 40) < 1e-10);
  assert.ok(Math.abs(bounds.endAngleDegrees - 80) < 1e-10);
  const wrapped = getLoopingZoneSpawnBounds(
    { x: Math.sin(350 * Math.PI / 180) * 0.05, y: Math.cos(350 * Math.PI / 180) * 0.05 },
    settings({ distanceRange: 0.2, arcPositionDegrees: 60 })
  );
  assert.equal(wrapped.innerRadius, 0); assert.ok(Math.abs(wrapped.outerRadius - 0.15) < 1e-10);
  assert.ok(Math.abs(wrapped.startAngleDegrees - 320) < 1e-10);
  assert.ok(Math.abs(wrapped.endAngleDegrees - 20) < 1e-10);
  const full = getLoopingZoneSpawnBounds(sixtyDegrees, settings({ arcPositionDegrees: 360 }));
  assert.equal(full.arcWidthDegrees, 360);
});

test('overlay path consumes shared bounds and remains valid for full, zero-arc, and zero-range zones', () => {
  const parent = { x: 0.5, y: 0 };
  const normalBounds = getLoopingZoneSpawnBounds(parent, settings({ distanceRange: 0.2, arcPositionDegrees: 60 }));
  const changedBounds = getLoopingZoneSpawnBounds(parent, settings({ distanceRange: 0.4, arcPositionDegrees: 100 }));
  const normalPath = getLoopingZoneOverlayPath(normalBounds);
  assert.notEqual(normalPath, getLoopingZoneOverlayPath(changedBounds));
  for (const zone of [
    settings({ distanceRange: 0, arcPositionDegrees: 0 }),
    settings({ distanceRange: 0.2, arcPositionDegrees: 360 }),
  ]) {
    const path = getLoopingZoneOverlayPath(getLoopingZoneSpawnBounds(parent, zone));
    assert.ok(path.length > 0); assert.doesNotMatch(path, /NaN|Infinity/);
  }
});

test('frequency rolls independently within normalized bounds', () => {
  const zone = settings({ frequencyMinMs: 1_000, frequencyMaxMs: 3_000 });
  assert.equal(getLoopingZoneDelay(zone, () => 0), 1_000);
  assert.equal(getLoopingZoneDelay(zone, () => 0.5), 2_000);
  assert.equal(getLoopingZoneDelay(zone, () => 1), 3_000);
});

test('first spawn waits normally, concurrency skips without queueing, and stop cancels children and timers', async () => {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const cancelled: number[] = [];
  const spawned: string[] = [];
  const stopped: string[] = [];
  let nextTimerId = 0;
  const scheduler = new LoopingZoneScheduler({
    node: node(), random: () => 0, createId: () => `child-${spawned.length + 1}`,
    schedule(callback, delay) { callbacks.push(callback); delays.push(delay); return ++nextTimerId; },
    cancel(timerId) { cancelled.push(timerId); },
    onSpawn(child) { spawned.push(child.playbackId); },
    onStopChild(playbackId) { stopped.push(playbackId); },
  });
  scheduler.start();
  assert.deepEqual(spawned, []); assert.deepEqual(delays, [1_000]);
  callbacks.shift()?.(); await Promise.resolve();
  assert.deepEqual(spawned, ['child-1']); assert.equal(scheduler.activeChildCount, 1);
  assert.equal(callbacks.length, 1);
  callbacks.shift()?.(); await Promise.resolve();
  assert.deepEqual(spawned, ['child-1']); assert.equal(callbacks.length, 1);
  scheduler.stop();
  assert.deepEqual(stopped, ['child-1']); assert.ok(cancelled.length > 0);
  callbacks.shift()?.(); await Promise.resolve();
  assert.deepEqual(spawned, ['child-1']);
});

test('SoundStage children stay runtime-only and reuse normal one-shot spatial playback', async () => {
  const source = await readFile(new URL('../../src/components/SoundStage.tsx', import.meta.url), 'utf8');
  const startZone = source.match(/function startLoopingZone[\s\S]*?\n {2}function despawnTemporaryDeployment/)?.[0] ?? '';
  assert.match(startZone, /instanceId: child\.playbackId/);
  assert.match(startZone, /playbackMode: 'oneShot'/);
  assert.match(startZone, /position: child\.position/);
  assert.match(startZone, /handleStartNodePlayback\(childNode/);
  assert.doesNotMatch(startZone, /onSceneChange|setTemporaryDeployments/);
  assert.match(source, /node\.playbackMode === 'loop' && node\.loopingZone\?\.enabled/);
  assert.match(source, /const soundAssetId = node\.soundAssetIds\[0\]/);
  assert.match(source, /for \(const scheduler of loopingZoneSchedulersRef\.current\.values\(\)\) scheduler\.stop\(\)/);
  assert.match(source, /selectedDeployedNode\?\.position && selectedDeployedNode\.loopingZone\?\.enabled/);
  assert.match(source, /getLoopingZoneOverlayPath\(getLoopingZoneSpawnBounds/);
});
