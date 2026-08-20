import type { SceneObjectInstance } from './SceneObjectInstance';
import type { DeployedSceneObjectInstance } from './DeployedSceneObjectInstance';

export interface SceneDefinition {
  positionalObjects: SceneObjectInstance[];
  ambientObjects: SceneObjectInstance[];
  deployedObjects?: DeployedSceneObjectInstance[];
}
