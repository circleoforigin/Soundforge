import type { MappedSpeaker } from '../models/SpeakerMap.ts';
import type { SpeakerGeometry } from './roomSpeakerMath.ts';
import {
  getAttenuation,
  getDistanceFromCenter,
  type SoundPosition,
} from './soundStageMath.ts';
import type { SpeakerMix } from './spatialMixMath.ts';

function getEnabledMappedGeometry(
  mappedSpeakers: MappedSpeaker[],
  speakerGeometry: SpeakerGeometry[]
): SpeakerGeometry[] {
  const enabledSpeakerIds = new Set(
    mappedSpeakers
      .filter((speaker) => speaker.enabled && Boolean(speaker.deviceId))
      .map((speaker) => speaker.speakerId)
  );

  return speakerGeometry.filter((speaker) => enabledSpeakerIds.has(speaker.speakerId));
}

export function getBalancedFieldAmbienceMix(
  mappedSpeakers: MappedSpeaker[]
): SpeakerMix[] {
  return mappedSpeakers
    .filter((speaker) => speaker.enabled && Boolean(speaker.deviceId))
    .map((speaker) => ({ speakerId: speaker.speakerId, gain: 1 }));
}

export function getBalancedFieldPositionalMix(
  position: SoundPosition,
  mappedSpeakers: MappedSpeaker[],
  speakerGeometry: SpeakerGeometry[],
  centerRadius: number,
  fullVolumeRadius: number
): SpeakerMix[] {
  const enabledGeometry = getEnabledMappedGeometry(mappedSpeakers, speakerGeometry);

  if (enabledGeometry.length === 0) {
    throw new Error('No enabled Sonos speakers are assigned to this Room.');
  }

  if (getDistanceFromCenter(position) <= centerRadius) {
    return enabledGeometry.map((speaker) => ({
      speakerId: speaker.speakerId,
      gain: 1,
    }));
  }

  const closestSpeaker = enabledGeometry.reduce<SpeakerGeometry | null>(
    (closest, speaker) => {
      if (!closest) {
        return speaker;
      }

      const speakerDistance = Math.hypot(
        position.x - speaker.position.x,
        position.y - speaker.position.y
      );
      const closestDistance = Math.hypot(
        position.x - closest.position.x,
        position.y - closest.position.y
      );
      return speakerDistance < closestDistance ? speaker : closest;
    },
    null
  );

  if (!closestSpeaker) {
    throw new Error('Unable to determine the closest enabled Sonos speaker.');
  }

  return [{
    speakerId: closestSpeaker.speakerId,
    gain: getAttenuation(position, fullVolumeRadius),
  }];
}
