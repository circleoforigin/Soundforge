import type { SceneObjectInstance } from './SceneObjectInstance';

export interface SceneDefinition {
  positionalObjects: SceneObjectInstance[];
  ambientObjects: SceneObjectInstance[];
}