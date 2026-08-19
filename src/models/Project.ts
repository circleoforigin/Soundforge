import type { PersistentEntity } from './PersistentEntity';
import type { SceneInstance } from './SceneInstance';

export interface Project extends PersistentEntity {
  name: string;
  scenes: SceneInstance[];
  activeSceneInstanceId?: string;
}