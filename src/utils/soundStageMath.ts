export interface SoundPosition {
  x: number;
  y: number;
}

export type SoundStageZone =
  | 'center'
  | 'directional'
  | 'falloff';

export function getDistanceFromCenter(
  position: SoundPosition
): number {
  return Math.sqrt(
    position.x * position.x +
    position.y * position.y
  );
}

export function getAngleFromCenter(
  position: SoundPosition
): number {
  let angle =
    Math.atan2(position.x, position.y) *
    (180 / Math.PI);

  if (angle < 0) {
    angle += 360;
  }

  return angle;
}

export function getSoundStageZone(
  position: SoundPosition,
  centerRadius: number,
  fullVolumeRadius: number
): SoundStageZone {
  const distance = getDistanceFromCenter(position);

  if (distance <= centerRadius) {
    return 'center';
  }

  if (distance <= fullVolumeRadius) {
    return 'directional';
  }

  return 'falloff';
}

export function getAttenuation(
  position: SoundPosition,
  fullVolumeRadius: number,
  silenceThreshold = 0.08
): number {
  const distance = getDistanceFromCenter(position);

  if (distance <= fullVolumeRadius) {
    return 1;
  }

  let attenuation =
    1 -
    (distance - fullVolumeRadius) /
      (1 - fullVolumeRadius);

  attenuation = Math.max(
    0,
    Math.min(1, attenuation)
  );

  if (attenuation <= silenceThreshold) {
    return 0;
  }

  return attenuation;
}

export function clampPositionToRadius(
  position: SoundPosition,
  maxRadius: number
): SoundPosition {
  const distance = getDistanceFromCenter(position);

  if (distance <= maxRadius || distance === 0) {
    return position;
  }

  const scale = maxRadius / distance;

  return {
    x: position.x * scale,
    y: position.y * scale,
  };
}