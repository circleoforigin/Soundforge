import type { PersistentEntity } from './PersistentEntity';

export type SpatialOutputMode = 'balanced' | 'fullSpatial';

export interface SpeakerMap extends PersistentEntity {
  name: string;
  adapterType: string;
  spatialOutputMode: SpatialOutputMode;
  speakers: MappedSpeaker[];
}

export interface MappedSpeaker {
  speakerId: string;
  deviceId: string;
  displayName: string;

  enabled: boolean;
  trim: number;
}
