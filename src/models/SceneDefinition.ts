import type { SceneObjectInstance } from './SceneObjectInstance.ts';
import type {
  DeployedSceneObjectInstance,
} from './DeployedSceneObjectInstance.ts';

export interface SceneDefinition {
  positionalObjects: SceneObjectInstance[];
  ambientObjects: SceneObjectInstance[];
  deployedObjects?: DeployedSceneObjectInstance[];
}
