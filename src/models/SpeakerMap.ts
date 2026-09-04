import type { PersistentEntity } from './PersistentEntity.ts';

export type SpatialOutputMode = 'balanced' | 'fullSpatial';

export interface SpeakerMap extends PersistentEntity {
  name: string;
  adapterType: string;
  spatialOutputMode: SpatialOutputMode;
  speakers: MappedSpeaker[];
}

export interface MappedSpeaker {
  speakerId: string;
  /** Provider identity for this endpoint. Falls back to SpeakerMap.adapterType for old saves. */
  providerId?: string;
  deviceId: string;
  displayName: string;

  enabled: boolean;
  trim: number;
}
