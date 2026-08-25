import type { LibraryEntity } from './PersistentEntity.ts';

export type PlaybackMode = 'oneShot' | 'loop';
export type SpatialMode = 'positional' | 'ambient'

export interface SoundObjectTemplate extends LibraryEntity {    
  soundAssetIds: string[];
  playbackMode: PlaybackMode;
  spatialMode: SpatialMode;
}

