import assert from 'node:assert/strict';
import test from 'node:test';
import { getSpeakerMix } from '../../../src/utils/spatialMixMath.ts';

interface SpeakerGeometry {
  speakerId: string;
  position: { x: number; y: number };
  angleDegrees: number;
  distanceFromCenter: number;
}

const CENTER_RADIUS = 0.2;
const FULL_RADIUS = 0.6;
const EPSILON = 1e-8;

function position(angle: number, radius: number) {
  const radians = angle * Math.PI / 180;
  return { x: Math.sin(radians) * radius, y: Math.cos(radians) * radius };
}

function speaker(speakerId: string, angle: number, radius = 0.8): SpeakerGeometry {
  return { speakerId, angleDegrees: angle, distanceFromCenter: radius, position: position(angle, radius) };
}

function gains(angle: number, radius: number, speakers: SpeakerGeometry[]) {
  return Object.fromEntries(getSpeakerMix(
    position(angle, radius), speakers, CENTER_RADIUS, FULL_RADIUS
  ).map((item) => [item.speakerId, item.gain]));
}

function power(values: Record<string, number>): number {
  return Object.values(values).reduce((sum, gain) => sum + gain * gain, 0);
}

const four = [speaker('north', 0), speaker('east', 90), speaker('south', 180), speaker('west', 270)];

test('center mix is broad, equal, and constant-power for symmetrical speakers', () => {
  const result = gains(0, 0, four);
  assert.deepEqual(Object.values(result).map((gain) => Math.round(gain * 1e6) / 1e6), [0.5, 0.5, 0.5, 0.5]);
  assert.ok(Math.abs(power(result) - 1) < EPSILON);
});

test('outer mix uses only the angular bracketing pair with equal-power interpolation', () => {
  const halfway = gains(45, FULL_RADIUS, four);
  assert.ok(Math.abs(halfway.north - Math.SQRT1_2) < EPSILON);
  assert.ok(Math.abs(halfway.east - Math.SQRT1_2) < EPSILON);
  assert.equal(halfway.south, 0); assert.equal(halfway.west, 0);
  const aligned = gains(90, FULL_RADIUS, four);
  assert.ok(Math.abs(aligned.east - 1) < EPSILON);
  assert.ok(Math.abs(aligned.north) < EPSILON);
  assert.equal(aligned.south, 0); assert.equal(aligned.west, 0);
});

test('mid zone smoothly focuses the primary pair and suppresses irrelevant speakers', () => {
  const inner = gains(45, CENTER_RADIUS + 0.05, four);
  const outer = gains(45, FULL_RADIUS - 0.05, four);
  assert.ok(outer.south < inner.south); assert.ok(outer.west < inner.west);
  assert.ok(outer.north / outer.south > inner.north / inner.south);
  assert.ok(Math.abs(power(inner) - 1) < EPSILON);
  assert.ok(Math.abs(power(outer) - 1) < EPSILON);
});

test('mix is continuous at center and full-volume boundaries', () => {
  for (const boundary of [CENTER_RADIUS, FULL_RADIUS]) {
    const before = gains(37, boundary - 1e-7, four);
    const after = gains(37, boundary + 1e-7, four);
    for (const id of Object.keys(before)) assert.ok(Math.abs(before[id] - after[id]) < 1e-5);
  }
  const nearOuter = gains(37, FULL_RADIUS - 1e-7, four);
  assert.ok(nearOuter.south < 1e-10); assert.ok(nearOuter.west < 1e-10);
});

test('angular bracketing handles wraparound and irregular spacing', () => {
  const irregular = [speaker('twenty', 20), speaker('one-ten', 110), speaker('two-oh-five', 205), speaker('three-hundred', 300)];
  const result = gains(350, FULL_RADIUS, irregular);
  assert.ok(result.twenty > 0); assert.ok(result['three-hundred'] > 0);
  assert.equal(result['one-ten'], 0); assert.equal(result['two-oh-five'], 0);
});

test('one, two, and three-speaker geometries remain finite and constant-power', () => {
  for (const speakers of [
    [speaker('only', 15)],
    [speaker('a', 10), speaker('b', 210)],
    [speaker('a', 15), speaker('b', 140), speaker('c', 275)],
  ]) {
    const result = gains(100, FULL_RADIUS, speakers);
    assert.ok(Object.values(result).every(Number.isFinite));
    assert.ok(Math.abs(power(result) - 1) < EPSILON);
    assert.ok(Object.values(result).filter((gain) => gain > 0).length <= 2);
  }
});

test('nearly identical speaker angles never produce NaN or Infinity', () => {
  const result = gains(30, FULL_RADIUS, [speaker('a', 30), speaker('b', 30 + 1e-12), speaker('c', 200)]);
  assert.ok(Object.values(result).every(Number.isFinite));
  assert.ok(Object.values(result).filter((gain) => gain > 0).length <= 2);
});

test('global attenuation remains separate from normalized spatial distribution', () => {
  const result = gains(45, 0.8, four);
  assert.ok(Math.abs(Math.sqrt(power(result)) - 0.5) < EPSILON);
});
