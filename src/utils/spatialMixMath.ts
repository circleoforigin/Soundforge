import type { SoundPosition } from './soundStageMath';
import type { SpeakerGeometry } from './roomSpeakerMath';

import {
  getAngleFromCenter,
  getAttenuation,
  getDistanceFromCenter,
} from './soundStageMath';

export interface SpeakerMix {
  speakerId: string;

  /**
   * Final normalized contribution for this speaker.
   *
   * 0 = silent
   * 1 = full contribution
   *
   * This does NOT include the node's gainDb trim.
   */
  gain: number;
}

function getAngularDifference(
  angleA: number,
  angleB: number
): number {
  const difference =
    Math.abs(angleA - angleB) % 360;

  return difference > 180
    ? 360 - difference
    : difference;
}

function getSpeakerBalanceWeight(
  distanceFromCenter: number,
  maxDistance: number
): number {
  if (maxDistance <= 0) {
    return 1;
  }

  /*
   * A farther speaker receives slightly more baseline weight
   * so sounds placed in the center feel more balanced.
   *
   * This is intentionally mild for now.
   */
  const normalizedDistance =
    distanceFromCenter / maxDistance;

  return 0.75 + normalizedDistance * 0.25;
}

export function getSpeakerMix(
  nodePosition: SoundPosition,
  speakers: SpeakerGeometry[],
  centerRadius: number,
  fullVolumeRadius: number
): SpeakerMix[] {
  if (speakers.length === 0) {
    return [];
  }

  const nodeDistance =
    getDistanceFromCenter(nodePosition);

  const nodeAngle =
    getAngleFromCenter(nodePosition);

  const attenuation =
    getAttenuation(
      nodePosition,
      fullVolumeRadius
    );

  const maxSpeakerDistance =
    Math.max(
      ...speakers.map(
        (speaker) =>
          speaker.distanceFromCenter
      )
    );

  /*
   * Directionality strength:
   *
   * Inside center radius:
   * 0 = no directional bias
   *
   * Between center and full-volume radius:
   * ramps smoothly from 0 to 1
   *
   * Outside full-volume radius:
   * stays at full directional strength
   */
  let directionalStrength = 0;

  if (nodeDistance > centerRadius) {
    directionalStrength =
      (nodeDistance - centerRadius) /
      (fullVolumeRadius - centerRadius);

    directionalStrength =
      Math.max(
        0,
        Math.min(1, directionalStrength)
      );
  }

  const rawWeights =
    speakers.map((speaker) => {
      const balanceWeight =
        getSpeakerBalanceWeight(
          speaker.distanceFromCenter,
          maxSpeakerDistance
        );

      const angularDifference =
        getAngularDifference(
          nodeAngle,
          speaker.angleDegrees
        );

      /*
       * Directional contribution:
       *
       * same direction = 1
       * opposite direction = 0
       */
      const fullyDirectionalWeight =
        Math.max(
          0,
          1 - angularDifference / 180
        );

      /*
       * Blend between:
       *
       * 1.0 = no directionality
       * fullyDirectionalWeight = maximum directionality
       *
       * directionalStrength determines how far
       * between those two states we are.
       */
      const directionalWeight =
        1 -
        directionalStrength *
          (1 - fullyDirectionalWeight);

      return {
        speakerId: speaker.speakerId,

        weight:
          directionalWeight *
          balanceWeight,
      };
    });

  const maxWeight =
    Math.max(
      ...rawWeights.map(
        (item) => item.weight
      )
    );

  return rawWeights.map((item) => ({
    speakerId: item.speakerId,

    gain:
      maxWeight > 0
        ? (item.weight / maxWeight) *
          attenuation
        : 0,
  }));
}