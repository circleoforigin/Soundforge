import type { LibraryEntity } from './PersistentEntity';
import type { SceneDefinition } from './SceneDefinition';

export interface SceneTemplate
  extends LibraryEntity, SceneDefinition {
}