import type { PlaybackMode } from './SoundObjectTemplate';

export interface SceneObjectInstance {
  instanceId: string;

  /**
   * Template this node was originally created from.
   * Undefined if the node was configured directly from a SoundAsset.
   */
  templateId?: string;

  /**
   * Display name for this particular node in this scene.
   */
  instanceName?: string;

  /**
   * Audio assets used by this node.
   * For a basic sound node this will usually contain one asset.
   * Future randomized objects may contain several.
   */
  soundAssetIds: string[];

  /**
   * How this instance plays its sound.
   */
  playbackMode: PlaybackMode;

  /**
    * Per-node source gain trim in decibels.
    * 0 = unchanged, negative = quieter, positive = louder.
    */
  gainDb: number;

  /**
   * Position on the SoundStage.
   *
   * Ambient nodes also keep a position because their position
   * determines where their UI node appears outside the sound field.
   */
  position?: {
    x: number;
    y: number;
  };

  muted: boolean;
}