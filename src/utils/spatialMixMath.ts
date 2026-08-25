import type { SoundPosition } from './soundStageMath.ts';

import {
  getAngleFromCenter,
  getAttenuation,
  getDistanceFromCenter,
} from './soundStageMath.ts';

interface SpeakerGeometry {
  speakerId: string;
  angleDegrees: number;
  distanceFromCenter: number;
}

export interface SpeakerMix {
  speakerId: string;
  /** Final spatial contribution, including Soundstage attenuation but not node gainDb. */
  gain: number;
}

interface IndexedSpeaker { index: number; angle: number; }

function normalizeAngle(angle: number): number {
  const normalized = angle % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function normalizeConstantPower(gains: number[]): number[] {
  const magnitude = Math.sqrt(gains.reduce((sum, gain) => sum + gain * gain, 0));
  return magnitude > 0 ? gains.map((gain) => gain / magnitude) : gains.map(() => 0);
}

function getBroadMix(speakers: SpeakerGeometry[]): number[] {
  const maxDistance = Math.max(0, ...speakers.map((speaker) => speaker.distanceFromCenter));
  const weights = speakers.map((speaker) => {
    if (maxDistance <= 0) return 1;
    // Retain the existing mild radius compensation without allowing it to change total power.
    return 0.75 + (speaker.distanceFromCenter / maxDistance) * 0.25;
  });
  return normalizeConstantPower(weights);
}

function getBracketingPairMix(nodeAngle: number, speakers: SpeakerGeometry[]): number[] {
  const gains = speakers.map(() => 0);
  if (speakers.length === 1) { gains[0] = 1; return gains; }

  const sorted: IndexedSpeaker[] = speakers
    .map((speaker, index) => ({ index, angle: normalizeAngle(speaker.angleDegrees) }))
    .sort((a, b) => a.angle - b.angle || a.index - b.index);
  const angle = normalizeAngle(nodeAngle);
  let upperIndex = sorted.findIndex((speaker) => speaker.angle >= angle);
  if (upperIndex < 0) upperIndex = 0;
  const upper = sorted[upperIndex];
  const lower = sorted[(upperIndex - 1 + sorted.length) % sorted.length];
  const sectorSize = normalizeAngle(upper.angle - lower.angle);

  if (sectorSize <= 1e-9) {
    gains[upper.index] = 1;
    return gains;
  }

  const positionInSector = normalizeAngle(angle - lower.angle);
  const t = Math.max(0, Math.min(1, positionInSector / sectorSize));
  gains[lower.index] = Math.cos(t * Math.PI / 2);
  gains[upper.index] = Math.sin(t * Math.PI / 2);
  return gains;
}

export function getSpeakerMix(
  nodePosition: SoundPosition,
  speakers: SpeakerGeometry[],
  centerRadius: number,
  fullVolumeRadius: number
): SpeakerMix[] {
  if (speakers.length === 0) return [];

  const nodeDistance = getDistanceFromCenter(nodePosition);
  const attenuation = getAttenuation(nodePosition, fullVolumeRadius);
  const broadMix = getBroadMix(speakers);
  const pairMix = getBracketingPairMix(getAngleFromCenter(nodePosition), speakers);
  let spatialGains: number[];

  if (nodeDistance <= centerRadius) {
    spatialGains = broadMix;
  } else if (nodeDistance >= fullVolumeRadius || fullVolumeRadius <= centerRadius) {
    spatialGains = pairMix;
  } else {
    const linearFocus = Math.max(0, Math.min(1,
      (nodeDistance - centerRadius) / (fullVolumeRadius - centerRadius)
    ));
    const focus = linearFocus * linearFocus * (3 - 2 * linearFocus);
    spatialGains = normalizeConstantPower(broadMix.map((broadGain, index) =>
      broadGain * (1 - focus) + pairMix[index] * focus
    ));
  }

  return speakers.map((speaker, index) => ({
    speakerId: speaker.speakerId,
    gain: spatialGains[index] * attenuation,
  }));
}
