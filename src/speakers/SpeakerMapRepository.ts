import type { SpeakerMap } from '../models/SpeakerMap';

import {
  localStorageService,
} from '../storage/LocalStorageService';

const SPEAKER_MAPS_KEY =
  'speakerMaps';

function normalizeSpeakerMap(map: SpeakerMap): SpeakerMap {
  return {
    ...map,
    spatialOutputMode:
      map.spatialOutputMode ??
      (map.adapterType === 'sonos' ? 'balanced' : 'fullSpatial'),
  };
}

export class SpeakerMapRepository {
  loadSpeakerMaps(): SpeakerMap[] {
    const maps =
      localStorageService.get<
        SpeakerMap[]
      >(
        SPEAKER_MAPS_KEY,
        []
      );

    if (!Array.isArray(maps)) {
      return [];
    }

    const normalizedMaps = maps.map(normalizeSpeakerMap);

    if (maps.some((map) => !map.spatialOutputMode)) {
      this.saveSpeakerMaps(normalizedMaps);
    }

    return normalizedMaps;
  }

  saveSpeakerMaps(
    maps: SpeakerMap[]
  ): void {
    localStorageService.set(
      SPEAKER_MAPS_KEY,
      maps
    );
  }

  saveSpeakerMap(
    speakerMap: SpeakerMap
  ): SpeakerMap[] {
    const normalizedSpeakerMap = normalizeSpeakerMap(speakerMap);
    const maps =
      this.loadSpeakerMaps();

    const exists =
      maps.some(
        (map) =>
          map.id === normalizedSpeakerMap.id
      );

    const updatedMaps =
      exists
        ? maps.map((map) =>
            map.id === normalizedSpeakerMap.id
              ? normalizedSpeakerMap
              : map
          )
        : [
            ...maps,
            normalizedSpeakerMap,
          ];

    this.saveSpeakerMaps(
      updatedMaps
    );

    return updatedMaps;
  }

  deleteSpeakerMap(
    speakerMapId: string
  ): SpeakerMap[] {
    const updatedMaps =
      this.loadSpeakerMaps().filter(
        (map) =>
          map.id !== speakerMapId
      );

    this.saveSpeakerMaps(
      updatedMaps
    );

    return updatedMaps;
  }
}

export const speakerMapRepository =
  new SpeakerMapRepository();
