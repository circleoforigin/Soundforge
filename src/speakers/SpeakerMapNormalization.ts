import type { SpeakerMap } from '../models/SpeakerMap.ts';

export function normalizeSpeakerMap(map: SpeakerMap): SpeakerMap {
  return {
    ...map,
    spatialOutputMode: map.spatialOutputMode ??
      (map.adapterType === 'sonos' ? 'balanced' : 'fullSpatial'),
    speakers: map.speakers.map((speaker) => ({
      ...speaker,
      providerId: speaker.providerId ?? map.adapterType,
    })),
  };
}
