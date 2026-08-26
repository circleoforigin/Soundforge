import type {
  SceneInstance,
} from '../models/SceneInstance';

import {
  localStorageService,
} from '../storage/LocalStorageService';

import {
  hostedCollectionRepository,
} from '../host/HostedCollectionRepository';

const TEMPLATES_KEY =
  'sceneTemplates';

const TEMPLATES_COLLECTION =
  'sceneTemplates';

export class SceneTemplateRepository {
  async loadTemplates(): Promise<SceneInstance[]> {
    if (
      hostedCollectionRepository.hosted
    ) {
      const templates =
        await hostedCollectionRepository
          .loadAll<SceneInstance>(
            TEMPLATES_COLLECTION
          );

      return Array.isArray(templates)
        ? templates
        : [];
    }

    const templates =
      localStorageService.get<
        SceneInstance[]
      >(
        TEMPLATES_KEY,
        []
      );

    return Array.isArray(templates)
      ? templates
      : [];
  }

  async loadTemplate(
    templateId: string
  ): Promise<SceneInstance | null> {
    if (
      hostedCollectionRepository.hosted
    ) {
      return hostedCollectionRepository
        .loadOne<SceneInstance>(
          TEMPLATES_COLLECTION,
          templateId
        );
    }

    const templates =
      await this.loadTemplates();

    return (
      templates.find(
        (template) =>
          template.instanceId ===
          templateId
      ) ?? null
    );
  }

  async saveTemplate(
    template: SceneInstance
  ): Promise<void> {
    if (
      hostedCollectionRepository.hosted
    ) {
      await hostedCollectionRepository.save(
        TEMPLATES_COLLECTION,
        template.instanceId,
        template
      );

      return;
    }

    const templates =
      await this.loadTemplates();

    const updatedTemplates =
      templates.some(
        (candidate) =>
          candidate.instanceId ===
          template.instanceId
      )
        ? templates.map(
            (candidate) =>
              candidate.instanceId ===
              template.instanceId
                ? template
                : candidate
          )
        : [
            ...templates,
            template,
          ];

    localStorageService.set(
      TEMPLATES_KEY,
      updatedTemplates
    );
  }

  async deleteTemplate(
    templateId: string
  ): Promise<void> {
    if (
      hostedCollectionRepository.hosted
    ) {
      await hostedCollectionRepository.delete(
        TEMPLATES_COLLECTION,
        templateId
      );

      return;
    }

    const templates =
      await this.loadTemplates();

    localStorageService.set(
      TEMPLATES_KEY,
      templates.filter(
        (template) =>
          template.instanceId !==
          templateId
      )
    );
  }
}

export const sceneTemplateRepository =
  new SceneTemplateRepository();