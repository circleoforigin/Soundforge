import type {
  SceneInstance,
} from '../models/SceneInstance';

import {
  localStorageService,
} from '../storage/LocalStorageService';

import {
  hostedCollectionRepository,
} from '../host/HostedCollectionRepository';

const SCENES_KEY =
  'scenes';

const SCENES_COLLECTION =
  'scenes';

export class SceneRepository {
  async loadScenes(): Promise<SceneInstance[]> {
    if (hostedCollectionRepository.hosted) {
      const scenes =
        await hostedCollectionRepository
          .loadAll<SceneInstance>(
            SCENES_COLLECTION
          );

      return Array.isArray(scenes)
        ? scenes
        : [];
    }

    const scenes =
      localStorageService.get<SceneInstance[]>(
        SCENES_KEY,
        []
      );

    return Array.isArray(scenes)
      ? scenes
      : [];
  }

  async loadScene(
    sceneId: string
  ): Promise<SceneInstance | null> {
    if (hostedCollectionRepository.hosted) {
      return hostedCollectionRepository
        .loadOne<SceneInstance>(
          SCENES_COLLECTION,
          sceneId
        );
    }

    const scenes =
      await this.loadScenes();

    return (
      scenes.find(
        (scene) =>
          scene.instanceId === sceneId
      ) ?? null
    );
  }

  async saveScene(
    scene: SceneInstance
  ): Promise<void> {
    if (hostedCollectionRepository.hosted) {
      await hostedCollectionRepository.save(
        SCENES_COLLECTION,
        scene.instanceId,
        scene
      );

      return;
    }

    const scenes =
      await this.loadScenes();

    const updatedScenes =
      scenes.some(
        (candidate) =>
          candidate.instanceId === scene.instanceId
      )
        ? scenes.map(
            (candidate) =>
              candidate.instanceId === scene.instanceId
                ? scene
                : candidate
          )
        : [
            ...scenes,
            scene,
          ];

    localStorageService.set(
      SCENES_KEY,
      updatedScenes
    );
  }

  async deleteScene(
    sceneId: string
  ): Promise<void> {
    if (hostedCollectionRepository.hosted) {
      await hostedCollectionRepository.delete(
        SCENES_COLLECTION,
        sceneId
      );

      return;
    }

    const scenes =
      await this.loadScenes();

    localStorageService.set(
      SCENES_KEY,
      scenes.filter(
        (scene) =>
          scene.instanceId !== sceneId
      )
    );
  }
}

export const sceneRepository =
  new SceneRepository();