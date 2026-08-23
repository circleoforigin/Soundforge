import type { SceneInstance } from '../models/SceneInstance.ts';
import { roomAudioVolumeSignature } from './RoomAudioControlPlane.ts';

export function soundStageVolumeSignature(scene: SceneInstance): string {
  return `${scene.instanceId}|${roomAudioVolumeSignature(scene.volume)}`;
}

export function soundStageNodeGainSignature(scene: SceneInstance): string {
  return `${scene.instanceId}|${[...scene.positionalObjects, ...scene.ambientObjects]
    .map((node) => `${node.instanceId}:${node.gainDb ?? 0}:${node.muted ? 1 : 0}`).join('|')}`;
}
