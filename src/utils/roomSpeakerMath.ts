import type { Room } from '../models/Room';

import {
  getAngleFromCenter,
  getDistanceFromCenter,
  type SoundPosition,
} from './soundStageMath';

export interface SpeakerGeometry {
  speakerId: string;

  position: SoundPosition;

  angleDegrees: number;
  distanceFromCenter: number;
}

export function getRoomSpeakerGeometry(
  room: Room
): SpeakerGeometry[] {
  return room.speakers.map((speaker) => {
    const position: SoundPosition = {
      x:
        room.offset.x +
        speaker.position.x,

      y:
        room.offset.y +
        speaker.position.y,
    };

    return {
      speakerId: speaker.speakerId,

      position,

      angleDegrees:
        getAngleFromCenter(position),

      distanceFromCenter:
        getDistanceFromCenter(position),
    };
  });
}