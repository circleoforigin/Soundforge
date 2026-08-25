import type {
  SpeakerMap,
} from '../models/SpeakerMap';

import {
  normalizeSpeakerMap,
} from './SpeakerMapNormalization';

import {
  localStorageService,
} from '../storage/LocalStorageService';

import {
  hostedCollectionRepository,
} from '../host/HostedCollectionRepository';

const SPEAKER_MAPS_KEY =
  'speakerMaps';

const SPEAKER_MAPS_COLLECTION =
  'speakerMaps';

export class SpeakerMapRepository {
  async loadSpeakerMaps(): Promise<SpeakerMap[]> {
    if (
      hostedCollectionRepository.hosted
    ) {
      const maps =
        await hostedCollectionRepository
          .loadAll<SpeakerMap>(
            SPEAKER_MAPS_COLLECTION
          );

      if (!Array.isArray(maps)) {
        return [];
      }

      return maps.map(
        normalizeSpeakerMap
      );
    }

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

    const normalizedMaps =
      maps.map(
        normalizeSpeakerMap
      );

    if (
      maps.some(
        (map) =>
          !map.spatialOutputMode
      )
    ) {
      localStorageService.set(
        SPEAKER_MAPS_KEY,
        normalizedMaps
      );
    }

    return normalizedMaps;
  }

  async saveSpeakerMap(
    speakerMap: SpeakerMap
  ): Promise<SpeakerMap[]> {
    const normalizedSpeakerMap =
      normalizeSpeakerMap(
        speakerMap
      );

    if (
      hostedCollectionRepository.hosted
    ) {
      await hostedCollectionRepository.save(
        SPEAKER_MAPS_COLLECTION,
        normalizedSpeakerMap.id,
        normalizedSpeakerMap
      );

      return this.loadSpeakerMaps();
    }

    const maps =
      await this.loadSpeakerMaps();

    const exists =
      maps.some(
        (map) =>
          map.id ===
          normalizedSpeakerMap.id
      );

    const updatedMaps =
      exists
        ? maps.map(
            (map) =>
              map.id ===
              normalizedSpeakerMap.id
                ? normalizedSpeakerMap
                : map
          )
        : [
            ...maps,
            normalizedSpeakerMap,
          ];

    localStorageService.set(
      SPEAKER_MAPS_KEY,
      updatedMaps
    );

    return updatedMaps;
  }

  async deleteSpeakerMap(
    speakerMapId: string
  ): Promise<SpeakerMap[]> {
    if (
      hostedCollectionRepository.hosted
    ) {
      await hostedCollectionRepository.delete(
        SPEAKER_MAPS_COLLECTION,
        speakerMapId
      );

      return this.loadSpeakerMaps();
    }

    const maps =
      await this.loadSpeakerMaps();

    const updatedMaps =
      maps.filter(
        (map) =>
          map.id !==
          speakerMapId
      );

    localStorageService.set(
      SPEAKER_MAPS_KEY,
      updatedMaps
    );

    return updatedMaps;
  }
}

export const speakerMapRepository =
  new SpeakerMapRepository();