import type {
  Project,
} from '../models/Project';

import {
  localStorageService,
} from '../storage/LocalStorageService';

import {
  hostedCollectionRepository,
} from '../host/HostedCollectionRepository';

const PROJECTS_KEY =
  'projects';

const PROJECTS_COLLECTION =
  'projects';

export class ProjectRepository {
  async loadProjects(): Promise<Project[]> {
    if (
      hostedCollectionRepository.hosted
    ) {
      const projects =
        await hostedCollectionRepository
          .loadAll<Project>(
            PROJECTS_COLLECTION
          );

      return Array.isArray(projects)
        ? projects
        : [];
    }

    const projects =
      localStorageService.get<Project[]>(
        PROJECTS_KEY,
        []
      );

    return Array.isArray(projects)
      ? projects
      : [];
  }

  async loadProject(projectId: string): Promise<Project | null> {
  if (hostedCollectionRepository.hosted) {
    return hostedCollectionRepository.loadOne<Project>(
      PROJECTS_COLLECTION,
      projectId
    );
  }

  const projects = await this.loadProjects();

  return projects.find((project) => project.id === projectId) ?? null;
}

  async saveProject(
    project: Project
  ): Promise<Project[]> {
    if (
      hostedCollectionRepository.hosted
    ) {
      await hostedCollectionRepository.save(
        PROJECTS_COLLECTION,
        project.id,
        project
      );

      return this.loadProjects();
    }

    const projects =
      await this.loadProjects();

    const exists =
      projects.some(
        (candidate) =>
          candidate.id === project.id
      );

    const updatedProjects =
      exists
        ? projects.map(
            (candidate) =>
              candidate.id === project.id
                ? project
                : candidate
          )
        : [
            ...projects,
            project,
          ];

    localStorageService.set(
      PROJECTS_KEY,
      updatedProjects
    );

    return updatedProjects;
  }

  async deleteProject(
    projectId: string
  ): Promise<Project[]> {
    if (
      hostedCollectionRepository.hosted
    ) {
      await hostedCollectionRepository.delete(
        PROJECTS_COLLECTION,
        projectId
      );

      return this.loadProjects();
    }

    const projects =
      await this.loadProjects();

    const updatedProjects =
      projects.filter(
        (project) =>
          project.id !== projectId
      );

    localStorageService.set(
      PROJECTS_KEY,
      updatedProjects
    );

    return updatedProjects;
  }
}

export const projectRepository =
  new ProjectRepository();