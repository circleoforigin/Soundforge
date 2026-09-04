import type { SceneDefinition } from './SceneDefinition.ts';

export type SceneTransitionMode =
  | 'crossfade'
  | 'sequential'
  | 'immediate';

export interface SceneInstance extends SceneDefinition {
  instanceId: string;

  /**
   * ID of the template this scene originally came from.
   * Undefined if the scene was created from scratch.
   */
  templateId?: string;

  instanceName: string;
  description?: string;
  transitionMode?: SceneTransitionMode;
  onLoadOneShotAssetId?: string;

  volume: {
    master: number;
    oneShot: number;
    loop: number;
    ambience: number;
  };

  fadeInMs: number;
  fadeOutMs: number;
}
