import type { RoomSpeakerPosition } from '../models/Room.ts';
import type { MappedSpeaker } from '../models/SpeakerMap.ts';

function createUnassignedMappedSpeaker(speaker: RoomSpeakerPosition): MappedSpeaker {
  return {
    speakerId: speaker.speakerId,
    deviceId: '',
    displayName: speaker.name,
    enabled: true,
    trim: 0,
  };
}

export function reconcileMappedSpeakerSlots(
  roomSpeakers: RoomSpeakerPosition[],
  mappedSpeakers: MappedSpeaker[]
): MappedSpeaker[] {
  const mappedBySpeakerId = new Map(
    mappedSpeakers.map((speaker) => [speaker.speakerId, speaker])
  );
  return roomSpeakers.map(
    (speaker) => mappedBySpeakerId.get(speaker.speakerId) ?? createUnassignedMappedSpeaker(speaker)
  );
}

export function addMappedSpeakerSlot(
  mappedSpeakers: MappedSpeaker[],
  speaker: RoomSpeakerPosition
): MappedSpeaker[] {
  return mappedSpeakers.some((mappedSpeaker) => mappedSpeaker.speakerId === speaker.speakerId)
    ? mappedSpeakers
    : [...mappedSpeakers, createUnassignedMappedSpeaker(speaker)];
}

export function removeMappedSpeakerSlot(
  mappedSpeakers: MappedSpeaker[],
  speakerId: string
): MappedSpeaker[] {
  return mappedSpeakers.filter((speaker) => speaker.speakerId !== speakerId);
}
