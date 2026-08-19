import type { SpeakerMap } from '../models/SpeakerMap';

import {
  localStorageService,
} from '../storage/LocalStorageService';

const SPEAKER_MAPS_KEY =
  'speakerMaps';

export class SpeakerMapRepository {
  loadSpeakerMaps(): SpeakerMap[] {
    const maps =
      localStorageService.get<
        SpeakerMap[]
      >(
        SPEAKER_MAPS_KEY,
        []
      );

    return Array.isArray(maps)
      ? maps
      : [];
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
    const maps =
      this.loadSpeakerMaps();

    const exists =
      maps.some(
        (map) =>
          map.id === speakerMap.id
      );

    const updatedMaps =
      exists
        ? maps.map((map) =>
            map.id === speakerMap.id
              ? speakerMap
              : map
          )
        : [
            ...maps,
            speakerMap,
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