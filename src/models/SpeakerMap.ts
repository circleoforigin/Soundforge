import type { PersistentEntity } from './PersistentEntity';

export interface SpeakerMap extends PersistentEntity {
  name: string;
  adapterType: string;
  speakers: MappedSpeaker[];
}

export interface MappedSpeaker {
  speakerId: string;
  deviceId: string;
  displayName: string;

  enabled: boolean;
  trim: number;
}